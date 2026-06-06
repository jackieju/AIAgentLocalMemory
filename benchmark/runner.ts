import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { AIAgentLocalAdapter } from "./adapters/ai-agent-local.ts";
import { MagicContextBaselineAdapter } from "./adapters/magic-context.ts";
import type { MemoryAdapter } from "./adapters/types.ts";
import {
  computeMetrics,
  type AdapterRun,
  type Category,
  type QueryRun,
} from "./metrics.ts";
import { renderReport } from "./report.ts";

interface FactRecord {
  id: string;
  category: string;
  content: string;
}

interface QueryRecord {
  id: string;
  category: Category;
  query: string;
  expected_fact_ids: string[];
  description?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const FACTS_PATH = join(__dirname, "datasets", "facts.json");
const QUERIES_PATH = join(__dirname, "datasets", "queries.json");
const WARMUP_PATH = join(__dirname, "datasets", "warmup.json");
const REPORT_PATH = join(__dirname, "report.md");
const RAW_RESULTS_PATH = join(__dirname, "results.json");
const TOP_K = 10;

async function runAdapter(
  adapter: MemoryAdapter,
  facts: FactRecord[],
  queries: QueryRecord[],
  warmupQueries: string[],
): Promise<AdapterRun> {
  const tmp = mkdtempSync(join(tmpdir(), "mem-bench-"));
  mkdirSync(tmp, { recursive: true });

  console.log(`\n>> ${adapter.name}`);
  console.log(`   storage: ${tmp}`);

  await adapter.init(tmp);

  const ingestLatencies: number[] = [];
  for (const fact of facts) {
    const t0 = performance.now();
    await adapter.remember(fact.id, fact.content, { category: fact.category });
    ingestLatencies.push(performance.now() - t0);
  }
  console.log(`   ingested ${facts.length} facts`);

  if (adapter.finalizeIngest) {
    const t0 = performance.now();
    await adapter.finalizeIngest();
    console.log(`   finalizeIngest in ${(performance.now() - t0).toFixed(1)}ms`);
  }

  if (adapter.warmup && warmupQueries.length > 0) {
    const t0 = performance.now();
    await adapter.warmup(warmupQueries);
    console.log(
      `   warmup ran ${warmupQueries.length} queries in ${(performance.now() - t0).toFixed(1)}ms`,
    );
  }

  const queryRuns: QueryRun[] = [];
  for (const q of queries) {
    const t0 = performance.now();
    const hits = await adapter.recall(q.query, TOP_K);
    const latency = performance.now() - t0;
    queryRuns.push({
      queryId: q.id,
      category: q.category,
      expectedFactIds: q.expected_fact_ids,
      returnedIds: hits.map((h) => h.id),
      latencyMs: latency,
    });
  }
  console.log(`   ran ${queries.length} queries`);

  const stats = await adapter.stats();
  console.log(
    `   stats: nodes=${stats.nodeCount} edges=${stats.edgeCount ?? 0} db=${stats.dbSizeBytes}B`,
  );
  await adapter.close();

  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    void 0;
  }

  return {
    adapterName: adapter.name,
    ingestLatenciesMs: ingestLatencies,
    queries: queryRuns,
    stats,
  };
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();

  const factsRaw = JSON.parse(readFileSync(FACTS_PATH, "utf8"));
  const queriesRaw = JSON.parse(readFileSync(QUERIES_PATH, "utf8"));
  const warmupRaw = JSON.parse(readFileSync(WARMUP_PATH, "utf8"));
  const facts: FactRecord[] = factsRaw.facts;
  const queries: QueryRecord[] = queriesRaw.queries;
  const warmupQueries: string[] = warmupRaw.queries;

  console.log(
    `Loaded ${facts.length} facts, ${queries.length} queries, ${warmupQueries.length} warmup queries`,
  );
  if (facts.length < 50) throw new Error("need at least 50 facts");
  if (queries.length < 30) throw new Error("need at least 30 queries");

  const adapters: MemoryAdapter[] = [
    new AIAgentLocalAdapter(),
    new MagicContextBaselineAdapter(),
  ];

  const runs: AdapterRun[] = [];
  for (const a of adapters) {
    runs.push(await runAdapter(a, facts, queries, warmupQueries));
  }

  const metrics = runs.map(computeMetrics);
  const durationMs = performance.now() - t0;

  const md = renderReport({
    runs,
    metrics,
    factCount: facts.length,
    queryCount: queries.length,
    warmupCount: warmupQueries.length,
    startedAt,
    durationMs,
  });

  writeFileSync(REPORT_PATH, md);
  writeFileSync(
    RAW_RESULTS_PATH,
    JSON.stringify({ startedAt, durationMs, runs, metrics }, null, 2),
  );

  console.log("\n" + "=".repeat(60));
  for (const m of metrics) {
    console.log(
      `${m.adapterName.padEnd(40)} ` +
        `R@1=${(m.overall.recallAt[1]! * 100).toFixed(1)}%  ` +
        `R@5=${(m.overall.recallAt[5]! * 100).toFixed(1)}%  ` +
        `MRR=${m.overall.mrr.toFixed(3)}  ` +
        `p50=${m.overall.queryLatency.p50Ms.toFixed(2)}ms`,
    );
  }
  console.log("=".repeat(60));
  console.log(`\nReport: ${REPORT_PATH}`);
  console.log(`Raw:    ${RAW_RESULTS_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
