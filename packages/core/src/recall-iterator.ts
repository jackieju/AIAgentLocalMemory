import type { StorageProvider } from "./interfaces.ts";
import type { ActivationSeed } from "./graph.ts";

export interface RecallIteratorOptions {
  hopDecay?: number;
  threshold?: number;
  maxHops?: number;
  batchSize?: number;
}

export interface IterativeActivationResult {
  nodeId: string;
  score: number;
  path: string[];
}

interface ActivationData {
  score: number;
  path: string[];
}

export class RecallIterator {
  private frontier = new Map<string, number>();
  private visited = new Set<string>();
  private allActivations = new Map<string, ActivationData>();
  private returnedNodeIds = new Set<string>();
  private currentHop = 0;
  private exhausted = false;

  private readonly hopDecay: number;
  private readonly threshold: number;
  private readonly maxHops: number;
  private readonly batchSize: number;

  constructor(
    private readonly storage: StorageProvider,
    private readonly seeds: ActivationSeed[],
    options: RecallIteratorOptions = {},
  ) {
    this.hopDecay = options.hopDecay ?? 0.5;
    this.threshold = options.threshold ?? 0.08;
    this.maxHops = options.maxHops ?? 10;
    this.batchSize = options.batchSize ?? 20;
  }

  hasNext(): boolean {
    return !this.exhausted;
  }

  async next(): Promise<IterativeActivationResult[]> {
    if (this.exhausted) return [];

    if (this.currentHop === 0) {
      for (const seed of this.seeds) {
        const prev = this.allActivations.get(seed.nodeId);
        const newScore = (prev?.score ?? 0) + seed.baseScore;
        this.allActivations.set(seed.nodeId, {
          score: newScore,
          path: prev?.path ?? [seed.nodeId],
        });
        this.frontier.set(seed.nodeId, newScore);
        this.visited.add(seed.nodeId);
      }
    } else {
      // Expand one hop from the current frontier:
      // - multiplier = hopDecay ^ currentHop attenuates the further we travel from seeds.
      // - For each frontier node, fetch its edges one node at a time (getEdges instead of
      //   getEdgesBatch) — keeps memory bounded on large graphs.
      // - For each unvisited neighbor: transmitted = frontierScore × edge.weight × multiplier.
      //   If transmitted < threshold the contribution is dropped; otherwise it accumulates
      //   into the neighbor's activation score.
      // - A neighbor's path is recorded on first arrival and never overwritten.
      // - Newly activated neighbors form the next frontier and are marked visited so future
      //   hops skip them.
      const multiplier = Math.pow(this.hopDecay, this.currentHop);
      const nextFrontier = new Map<string, number>();

      for (const [nodeId, score] of this.frontier) {
        const edges = await this.storage.getEdges(nodeId, "both");
        for (const edge of edges) {
          const neighborId = edge.src === nodeId ? edge.dst : edge.src;
          if (neighborId === nodeId) continue;
          if (this.visited.has(neighborId)) continue;

          const transmitted = score * edge.weight * multiplier;
          if (transmitted < this.threshold) continue;

          const prev = this.allActivations.get(neighborId);
          const newScore = (prev?.score ?? 0) + transmitted;
          let path = prev?.path;
          if (!path) {
            const sourcePath = this.allActivations.get(nodeId)?.path ?? [nodeId];
            path = [...sourcePath, neighborId];
          }
          this.allActivations.set(neighborId, { score: newScore, path });
          nextFrontier.set(neighborId, newScore);
        }
      }

      for (const id of nextFrontier.keys()) this.visited.add(id);
      this.frontier = nextFrontier;
    }

    this.currentHop += 1;
    if (this.frontier.size === 0 || this.currentHop > this.maxHops) {
      this.exhausted = true;
    }

    const fresh: IterativeActivationResult[] = [];
    for (const [nodeId, data] of this.allActivations) {
      if (this.returnedNodeIds.has(nodeId)) continue;
      fresh.push({ nodeId, score: data.score, path: data.path });
    }
    fresh.sort((a, b) => b.score - a.score);
    const batch = fresh.slice(0, this.batchSize);
    for (const r of batch) this.returnedNodeIds.add(r.nodeId);
    return batch;
  }

  getAllResults(): IterativeActivationResult[] {
    const results: IterativeActivationResult[] = [];
    for (const [nodeId, data] of this.allActivations) {
      results.push({ nodeId, score: data.score, path: data.path });
    }
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  reset(): void {
    this.frontier = new Map();
    this.visited = new Set();
    this.allActivations = new Map();
    this.returnedNodeIds = new Set();
    this.currentHop = 0;
    this.exhausted = false;
  }
}
