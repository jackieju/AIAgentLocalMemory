import type {
  EmbeddingProvider,
  MemoryNode,
  StorageProvider,
  Synapse,
} from "./interfaces.ts";

const DEFAULT_SIMILARITY_THRESHOLD = 0.7;
const DEFAULT_MAX_EDGES_PER_NODE = 8;
const DEFAULT_BATCH_SIZE = 32;
const FTS_CANDIDATE_LIMIT = 50;

export interface EmbeddingLinkerOptions {
  similarityThreshold?: number;
  maxEdgesPerNode?: number;
  batchSize?: number;
}

export interface EmbeddingRunResult {
  embedded: number;
  edgesCreated: number;
}

// cos(a, b) = (a · b) / (||a|| * ||b||)
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function getEmbedding(node: MemoryNode): number[] | undefined {
  const value = node.metadata?.embedding;
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    if (typeof item !== "number") return undefined;
  }
  return value as number[];
}

export class EmbeddingLinker {
  private readonly similarityThreshold: number;
  private readonly maxEdgesPerNode: number;
  private readonly batchSize: number;

  constructor(
    private readonly storage: StorageProvider,
    private readonly embedder: EmbeddingProvider,
    options?: EmbeddingLinkerOptions,
  ) {
    this.similarityThreshold =
      options?.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    this.maxEdgesPerNode =
      options?.maxEdgesPerNode ?? DEFAULT_MAX_EDGES_PER_NODE;
    this.batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  async linkNode(node: MemoryNode): Promise<Synapse[]> {
    let nodeVec = getEmbedding(node);
    if (!nodeVec) {
      const [vec] = await this.embedder.embed([node.content]);
      nodeVec = vec;
      await this.storage.updateNode(node.id, {
        metadata: { ...node.metadata, embedding: nodeVec },
      });
    }

    const candidates = await this.storage.search(
      node.content,
      FTS_CANDIDATE_LIMIT,
    );

    const existingEdges = await this.storage.getEdges(node.id, "both");
    const existingPeersByType = new Set<string>();
    for (const edge of existingEdges) {
      const peer = edge.src === node.id ? edge.dst : edge.src;
      existingPeersByType.add(`${edge.type}:${peer}`);
    }
    let edgeCount = existingEdges.length;

    const created: Synapse[] = [];
    const now = Date.now();

    for (const candidate of candidates) {
      if (candidate.id === node.id) continue;
      if (edgeCount >= this.maxEdgesPerNode) break;

      const candidateVec = getEmbedding(candidate);
      if (!candidateVec) continue;
      if (candidateVec.length !== nodeVec.length) continue;

      const similarity = cosineSimilarity(nodeVec, candidateVec);
      if (similarity < this.similarityThreshold) continue;

      const key = `semantic:${candidate.id}`;
      if (existingPeersByType.has(key)) continue;

      const edge: Synapse = {
        src: node.id,
        dst: candidate.id,
        type: "semantic",
        weight: similarity,
        lastCoactivated: now,
        coactivationCount: 1,
      };
      await this.storage.putEdge(edge);
      created.push(edge);
      existingPeersByType.add(key);
      edgeCount++;
    }

    return created;
  }

  async run(options?: { limit?: number }): Promise<EmbeddingRunResult> {
    const allNodes = await this.storage.getAllNodes();
    const unembedded: MemoryNode[] = [];
    for (const node of allNodes) {
      if (!getEmbedding(node)) unembedded.push(node);
    }

    const limit = options?.limit ?? unembedded.length;
    const targets = unembedded.slice(0, limit);

    let embedded = 0;
    const newlyEmbedded: MemoryNode[] = [];

    for (let i = 0; i < targets.length; i += this.batchSize) {
      const batch = targets.slice(i, i + this.batchSize);
      const vectors = await this.embedder.embed(batch.map((n) => n.content));
      for (let j = 0; j < batch.length; j++) {
        const node = batch[j];
        const vec = vectors[j];
        const updatedMetadata = { ...node.metadata, embedding: vec };
        await this.storage.updateNode(node.id, { metadata: updatedMetadata });
        newlyEmbedded.push({ ...node, metadata: updatedMetadata });
        embedded++;
      }
    }

    let edgesCreated = 0;
    for (const node of newlyEmbedded) {
      const edges = await this.linkNode(node);
      edgesCreated += edges.length;
    }

    return { embedded, edgesCreated };
  }
}
