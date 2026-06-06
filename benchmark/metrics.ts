export type Category = "exact" | "paraphrase" | "associative" | "topic_return";

export interface QueryRun {
  queryId: string;
  category: Category;
  expectedFactIds: string[];
  returnedIds: string[];
  latencyMs: number;
}

export interface AdapterRun {
  adapterName: string;
  ingestLatenciesMs: number[];
  queries: QueryRun[];
  stats: { nodeCount: number; dbSizeBytes: number };
}

export interface CategoryMetrics {
  category: Category | "overall";
  queryCount: number;
  recallAt: Record<number, number>;
  mrr: number;
  queryLatency: LatencyStats;
}

export interface LatencyStats {
  count: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface AdapterMetrics {
  adapterName: string;
  byCategory: CategoryMetrics[];
  overall: CategoryMetrics;
  ingestLatency: LatencyStats;
  stats: { nodeCount: number; dbSizeBytes: number };
}

const KS = [1, 3, 5, 10] as const;
export const RECALL_KS: readonly number[] = KS;

export function recallAtK(expected: string[], returned: string[], k: number): number {
  if (expected.length === 0) return 0;
  const topK = new Set(returned.slice(0, k));
  let hits = 0;
  for (const id of expected) if (topK.has(id)) hits++;
  return hits / expected.length;
}

export function reciprocalRank(expected: string[], returned: string[]): number {
  if (expected.length === 0) return 0;
  const exp = new Set(expected);
  for (let i = 0; i < returned.length; i++) {
    if (exp.has(returned[i]!)) return 1 / (i + 1);
  }
  return 0;
}

export function latencyStats(samples: number[]): LatencyStats {
  if (samples.length === 0) {
    return { count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / sorted.length;
  const pick = (p: number) => {
    const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
    return sorted[idx]!;
  };
  return {
    count: sorted.length,
    meanMs: mean,
    p50Ms: pick(0.5),
    p95Ms: pick(0.95),
    maxMs: sorted[sorted.length - 1]!,
  };
}

function summarize(
  category: Category | "overall",
  runs: QueryRun[],
): CategoryMetrics {
  const recallAt: Record<number, number> = {};
  for (const k of KS) recallAt[k] = 0;
  let mrrSum = 0;
  const lat: number[] = [];

  for (const r of runs) {
    for (const k of KS) {
      recallAt[k]! += recallAtK(r.expectedFactIds, r.returnedIds, k);
    }
    mrrSum += reciprocalRank(r.expectedFactIds, r.returnedIds);
    lat.push(r.latencyMs);
  }

  const n = runs.length || 1;
  for (const k of KS) recallAt[k] = recallAt[k]! / n;

  return {
    category,
    queryCount: runs.length,
    recallAt,
    mrr: mrrSum / n,
    queryLatency: latencyStats(lat),
  };
}

export function computeMetrics(run: AdapterRun): AdapterMetrics {
  const byCat: CategoryMetrics[] = [];
  const cats: Category[] = ["exact", "paraphrase", "associative", "topic_return"];
  for (const c of cats) {
    const queries = run.queries.filter((q) => q.category === c);
    byCat.push(summarize(c, queries));
  }
  return {
    adapterName: run.adapterName,
    byCategory: byCat,
    overall: summarize("overall", run.queries),
    ingestLatency: latencyStats(run.ingestLatenciesMs),
    stats: run.stats,
  };
}
