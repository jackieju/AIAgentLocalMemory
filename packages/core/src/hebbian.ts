import type { Synapse, StorageProvider } from "./interfaces.ts";

export interface HebbianConfig {
  learningRate?: number;
  decayRate?: number;
  pruneThreshold?: number;
  pruneMinAge?: number;
  pruneMinCoactivations?: number;
}

const MS_PER_DAY = 86_400_000;

export class HebbianLearning {
  private readonly learningRate: number;
  private readonly decayRate: number;
  private readonly pruneThreshold: number;
  private readonly pruneMinAge: number;
  private readonly pruneMinCoactivations: number;

  constructor(config: HebbianConfig = {}) {
    this.learningRate = config.learningRate ?? 0.1;
    this.decayRate = config.decayRate ?? 0.005;
    this.pruneThreshold = config.pruneThreshold ?? 0.01;
    this.pruneMinAge = config.pruneMinAge ?? 30;
    this.pruneMinCoactivations = config.pruneMinCoactivations ?? 3;
  }

  strengthen(synapse: Synapse): Synapse {
    // Asymptotic strengthening: Δw = η × (1 - w)
    const delta = this.learningRate * (1 - synapse.weight);
    return {
      ...synapse,
      weight: Math.min(1, synapse.weight + delta),
      lastCoactivated: Date.now(),
      coactivationCount: synapse.coactivationCount + 1,
    };
  }

  async coactivate(storage: StorageProvider, nodeIds: string[]): Promise<void> {
    if (nodeIds.length < 2) return;

    const now = Date.now();
    const idSet = new Set(nodeIds);
    const edges = await storage.getEdgesBatch(nodeIds, "both");

    const seen = new Set<string>();
    for (const edge of edges) {
      if (!idSet.has(edge.src) || !idSet.has(edge.dst)) continue;
      const key = `${edge.src}|${edge.dst}|${edge.type}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Asymptotic strengthening: Δw = η × (1 - w)
      const delta = this.learningRate * (1 - edge.weight);
      const newWeight = Math.min(1, edge.weight + delta);

      await storage.updateEdge(edge.src, edge.dst, edge.type, {
        weight: newWeight,
        lastCoactivated: now,
        coactivationCount: edge.coactivationCount + 1,
      });
    }
  }

  async decayAll(
    storage: StorageProvider,
  ): Promise<{ decayed: number; pruned: number }> {
    const edges = await storage.getAllEdges();
    const now = Date.now();
    let decayed = 0;
    let pruned = 0;

    for (const edge of edges) {
      const ageDays = (now - edge.lastCoactivated) / MS_PER_DAY;
      if (ageDays <= 0) continue;

      // Exponential decay: w(t) = w₀ × exp(-λ × Δt_days)
      const newWeight = edge.weight * Math.exp(-this.decayRate * ageDays);

      const shouldPrune =
        newWeight < this.pruneThreshold &&
        edge.coactivationCount < this.pruneMinCoactivations &&
        ageDays > this.pruneMinAge;

      if (shouldPrune) {
        await storage.deleteEdge(edge.src, edge.dst, edge.type);
        pruned++;
      } else {
        await storage.updateEdge(edge.src, edge.dst, edge.type, {
          weight: newWeight,
        });
        decayed++;
      }
    }

    return { decayed, pruned };
  }
}
