import type {
  EngineConfig,
  EngineStats,
  INeuralContextEngine,
  LLMProvider,
  EmbeddingProvider,
  MemoryNode,
  NodeType,
  RecallOptions,
  RecallResult,
  SessionData,
  StorageProvider,
} from "./interfaces.ts";
import { NeuralGraph } from "./graph.ts";
import { HebbianLearning } from "./hebbian.ts";
import { WorkingMemory } from "./working-memory.ts";
import { SessionAbstractor } from "./abstraction.ts";
import { LightweightLinker } from "./lightweight-linker.ts";
import { EmbeddingLinker } from "./embedding-linker.ts";
import { LLMExtractor } from "./llm-extractor.ts";
import { EdgeWeightPredictor } from "./edge-predictor.ts";
import type { RecallIterator } from "./recall-iterator.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface ResolvedConfig {
  storage: StorageProvider;
  llm?: LLMProvider;
  embedding?: EmbeddingProvider;
  learningRate: number;
  decayRate: number;
  pruneThreshold: number;
  pruneMinAge: number;
  pruneMinCoactivations: number;
  maxHops: number;
  hopDecay: number;
  activationThreshold: number;
  maxEdgesPerNode: number;
  workingMemorySize: number;
  projectId: string;
  episodesDir?: string;
}

const IMPORTANCE: Record<NodeType, number> = {
  concept: 0.7,
  assertion: 0.8,
  definition: 0.8,
  episode: 0.5,
  filler: 0.2,
  meta: 0.9,
  fact: 0.9,
};

const HUB_EDGE_THRESHOLD = 6;
const KEYWORD_MATCH_RATIO = 0.25;
const SEARCH_FALLBACK_LIMIT = 30;
const DEFAULT_MAX_RESULTS = 20;
const FTS_WEIGHT = 0.75;
const ACTIVATION_WEIGHT = 0.25;
const SPREAD_SEED_LIMIT = 5;

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s\p{P}]+/u)
      .filter((w) => w.length > 0),
  );
}

export class NeuralContextEngine implements INeuralContextEngine {
  private config!: ResolvedConfig;
  private graph!: NeuralGraph;
  private hebbian!: HebbianLearning;
  private workingMemory!: WorkingMemory;
  private abstractor: SessionAbstractor | null = null;
  private lightweightLinker!: LightweightLinker;
  private embeddingLinker: EmbeddingLinker | null = null;
  private llmExtractor: LLMExtractor | null = null;
  private edgePredictor!: EdgeWeightPredictor;
  private nodeCache = new Map<string, MemoryNode>();

  async init(config: EngineConfig): Promise<void> {
    this.config = {
      storage: config.storage,
      llm: config.llm,
      embedding: config.embedding,
      learningRate: config.learningRate ?? 0.1,
      decayRate: config.decayRate ?? 0.005,
      pruneThreshold: config.pruneThreshold ?? 0.01,
      pruneMinAge: config.pruneMinAge ?? 30,
      pruneMinCoactivations: config.pruneMinCoactivations ?? 3,
      maxHops: config.maxHops ?? 3,
      hopDecay: config.hopDecay ?? 0.5,
      activationThreshold: config.activationThreshold ?? 0.08,
      maxEdgesPerNode: config.maxEdgesPerNode ?? 8,
      workingMemorySize: config.workingMemorySize ?? 1000,
      projectId: config.projectId ?? "default",
      episodesDir: config.episodesDir,
    };

    await this.config.storage.open(this.config.projectId);

    if (this.config.episodesDir) {
      mkdirSync(this.config.episodesDir, { recursive: true });
    }

    this.graph = new NeuralGraph(this.config.storage, this.config.maxEdgesPerNode);
    this.hebbian = new HebbianLearning({
      learningRate: this.config.learningRate,
      decayRate: this.config.decayRate,
      pruneThreshold: this.config.pruneThreshold,
      pruneMinAge: this.config.pruneMinAge,
      pruneMinCoactivations: this.config.pruneMinCoactivations,
    });
    this.workingMemory = new WorkingMemory(this.config.workingMemorySize);
    this.abstractor = this.config.llm ? new SessionAbstractor(this.config.llm) : null;
    this.lightweightLinker = new LightweightLinker(this.config.storage, this.config.maxEdgesPerNode);
    this.edgePredictor = new EdgeWeightPredictor();
    this.llmExtractor = this.config.llm ? new LLMExtractor(this.config.llm) : null;
    this.embeddingLinker = this.config.embedding
      ? new EmbeddingLinker(this.config.storage, this.config.embedding, {
          maxEdgesPerNode: this.config.maxEdgesPerNode,
        })
      : null;
  }

