import { join } from "node:path";
import { statSync } from "node:fs";
import {
  LightweightLinker,
  NeuralContextEngine,
} from "../../packages/core/src/index.ts";
import type {
  MemoryNode,
  NodeFilter,
  StorageProvider,
  Synapse,
  SynapseType,
} from "../../packages/core/src/interfaces.ts";
import { SqliteStorageProvider } from "../../packages/storage-sqlite/src/index.ts";
import type { AdapterStats, MemoryAdapter } from "./types.ts";

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "should",
  "could", "may", "might", "must", "shall", "can", "of", "to", "in",
  "on", "at", "by", "for", "with", "about", "from", "as", "and", "or",
  "but", "not", "no", "so", "if", "then", "this", "that", "these",
  "those", "it", "its", "you", "we", "they", "our",
]);

function tokens(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[\s\p{P}]+/u)
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
    ),
  );
}

class LooseSearchStorage implements StorageProvider {
  constructor(private readonly inner: StorageProvider) {}

  open(projectId: string): Promise<void> {
    return this.inner.open(projectId);
  }
  close(): Promise<void> {
    return this.inner.close();
  }
  getNode(id: string): Promise<MemoryNode | null> {
    return this.inner.getNode(id);
  }
  putNode(node: MemoryNode): Promise<void> {
    return this.inner.putNode(node);
  }
  updateNode(
    id: string,
    updates: Partial<Omit<MemoryNode, "id">>,
  ): Promise<void> {
    return this.inner.updateNode(id, updates);
  }
  deleteNode(id: string): Promise<void> {
    return this.inner.deleteNode(id);
  }
  getNodesByIds(ids: string[]): Promise<MemoryNode[]> {
    return this.inner.getNodesByIds(ids);
  }
  queryNodes(filter: NodeFilter): Promise<MemoryNode[]> {
    return this.inner.queryNodes(filter);
  }
  getEdges(
    nodeId: string,
    direction?: "in" | "out" | "both",
  ): Promise<Synapse[]> {
    return this.inner.getEdges(nodeId, direction);
  }
  putEdge(edge: Synapse): Promise<void> {
    return this.inner.putEdge(edge);
  }
  updateEdge(
    src: string,
    dst: string,
    type: SynapseType,
    updates: Partial<Omit<Synapse, "src" | "dst" | "type">>,
  ): Promise<void> {
    return this.inner.updateEdge(src, dst, type, updates);
  }
  deleteEdge(src: string, dst: string, type: SynapseType): Promise<void> {
    return this.inner.deleteEdge(src, dst, type);
  }
  getEdgesBatch(
    nodeIds: string[],
    direction?: "in" | "out" | "both",
  ): Promise<Synapse[]> {
    return this.inner.getEdgesBatch(nodeIds, direction);
  }
  getAllNodes(): Promise<MemoryNode[]> {
    return this.inner.getAllNodes();
  }
  getAllEdges(): Promise<Synapse[]> {
    return this.inner.getAllEdges();
  }
  getNodeCount(): Promise<number> {
    return this.inner.getNodeCount();
  }

  async search(query: string, limit = 30): Promise<MemoryNode[]> {
    const queryTokens = tokens(query);
    if (queryTokens.length === 0) return [];

    const scores = new Map<string, { node: MemoryNode; score: number }>();
    const perTokenLimit = Math.max(limit, 30);

    for (const tok of queryTokens) {
      const hits = await this.inner.search(tok, perTokenLimit);
      for (const node of hits) {
        const existing = scores.get(node.id);
        if (existing) existing.score += 1;
        else scores.set(node.id, { node, score: 1 });
      }
    }

    return Array.from(scores.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.node);
  }
}

export class AIAgentLocalAdapter implements MemoryAdapter {
  name = "AIAgentLocalMemory";
  private storage: SqliteStorageProvider | null = null;
  private linkerStorage: LooseSearchStorage | null = null;
  private engine: NeuralContextEngine | null = null;
  private linker: LightweightLinker | null = null;
  private dbPath = "";
  private datasetIdToNodeId = new Map<string, string>();
  private nodeIdToDatasetId = new Map<string, string>();
  private storedNodeIds: string[] = [];
  private edgesBuilt = 0;

  async init(storageDir: string): Promise<void> {
    this.dbPath = join(storageDir, "graph.db");
    this.storage = new SqliteStorageProvider({ storagePath: this.dbPath });
    this.engine = new NeuralContextEngine();
    await this.engine.init({
      storage: this.storage,
      projectId: "benchmark",
      activationThreshold: 0.02,
      maxHops: 3,
      hopDecay: 0.6,
    });
    this.linkerStorage = new LooseSearchStorage(this.storage);
    this.linker = new LightweightLinker(this.linkerStorage, 12);
  }

  async remember(
    id: string,
    content: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.engine) throw new Error("not initialized");
    const node = await this.engine.remember(content, "fact", {
      metadata: { ...(meta ?? {}), datasetId: id },
    });
    this.datasetIdToNodeId.set(id, node.id);
    this.nodeIdToDatasetId.set(node.id, id);
    this.storedNodeIds.push(node.id);
  }

  async finalizeIngest(): Promise<void> {
    if (!this.storage || !this.linker) throw new Error("not initialized");
    let total = 0;
    for (const nodeId of this.storedNodeIds) {
      const node = await this.storage.getNode(nodeId);
      if (!node) continue;
      const created = await this.linker.linkToExisting(node);
      total += created.length;
    }
    this.edgesBuilt = total;
  }

  async warmup(queries: string[]): Promise<void> {
    if (!this.engine) throw new Error("not initialized");
    for (const q of queries) {
      await this.engine.recall(q, { maxResults: 10 });
    }
  }

  async recall(
    query: string,
    k: number,
  ): Promise<Array<{ id: string; score: number; content: string }>> {
    if (!this.engine) throw new Error("not initialized");
    const results = await this.engine.recall(query, { maxResults: k });
    const hits: Array<{ id: string; score: number; content: string }> = [];
    for (const r of results) {
      const datasetId =
        this.nodeIdToDatasetId.get(r.node.id) ??
        (r.node.metadata?.datasetId as string | undefined) ??
        r.node.id;
      hits.push({ id: datasetId, score: r.score, content: r.node.content });
    }
    return hits;
  }

  async stats(): Promise<AdapterStats> {
    if (!this.engine) throw new Error("not initialized");
    const s = await this.engine.getStats();
    let size = 0;
    try {
      size = statSync(this.dbPath).size;
    } catch {
      size = 0;
    }
    return {
      nodeCount: s.nodeCount,
      edgeCount: s.edgeCount,
      dbSizeBytes: size,
    };
  }

  async close(): Promise<void> {
    if (this.engine) await this.engine.shutdown();
    this.engine = null;
    this.storage = null;
    this.linker = null;
    this.linkerStorage = null;
  }
}
