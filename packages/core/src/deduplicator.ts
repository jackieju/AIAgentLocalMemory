import type {
  MemoryNode,
  NodeType,
  StorageProvider,
  Synapse,
} from "./interfaces.ts";

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s\p{P}]+/u)
      .filter((w) => w.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const w of a) if (b.has(w)) intersect++;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

export interface DeduplicateRunOptions {
  types?: NodeType[];
  batchSize?: number;
}

export class Deduplicator {
  constructor(
    private readonly storage: StorageProvider,
    private readonly similarityThreshold: number = 0.8,
  ) {}

  async findDuplicates(
    content: string,
    type?: NodeType,
  ): Promise<Array<{ node: MemoryNode; similarity: number }>> {
    const queryTokens = tokenize(content);
    if (queryTokens.size === 0) return [];

    const candidates = await this.storage.search(content, 30);
    const results: Array<{ node: MemoryNode; similarity: number }> = [];

    for (const node of candidates) {
      if (type && node.type !== type) continue;
      if (node.content === content && queryTokens.size === 0) continue;

      const sim = jaccard(queryTokens, tokenize(node.content));
      if (sim >= this.similarityThreshold) {
        results.push({ node, similarity: sim });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results;
  }

  async merge(keepId: string, removeId: string): Promise<MemoryNode> {
    if (keepId === removeId) {
      const existing = await this.storage.getNode(keepId);
      if (!existing) throw new Error(`Node not found: ${keepId}`);
      return existing;
    }

    const [keep, remove] = await Promise.all([
      this.storage.getNode(keepId),
      this.storage.getNode(removeId),
    ]);
    if (!keep) throw new Error(`Node not found: ${keepId}`);
    if (!remove) throw new Error(`Node not found: ${removeId}`);

    let survivor = keep;
    let casualty = remove;
    if (remove.content.length > keep.content.length) {
      survivor = remove;
      casualty = keep;
    }

    const mergedAccessCount = survivor.accessCount + casualty.accessCount;
    const mergedStrength = Math.max(survivor.strength, casualty.strength);
    const mergedImportance = Math.max(survivor.importance, casualty.importance);
    const mergedLastAccessed = Math.max(
      survivor.lastAccessed,
      casualty.lastAccessed,
    );

    await this.storage.updateNode(survivor.id, {
      accessCount: mergedAccessCount,
      strength: mergedStrength,
      importance: mergedImportance,
      lastAccessed: mergedLastAccessed,
    });

    const casualtyEdges = await this.storage.getEdges(casualty.id, "both");
    const survivorEdges = await this.storage.getEdges(survivor.id, "both");

    const survivorEdgeKey = (e: Synapse) =>
      `${e.src}|${e.dst}|${e.type}`;
    const survivorEdgeMap = new Map<string, Synapse>();
    for (const e of survivorEdges) {
      survivorEdgeMap.set(survivorEdgeKey(e), e);
    }

    for (const edge of casualtyEdges) {
      const newSrc = edge.src === casualty.id ? survivor.id : edge.src;
      const newDst = edge.dst === casualty.id ? survivor.id : edge.dst;

      await this.storage.deleteEdge(edge.src, edge.dst, edge.type);

      if (newSrc === newDst) continue;

      const existingKey = `${newSrc}|${newDst}|${edge.type}`;
      const existing = survivorEdgeMap.get(existingKey);

      if (existing) {
        const strengthened = 1 - (1 - existing.weight) * (1 - edge.weight);
        const merged: Synapse = {
          src: existing.src,
          dst: existing.dst,
          type: existing.type,
          weight: Math.min(1, strengthened),
          lastCoactivated: Math.max(
            existing.lastCoactivated,
            edge.lastCoactivated,
          ),
          coactivationCount:
            existing.coactivationCount + edge.coactivationCount,
        };
        await this.storage.updateEdge(merged.src, merged.dst, merged.type, {
          weight: merged.weight,
          lastCoactivated: merged.lastCoactivated,
          coactivationCount: merged.coactivationCount,
        });
        survivorEdgeMap.set(existingKey, merged);
      } else {
        const redirected: Synapse = {
          src: newSrc,
          dst: newDst,
          type: edge.type,
          weight: edge.weight,
          lastCoactivated: edge.lastCoactivated,
          coactivationCount: edge.coactivationCount,
        };
        await this.storage.putEdge(redirected);
        survivorEdgeMap.set(existingKey, redirected);
      }
    }

    await this.storage.deleteNode(casualty.id);

    const refreshed = await this.storage.getNode(survivor.id);
    return refreshed ?? survivor;
  }

  async run(options: DeduplicateRunOptions = {}): Promise<{ merged: number }> {
    const types: NodeType[] = options.types ?? [
      "concept",
      "assertion",
      "definition",
      "fact",
    ];
    const batchSize = options.batchSize ?? 200;

    const nodes = await this.storage.queryNodes({
      type: types,
      limit: batchSize,
    });

    const removed = new Set<string>();
    let mergedCount = 0;

    const tokensById = new Map<string, Set<string>>();
    for (const node of nodes) {
      tokensById.set(node.id, tokenize(node.content));
    }

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      if (removed.has(a.id)) continue;
      const aTokens = tokensById.get(a.id);
      if (!aTokens || aTokens.size === 0) continue;

      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        if (removed.has(b.id)) continue;
        if (a.type !== b.type) continue;

        const bTokens = tokensById.get(b.id);
        if (!bTokens || bTokens.size === 0) continue;

        const sim = jaccard(aTokens, bTokens);
        if (sim < this.similarityThreshold) continue;

        const keepId =
          a.content.length >= b.content.length ? a.id : b.id;
        const removeId = keepId === a.id ? b.id : a.id;

        await this.merge(keepId, removeId);
        removed.add(removeId);
        mergedCount++;

        if (removeId === a.id) break;
      }
    }

    return { merged: mergedCount };
  }
}