  async shutdown(): Promise<void> {
    this.workingMemory.serialize();
    await this.config.storage.close();
  }

  async ingest(session: SessionData): Promise<void> {
    const now = Date.now();

    if (this.config.episodesDir) {
      const filename = `${session.id || crypto.randomUUID()}.json`;
      const filepath = join(this.config.episodesDir, filename);
      try {
        writeFileSync(filepath, JSON.stringify(session, null, 2));
      } catch { /* best-effort, don't block ingest */ }
    }

    if (!this.abstractor) {
      const text = session.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n");
      const episode: MemoryNode = {
        id: crypto.randomUUID(),
        type: "episode",
        content: text.slice(0, 10_000),
        importance: IMPORTANCE.episode,
        strength: IMPORTANCE.episode,
        accessCount: 0,
        lastAccessed: now,
        createdAt: now,
        sourceSession: session.id,
      };
      await this.graph.addNode(episode);
      this.nodeCache.set(episode.id, episode);
      this.workingMemory.access(episode.id);

      await this.lightweightLinker.linkToExisting(episode);
      if (this.embeddingLinker) {
        try { await this.embeddingLinker.linkNode(episode); } catch {}
      }
      return;
    }

    const { nodes, edges } = await this.abstractor.abstract(session);

    for (const node of nodes) {
      await this.graph.addNode(node);
      this.nodeCache.set(node.id, node);
    }
    for (const edge of edges) {
      const predictedWeight = this.edgePredictor.predict(
        this.nodeCache.get(edge.src) ?? { id: edge.src, type: "concept", content: "", importance: 0.5, strength: 0.5, accessCount: 0, lastAccessed: now, createdAt: now },
        this.nodeCache.get(edge.dst) ?? { id: edge.dst, type: "concept", content: "", importance: 0.5, strength: 0.5, accessCount: 0, lastAccessed: now, createdAt: now },
      );
      await this.graph.addEdge({ ...edge, weight: Math.max(edge.weight, predictedWeight) });
    }
    for (const node of nodes) {
      if (node.type === "concept") this.workingMemory.access(node.id);
      await this.lightweightLinker.linkToExisting(node);
      if (this.embeddingLinker) {
        try { await this.embeddingLinker.linkNode(node); } catch {}
      }
    }
  }

  async remember(
    content: string,
    type: NodeType,
    options?: { importance?: number; metadata?: Record<string, unknown> },
  ): Promise<MemoryNode> {
    const now = Date.now();
    const importance = options?.importance ?? IMPORTANCE[type];
    const node: MemoryNode = {
      id: crypto.randomUUID(),
      type,
      content,
      importance,
      strength: importance,
      accessCount: 0,
      lastAccessed: now,
      createdAt: now,
      metadata: options?.metadata,
    };
    await this.graph.addNode(node);
    this.nodeCache.set(node.id, node);
    this.workingMemory.access(node.id);

    await this.lightweightLinker.linkToExisting(node);
    if (this.embeddingLinker) {
      try { await this.embeddingLinker.linkNode(node); } catch {}
    }

    return node;
  }

