import type { MemoryNode, Synapse, StorageProvider } from "./interfaces.ts";
import { RecallIterator, type RecallIteratorOptions } from "./recall-iterator.ts";

export interface ActivationResult {
  nodeId: string;
  score: number;
  path: string[];
}

export interface SpreadingActivationOptions {
  maxHops: number;
  hopDecay: number;
  threshold: number;
}

export interface ActivationSeed {
  nodeId: string;
  baseScore: number;
}

export class NeuralGraph {
  constructor(
    private readonly storage: StorageProvider,
    private readonly maxEdgesPerNode: number = 8,
  ) {}

  async addNode(node: MemoryNode): Promise<void> {
    await this.storage.putNode(node);
  }

  async addEdge(synapse: Synapse): Promise<void> {
    const outgoing = (await this.storage.getEdges(synapse.src, "out")).filter(
      (e) => e.src === synapse.src,
    );

    const duplicate = outgoing.find(
      (e) => e.dst === synapse.dst && e.type === synapse.type,
    );
    if (duplicate) {
      await this.storage.updateEdge(synapse.src, synapse.dst, synapse.type, {
        weight: synapse.weight,
        lastCoactivated: synapse.lastCoactivated,
        coactivationCount: synapse.coactivationCount,
      });
      return;
    }

    if (outgoing.length >= this.maxEdgesPerNode) {
      const weakest = outgoing.reduce((a, b) => (a.weight <= b.weight ? a : b));
      if (weakest.weight >= synapse.weight) {
        return;
      }
      await this.storage.deleteEdge(weakest.src, weakest.dst, weakest.type);
    }

    await this.storage.putEdge(synapse);
  }

  async getNeighbors(
    nodeId: string,
    direction: "in" | "out" | "both" = "both",
  ): Promise<MemoryNode[]> {
    const edges = await this.storage.getEdges(nodeId, direction);
    const neighborIds = new Set<string>();
    for (const e of edges) {
      if (e.src === nodeId) neighborIds.add(e.dst);
      if (e.dst === nodeId) neighborIds.add(e.src);
    }
    neighborIds.delete(nodeId);
    if (neighborIds.size === 0) return [];
    return this.storage.getNodesByIds([...neighborIds]);
  }

  async spreadingActivation(
    seeds: ActivationSeed[],
    options: SpreadingActivationOptions,
  ): Promise<ActivationResult[]> {
    const { maxHops, hopDecay, threshold } = options;

    const activation = new Map<string, number>();
    const paths = new Map<string, string[]>();
    const visited = new Set<string>();

    let frontier = new Set<string>();
    for (const seed of seeds) {
      const prev = activation.get(seed.nodeId) ?? 0;
      activation.set(seed.nodeId, prev + seed.baseScore);
      if (!paths.has(seed.nodeId)) paths.set(seed.nodeId, [seed.nodeId]);
      frontier.add(seed.nodeId);
    }

    for (let hop = 0; hop < maxHops; hop++) {
      if (frontier.size === 0) break;
      if (frontier.size > 20) break;

      const frontierIds = [...frontier];
      const edges = await this.storage.getEdgesBatch(frontierIds, "both");

      // Per-hop attenuation: multiplier = hopDecay ^ (hop + 1)
      const hopMultiplier = Math.pow(hopDecay, hop + 1);
      const nextFrontier = new Set<string>();

      for (const edge of edges) {
        let sourceId: string;
        let targetId: string;
        if (frontier.has(edge.src)) {
          sourceId = edge.src;
          targetId = edge.dst;
        } else if (frontier.has(edge.dst)) {
          sourceId = edge.dst;
          targetId = edge.src;
        } else {
          continue;
        }

        const currentScore = activation.get(sourceId) ?? 0;
        // transmitted = currentScore × edge.weight × hopMultiplier
        const transmitted = currentScore * edge.weight * hopMultiplier;
        if (transmitted < threshold) continue;

        const prev = activation.get(targetId) ?? 0;
        activation.set(targetId, prev + transmitted);

        if (!paths.has(targetId)) {
          const sourcePath = paths.get(sourceId) ?? [sourceId];
          paths.set(targetId, [...sourcePath, targetId]);
        }

        if (!visited.has(targetId)) {
          nextFrontier.add(targetId);
        }
      }

      for (const id of frontier) visited.add(id);
      for (const id of visited) nextFrontier.delete(id);
      frontier = nextFrontier;
    }

    const results: ActivationResult[] = [];
    for (const [nodeId, score] of activation) {
      results.push({
        nodeId,
        score,
        path: paths.get(nodeId) ?? [nodeId],
      });
    }
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  createRecallIterator(
    seeds: ActivationSeed[],
    options?: RecallIteratorOptions,
  ): RecallIterator {
    return new RecallIterator(this.storage, seeds, options);
  }
}
