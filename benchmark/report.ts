import type {
  AdapterMetrics,
  CategoryMetrics,
  LatencyStats,
  AdapterRun,
} from "./metrics.ts";
import { RECALL_KS } from "./metrics.ts";

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function fmtMs(v: number): string {
  return `${v.toFixed(2)}ms`;
}

function fmtBytes(b: number): string {
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(2)} KB`;
  return `${b} B`;
}

function latencyRow(name: string, l: LatencyStats): string {
  return `| ${name} | ${l.count} | ${fmtMs(l.meanMs)} | ${fmtMs(l.p50Ms)} | ${fmtMs(l.p95Ms)} | ${fmtMs(l.maxMs)} |`;
}

function recallTableHeader(): string {
  const ks = RECALL_KS.map((k) => `R@${k}`).join(" | ");
  return `| Adapter | Queries | ${ks} | MRR |\n|---|---|${RECALL_KS.map(() => "---").join("|")}|---|`;
}

function recallRow(adapter: string, m: CategoryMetrics): string {
  const cells = RECALL_KS.map((k) => fmtPct(m.recallAt[k] ?? 0)).join(" | ");
  return `| ${adapter} | ${m.queryCount} | ${cells} | ${m.mrr.toFixed(3)} |`;
}

function categoryBlock(
  category: string,
  perAdapter: AdapterMetrics[],
  pickCat: (m: AdapterMetrics) => CategoryMetrics,
): string {
  const lines: string[] = [];
  lines.push(`### ${category}`);
  lines.push("");
  lines.push(recallTableHeader());
  for (const m of perAdapter) lines.push(recallRow(m.adapterName, pickCat(m)));
  lines.push("");
  lines.push("| Adapter | Queries | mean | p50 | p95 | max |");
  lines.push("|---|---|---|---|---|---|");
  for (const m of perAdapter)
    lines.push(latencyRow(m.adapterName, pickCat(m).queryLatency));
  lines.push("");
  return lines.join("\n");
}

export interface ReportInput {
  runs: AdapterRun[];
  metrics: AdapterMetrics[];
  factCount: number;
  queryCount: number;
  warmupCount: number;
  startedAt: string;
  durationMs: number;
}

export function renderReport(input: ReportInput): string {
  const { metrics, factCount, queryCount, warmupCount, startedAt, durationMs, runs } = input;
  const lines: string[] = [];

  lines.push("# Memory Engine Recall Benchmark");
  lines.push("");
  lines.push(`- **Run started**: ${startedAt}`);
  lines.push(`- **Total duration**: ${(durationMs / 1000).toFixed(2)}s`);
  lines.push(`- **Facts ingested**: ${factCount}`);
  lines.push(`- **Queries evaluated**: ${queryCount}`);
  lines.push(`- **Warmup queries**: ${warmupCount}`);
  lines.push(`- **Adapters**: ${metrics.map((m) => m.adapterName).join(", ")}`);
  lines.push("");

  lines.push("## Storage footprint");
  lines.push("");
  lines.push("| Adapter | Nodes | Edges | DB size |");
  lines.push("|---|---|---|---|");
  for (const m of metrics)
    lines.push(
      `| ${m.adapterName} | ${m.stats.nodeCount} | ${m.stats.edgeCount ?? 0} | ${fmtBytes(m.stats.dbSizeBytes)} |`,
    );
  lines.push("");

  lines.push("## Ingest latency");
  lines.push("");
  lines.push("| Adapter | n | mean | p50 | p95 | max |");
  lines.push("|---|---|---|---|---|---|");
  for (const m of metrics) lines.push(latencyRow(m.adapterName, m.ingestLatency));
  lines.push("");

  lines.push("## Recall quality");
  lines.push("");
  lines.push(categoryBlock("Overall", metrics, (m) => m.overall));
  lines.push(categoryBlock(
    "Exact (direct keyword match)",
    metrics,
    (m) => m.byCategory.find((c) => c.category === "exact")!,
  ));
  lines.push(categoryBlock(
    "Paraphrase (same meaning, different words)",
    metrics,
    (m) => m.byCategory.find((c) => c.category === "paraphrase")!,
  ));
  lines.push(categoryBlock(
    "Associative (multi-hop reasoning)",
    metrics,
    (m) => m.byCategory.find((c) => c.category === "associative")!,
  ));
  lines.push(categoryBlock(
    "Topic return (warmed topic, novel question)",
    metrics,
    (m) =>
      m.byCategory.find((c) => c.category === "topic_return") ?? {
        category: "topic_return",
        queryCount: 0,
        recallAt: {},
        mrr: 0,
        queryLatency: { count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 },
      },
  ));

  lines.push("## Per-query results");
  lines.push("");
  for (const run of runs) {
    lines.push(`### ${run.adapterName}`);
    lines.push("");
    lines.push("| Query ID | Category | Latency | Expected | Top-3 returned | Hit |");
    lines.push("|---|---|---|---|---|---|");
    for (const q of run.queries) {
      const top3 = q.returnedIds.slice(0, 3).join(", ") || "—";
      const expected = q.expectedFactIds.join(", ");
      const expSet = new Set(q.expectedFactIds);
      const hit = q.returnedIds.some((id) => expSet.has(id)) ? "Y" : "N";
      lines.push(
        `| ${q.queryId} | ${q.category} | ${fmtMs(q.latencyMs)} | ${expected} | ${top3} | ${hit} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}
