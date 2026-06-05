import type {
  EngineConfig,
  EngineStats,
  INeuralContextEngine,
  LLMProvider,
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

interface ResolvedConfig {
  storage: StorageProvider;
  llm?: LLMProvider;
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
}

const IMPORTANCE: Record<NodeType, number> = {
  concept: 0.7,
  assertion: 0.8,
  definition: 0.8,
  episode: 0.5,
  filler: 0.2,
  meta: 0.9,
};

const HUB_EDGE_THRESHOLD = 6;
const KEYWORD_MATCH_RATIO = 0.5;
const SEARCH_FALLBACK_LIMIT = 10;
const DEFAULT_MAX_RESULTS = 20;

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
  private nodeCache = new Map<string, MemoryNode>();

  async init(config: EngineConfig): Promise<void> {
    this.config = {
      storage: config.storage,
      llm: config.llm,
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
    };

    await this.config.storage.open(this.config.projectId);

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
  }

  async shutdown(): Promise<void> {
    this.workingMemory.serialize();
    await this.config.storage.close();
  }

  async ingest(session: SessionData): Promise<void> {
    const now = Date.now();

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
      return;
    }

    const { nodes, edges } = await this.abstractor.abstract(session);

    for (const node of nodes) {
      await this.graph.addNode(node);
      this.nodeCache.set(node.id, node);
    }
    for (const edge of edges) {
      await this.graph.addEdge(edge);
    }
    for (const node of nodes) {
      if (node.type === "concept") this.workingMemory.access(node.id);
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
    return node;
  }

  async recall(query: string, options: RecallOptions = {}): Promise<RecallResult[]> {
    const queryTokens = [...tokenize(query)];
    if (queryTokens.length === 0) return [];

    let seedNodes: MemoryNode[] = [];

    const wmIds = this.workingMemory.getAll();
    if (wmIds.length > 0) {
      const wmNodes = await this.config.storage.getNodesByIds(wmIds);
      const matches: MemoryNode[] = [];
      for (const node of wmNodes) {
        const nodeTokens = tokenize(node.content);
        let hits = 0;
        for (const t of queryTokens) if (nodeTokens.has(t)) hits++;
        if (hits / queryTokens.length >= KEYWORD_MATCH_RATIO) matches.push(node);
      }
      seedNodes = matches;
    }

    if (seedNodes.length === 0) {
      seedNodes = await this.config.storage.search(query, SEARCH_FALLBACK_LIMIT);
    }

    if (seedNodes.length === 0) return [];

    const seeds = seedNodes.map((n) => ({
      nodeId: n.id,
      baseScore: n.importance,
    }));

    const activations = await this.graph.spreadingActivation(seeds, {
      maxHops: options.maxHops ?? this.config.maxHops,
      hopDecay: options.decayFactor ?? this.config.hopDecay,
      threshold: options.threshold ?? this.config.activationThreshold,
    });

    if (activations.length === 0) return [];

    const ids = activations.map((a) => a.nodeId);
    const fetched = await this.config.storage.getNodesByIds(ids);
    const nodeMap = new Map(fetched.map((n) => [n.id, n]));

    let results: RecallResult[] = [];
    for (const a of activations) {
      const node = nodeMap.get(a.nodeId);
      if (!node) continue;
      results.push({ node, score: a.score, path: a.path });
    }

    if (options.includeTypes) {
      const inc = new Set(options.includeTypes);
      results = results.filter((r) => inc.has(r.node.type));
    }
    if (options.excludeTypes) {
      const exc = new Set(options.excludeTypes);
      results = results.filter((r) => !exc.has(r.node.type));
    }

    results.sort((a, b) => b.score - a.score);
    results = results.slice(0, options.maxResults ?? DEFAULT_MAX_RESULTS);

    const resultIds = results.map((r) => r.node.id);
    await this.hebbian.coactivate(this.config.storage, resultIds);
    for (const r of results) {
      this.workingMemory.access(r.node.id);
      this.nodeCache.set(r.node.id, r.node);
    }

    return results;
  }

  async associate(nodeId: string, hops?: number): Promise<RecallResult[]> {
    const seed = await this.config.storage.getNode(nodeId);
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