  async recall(query: string, options: RecallOptions = {}): Promise<RecallResult[]> {
    const queryTokens = [...tokenize(query)];
    if (queryTokens.length === 0) return [];

    const ftsScores = new Map<string, number>();
    let ftsNodes: MemoryNode[] = [];

    if (this.config.storage.searchWithScores) {
      const scored = await this.config.storage.searchWithScores(query, SEARCH_FALLBACK_LIMIT);
      for (const { node, score } of scored) {
        ftsScores.set(node.id, score);
        ftsNodes.push(node);
      }
    } else {
      ftsNodes = await this.config.storage.search(query, SEARCH_FALLBACK_LIMIT);
      for (let i = 0; i < ftsNodes.length; i++) {
        ftsScores.set(ftsNodes[i].id, 1 - i / Math.max(ftsNodes.length, 1));
      }
    }

    const queryTokensLower = new Set(queryTokens.map((t) => t.toLowerCase()));
    for (const node of ftsNodes) {
      const nodeTokens = tokenize(node.content);
      let overlap = 0;
      for (const t of queryTokensLower) if (nodeTokens.has(t)) overlap++;
      const overlapScore = overlap / queryTokensLower.size;
      const existingFts = ftsScores.get(node.id) ?? 0;
      ftsScores.set(node.id, existingFts * 0.6 + overlapScore * 0.4);
    }

    const wmBonus = new Map<string, number>();
    const wmIds = this.workingMemory.getAll();
    if (wmIds.length > 0) {
      const wmNodes = await this.config.storage.getNodesByIds(wmIds);
      for (const node of wmNodes) {
        const nodeTokens = tokenize(node.content);
        let hits = 0;
        for (const t of queryTokens) if (nodeTokens.has(t)) hits++;
        if (hits / queryTokens.length >= KEYWORD_MATCH_RATIO) {
          wmBonus.set(node.id, 0.15);
          if (!ftsScores.has(node.id)) {
            ftsScores.set(node.id, 0.3);
            ftsNodes.push(node);
          }
        }
      }
    }

    if (ftsNodes.length === 0 && this.embeddingLinker) {
      try {
        const queryEmbedding = await this.config.embedding!.embed([query]);
        if (queryEmbedding.length > 0) {
          const allNodes = await this.config.storage.getAllNodes();
          const scored: Array<{ node: MemoryNode; sim: number }> = [];
          for (const node of allNodes) {
            const emb = node.metadata?.embedding as number[] | undefined;
            if (!emb) continue;
            let dot = 0, normA = 0, normB = 0;
            for (let i = 0; i < queryEmbedding[0].length && i < emb.length; i++) {
              dot += queryEmbedding[0][i] * emb[i];
              normA += queryEmbedding[0][i] * queryEmbedding[0][i];
              normB += emb[i] * emb[i];
            }
            const sim = Math.sqrt(normA) * Math.sqrt(normB) > 0 ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
            if (sim > 0.3) scored.push({ node, sim });
          }
          scored.sort((a, b) => b.sim - a.sim);
          for (const { node, sim } of scored.slice(0, SEARCH_FALLBACK_LIMIT)) {
            ftsScores.set(node.id, sim);
            ftsNodes.push(node);
          }
        }
      } catch {}
    }

    if (ftsNodes.length === 0) return [];

    const spreadSeeds = ftsNodes.slice(0, SPREAD_SEED_LIMIT).map((n) => ({
      nodeId: n.id,
      baseScore: ftsScores.get(n.id) ?? 0.5,
    }));

    const maxHops = options.maxHops ?? 2;
    const hopDecay = options.decayFactor ?? 0.3;
    const threshold = options.threshold ?? 0.05;

    const activations = await this.graph.spreadingActivation(spreadSeeds, {
      maxHops,
      hopDecay,
      threshold,
    });

    const activationScores = new Map<string, number>();
    let maxActivation = 0;
    for (const a of activations) {
      if (a.score > maxActivation) maxActivation = a.score;
    }
    for (const a of activations) {
      activationScores.set(a.nodeId, maxActivation > 0 ? a.score / maxActivation : 0);
    }

    const allNodeIds = new Set<string>();
    for (const id of ftsScores.keys()) allNodeIds.add(id);
    for (const a of activations) allNodeIds.add(a.nodeId);

    const hybridScores = new Map<string, number>();
    for (const id of allNodeIds) {
      const fts = ftsScores.get(id) ?? 0;
      const act = activationScores.get(id) ?? 0;
      const wm = wmBonus.get(id) ?? 0;
      hybridScores.set(id, FTS_WEIGHT * fts + ACTIVATION_WEIGHT * act + wm);
    }

    const sortedIds = [...hybridScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, options.maxResults ?? DEFAULT_MAX_RESULTS)
      .map(([id]) => id);

    const fetched = await this.config.storage.getNodesByIds(sortedIds);
    const nodeMap = new Map(fetched.map((n) => [n.id, n]));

    let results: RecallResult[] = [];
    for (const id of sortedIds) {
      const node = nodeMap.get(id);
      if (!node) continue;
      const activation = activations.find((a) => a.nodeId === id);
      results.push({
        node,
        score: hybridScores.get(id) ?? 0,
        path: activation?.path,
      });
    }

    if (options.includeTypes) {
      const inc = new Set(options.includeTypes);
      results = results.filter((r) => inc.has(r.node.type));
    }
    if (options.excludeTypes) {
      const exc = new Set(options.excludeTypes);
      results = results.filter((r) => !exc.has(r.node.type));
    }

    results = results.slice(0, options.maxResults ?? DEFAULT_MAX_RESULTS);

    const resultIds = results.map((r) => r.node.id);
    await this.hebbian.coactivate(this.config.storage, resultIds);
    for (const r of results) {
      this.workingMemory.access(r.node.id);
      this.nodeCache.set(r.node.id, r.node);
    }

    return results;
  }

