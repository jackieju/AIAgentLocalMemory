import type { StorageProvider, Synapse } from "./interfaces.ts";
import type { ActivationSeed, NeuralGraph } from "./graph.ts";

export interface LayeredSpreadOptions {
  targetResults?: number;
  maxHops?: number;
  hopDecay?: number;
  threshold?: number;
}

export interface LayeredResult {
  nodeId: string;
  score: number;
  path: string[];
  layer: "L0" | "L1" | "L2";
}

interface SpreadOptions {
  maxHops: number;
  hopDecay: number;
  threshold: number;
  edgeFilter?: (edge: Synapse) => boolean;
}

interface SpreadOutput {
  activation: Map<string, number>;
  paths: Map<string, string[]>;
}

export class HierarchicalGraph {
  constructor(
    private readonly storage: StorageProvider,
    private readonly graph: NeuralGraph,
  ) {}

  async layeredSpread(
    seeds: ActivationSeed[],
    sessionId: string,
    options: LayeredSpreadOptions = {},
  ): Promise<LayeredResult[]> {
    const targetResults = options.targetResults ?? 10;
    const maxHops = options.maxHops ?? 2;
    const hopDecay = options.hopDecay ?? 0.5;
    const threshold = options.threshold ?? 0.08;

    const merged = new Map<
      string,
      { score: number; path: string[]; layer: "L0" | "L1" | "L2" }
    >();

    // L0: session-local spread — restrict to nodes belonging to sessionId.
    const sessionNodes = await this.storage.queryNodes({
      sourceSession: sessionId,
    });
    const sessionIdSet = new Set(sessionNodes.map((n) => n.id));

    const sessionSeeds = seeds.filter((s) => sessionIdSet.has(s.nodeId));

    if (sessionSeeds.length > 0) {
      const l0 = await this.spread(sessionSeeds, {
        maxHops,
        hopDecay,
        threshold,
        edgeFilter: (e) =>
          sessionIdSet.has(e.src) && sessionIdSet.has(e.dst),
      });
      for (const [nodeId, score] of l0.activation) {
        merged.set(nodeId, {
          score,
          path: l0.paths.get(nodeId) ?? [nodeId],
          layer: "L0",
        });
      }
    }

    if (merged.size >= targetResults) {
      return this.finalize(merged);
    }

    // L1: 1-hop spread from L0 activated nodes into the full graph.
    if (merged.size > 0) {
      const l1Seeds: ActivationSeed[] = [...merged.entries()].map(
        ([nodeId, info]) => ({ nodeId, baseScore: info.score }),
      );
      const l1 = await this.spread(l1Seeds, {
        maxHops: 1,
        hopDecay,
        threshold,
      });
      for (const [nodeId, score] of l1.activation) {
        if (merged.has(nodeId)) continue;
        merged.set(nodeId, {
          score,
          path: l1.paths.get(nodeId) ?? [nodeId],
          layer: "L1",
        });
      }
    }

    if (merged.size >= targetResults) {
      return this.finalize(merged);
    }

    // L2: unrestricted full-graph spread from the original seeds.
    const l2 = await this.graph.spreadingActivation(seeds, {
      maxHops,
      hopDecay,
      threshold,
    });
    for (const result of l2) {
      if (merged.has(result.nodeId)) continue;
      merged.set(result.nodeId, {
        score: result.score,
        path: result.path,
        layer: "L2",
      });
    }

    return this.finalize(merged);
  }

  private finalize(
    merged: Map<
      string,
      { score: number; path: string[]; layer: "L0" | "L1" | "L2" }
    >,
  ): LayeredResult[] {
    const out: LayeredResult[] = [];
    for (const [nodeId, info] of merged) {
      out.push({
        nodeId,
        score: info.score,
        path: info.path,
        layer: info.layer,
      });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  private async spread(
    seeds: ActivationSeed[],
    options: SpreadOptions,
  ): Promise<SpreadOutput> {
    const { maxHops, hopDecay, threshold, edgeFilter } = options;

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

      const frontierIds = [...frontier];
      const edges = await this.storage.getEdgesBatch(frontierIds, "both");

      const hopMultiplier = Math.pow(hopDecay, hop + 1);
      const nextFrontier = new Set<string>();

      for (const edge of edges) {
        if (edgeFilter && !edgeFilter(edge)) continue;

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

    return { activation, paths };
  }
}
