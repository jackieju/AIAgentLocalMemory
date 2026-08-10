// Diagnostic probe: for each R@1 failure, dump the final top-10 with the
// fts / activation / wm component breakdown so we can see WHICH signal
// displaced the correct doc. Verifies the "activation-only nodes displace
// FTS hits" hypothesis before/after a rerank change.
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

const tmp = mkdtempSync(join(tmpdir(), "rerankprobe-"));
const a = new AIAgentLocalAdapter();
await a.init(tmp);
for (const f of facts) await a.remember(f.id, f.content, { category: f.category });
if (a.finalizeIngest) await a.finalizeIngest();
if (a.warmup) await a.warmup(warmup);

const storage = (a as any).storage as SqliteStorageProvider;
const nodeIdToDataset = (a as any).nodeIdToDatasetId as Map<string, string>;
const ds = (id: string) => nodeIdToDataset.get(id) ?? "?";

for (const q of queries) {
  const hits = await a.recall(q.query, 10);
  const ids = hits.map((h: any) => h.id);
  const rank = ids.findIndex((id: string) => q.expected_fact_ids.includes(id));
  if (rank === 0) continue; // only failures

  // Raw FTS pool (pre-rerank) sigmoid scores
  const pool = await storage.searchWithScores(q.query, 30);
  const poolFts = new Map<string, number>(pool.map((p: any) => [ds(p.node.id), p.score]));

  console.log(`\n[${q.category}] "${q.query}"`);
  console.log(`  expected=${q.expected_fact_ids} finalRank=${rank}`);
  console.log(`  --- final top-10 (dataset id : score : rawFtsSigmoid) ---`);
  hits.forEach((h: any, i: number) => {
    const d = h.id;
    const raw = poolFts.has(d) ? poolFts.get(d)!.toFixed(3) : "ABSENT(activation-only)";
    const mark = q.expected_fact_ids.includes(d) ? " <== EXPECTED" : "";
    console.log(`   #${i} ${d}  score=${h.score.toFixed(3)}  rawFts=${raw}${mark}`);
  });
  // where is the expected doc in the raw pool?
  for (const ef of q.expected_fact_ids) {
    if (poolFts.has(ef)) {
      const poolRank = pool.findIndex((p: any) => ds(p.node.id) === ef);
      console.log(`   >> expected ${ef} was pool#${poolRank} rawFts=${poolFts.get(ef)!.toFixed(3)} but final#${rank < 0 ? "OUT" : rank}`);
    }
  }
}

await a.close();
rmSync(tmp, { recursive: true, force: true });