  async recallIterative(query: string): Promise<RecallIterator> {
    const queryTokens = [...tokenize(query)];
    if (queryTokens.length === 0) {
      return this.graph.createRecallIterator([]);
    }

    let seedNodes: MemoryNode[] = [];

    if (this.config.storage.searchWithScores) {
      const scored = await this.config.storage.searchWithScores(query, SEARCH_FALLBACK_LIMIT);
      seedNodes = scored.map((s) => s.node);
    } else {
      seedNodes = await this.config.storage.search(query, SEARCH_FALLBACK_LIMIT);
    }

    const seeds = seedNodes.slice(0, SPREAD_SEED_LIMIT).map((n) => ({
      nodeId: n.id,
      baseScore: n.importance,
    }));

    return this.graph.createRecallIterator(seeds, {
      hopDecay: 0.3,
      threshold: 0.05,
    });
  }

  async associate(nodeId: string, hops?: number): Promise<RecallResult[]> {    const seed = await this.config.storage.getNode(nodeId);
    if (!seed) return [];

    const activations = await this.graph.spreadingActivation(
      [{ nodeId, baseScore: 1 }],
      {
        maxHops: hops ?? this.config.maxHops,
        hopDecay: this.config.hopDecay,
        threshold: this.config.activationThreshold,
      },
    );

    const otherIds = activations
      .map((a) => a.nodeId)
      .filter((id) => id !== nodeId);
    if (otherIds.length === 0) return [];

    const nodes = await this.config.storage.getNodesByIds(otherIds);
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));

    const results: RecallResult[] = [];
    for (const a of activations) {
      if (a.nodeId === nodeId) continue;
      const node = nodeMap.get(a.nodeId);
      if (!node) continue;
      results.push({ node, score: a.score, path: a.path });
    }
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  getWorkingMemory(): MemoryNode[] {
    const ids = this.workingMemory.getAll();
    const out: MemoryNode[] = [];
    for (const id of ids) {
      const node = this.nodeCache.get(id);
      if (node) out.push(node);
    }
    return out;
  }

  async decay(): Promise<{ pruned: number; decayed: number }> {
    const result = await this.hebbian.decayAll(this.config.storage);
    return { pruned: result.pruned, decayed: result.decayed };
  }

  async consolidate(): Promise<{ hubs: number; merged: number }> {
    const allNodes = await this.config.storage.getAllNodes();
    let hubs = 0;
    for (const node of allNodes) {
      const edges = await this.config.storage.getEdges(node.id, "both");
      if (edges.length >= HUB_EDGE_THRESHOLD) hubs++;
    }
    return { hubs, merged: 0 };
  }

  async getStats(): Promise<EngineStats> {
    const nodeCount = await this.config.storage.getNodeCount();
    const allEdges = await this.config.storage.getAllEdges();
    const allNodes = await this.config.storage.getAllNodes();

    const nodesByType: Record<NodeType, number> = {
      concept: 0,
      assertion: 0,
      definition: 0,
      filler: 0,
      episode: 0,
      meta: 0,
      fact: 0,
    };
    for (const node of allNodes) nodesByType[node.type]++;

    return {
      nodeCount,
      edgeCount: allEdges.length,
      workingMemorySize: this.workingMemory.size(),
      nodesByType,
    };
  }
}
