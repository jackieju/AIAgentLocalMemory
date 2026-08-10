import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AIAgentLocalAdapter } from "./adapters/ai-agent-local.ts";
import { SqliteStorageProvider } from "../packages/storage-sqlite/src/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const facts = JSON.parse(readFileSync(join(__dirname, "datasets", "facts.json"), "utf8")).facts;
const queries = JSON.parse(readFileSync(join(__dirname, "datasets", "queries.json"), "utf8")).queries;
const warmup = JSON.parse(readFileSync(join(__dirname, "datasets", "warmup.json"), "utf8")).queries;

const tmp = mkdtempSync(join(tmpdir(), "poolcheck-"));
const a = new AIAgentLocalAdapter();
await a.init(tmp);
for (const f of facts) await a.remember(f.id, f.content, { category: f.category });
if (a.finalizeIngest) await a.finalizeIngest();
if (a.warmup) await a.warmup(warmup);

const storage = (a as any).storage as SqliteStorageProvider;
const nodeIdToDataset = (a as any).nodeIdToDatasetId as Map<string, string>;

// The 17 R@1 failures from diag.ts (rankFound !== 0)
let classA = 0; // expected doc IS in the raw FTS candidate pool -> reranking problem
let classB = 0; // expected doc NOT in pool -> candidate-acquisition gap (needs stemming/synonym)
const classALines: string[] = [];
const classBLines: string[] = [];

const POOL_SIZE = 30;

for (const q of queries) {
  const hits = await a.recall(q.query, 10);
  const ids = hits.map((h: any) => h.id);
  const rankOfFirstExpected = ids.findIndex((id: string) => q.expected_fact_ids.includes(id));
  const hitAt1 = rankOfFirstExpected === 0;
  if (hitAt1) continue; // only inspect R@1 failures

  // Raw FTS candidate pool (pre-rerank), mapped back to dataset ids
  const scored = await storage.searchWithScores(q.query, POOL_SIZE);
  const poolIds = new Set(scored.map((s: any) => nodeIdToDataset.get(s.node.id) ?? "?"));
  const inPool = q.expected_fact_ids.filter((fid: string) => poolIds.has(fid));

  if (inPool.length > 0) {
    classA++;
    const rankInPool = scored.findIndex(
      (s: any) => q.expected_fact_ids.includes(nodeIdToDataset.get(s.node.id) ?? ""),
    );
    classALines.push(
      `[${q.category}] "${q.query}"\n   expected=${q.expected_fact_ids} inPool=${inPool} poolRank=${rankInPool}/${scored.length} finalRank=${rankOfFirstExpected}`,
    );
  } else {
    classB++;
    const expContent = facts.find((f: any) => q.expected_fact_ids.includes(f.id))?.content ?? "?";
    classBLines.push(
      `[${q.category}] "${q.query}"\n   expected=${q.expected_fact_ids} (ABSENT from ${scored.length}-doc pool)\n   expContent: ${expContent.slice(0, 80)}`,
    );
  }
}

console.log(`\n===== CANDIDATE-ACQUISITION GAP ANALYSIS =====`);
console.log(`Class A (in pool, mis-ranked -> RERANK fix):   ${classA}`);
console.log(`Class B (absent from pool -> ACQUISITION fix): ${classB}`);

console.log(`\n--- CLASS A (reranking problem) ---`);
for (const l of classALines) console.log(l + "\n");

console.log(`\n--- CLASS B (candidate-acquisition gap) ---`);
for (const l of classBLines) console.log(l + "\n");

await a.close();
rmSync(tmp, { recursive: true, force: true });
