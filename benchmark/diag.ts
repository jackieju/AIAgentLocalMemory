import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AIAgentLocalAdapter } from "./adapters/ai-agent-local.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const facts = JSON.parse(readFileSync(join(__dirname, "datasets", "facts.json"), "utf8")).facts;
const queries = JSON.parse(readFileSync(join(__dirname, "datasets", "queries.json"), "utf8")).queries;
const warmup = JSON.parse(readFileSync(join(__dirname, "datasets", "warmup.json"), "utf8")).queries;

const tmp = mkdtempSync(join(tmpdir(), "mem-diag-"));
const a = new AIAgentLocalAdapter();
await a.init(tmp);
for (const f of facts) await a.remember(f.id, f.content, { category: f.category });
if (a.finalizeIngest) await a.finalizeIngest();
if (a.warmup) await a.warmup(warmup);

let r1 = 0, r5 = 0;
const fails: string[] = [];
for (const q of queries) {
  const hits = await a.recall(q.query, 10);
  const ids = hits.map((h) => h.id);
  const rankOfFirstExpected = ids.findIndex((id) => q.expected_fact_ids.includes(id));
  const hitAt1 = rankOfFirstExpected === 0;
  const hitAt5 = rankOfFirstExpected >= 0 && rankOfFirstExpected < 5;
  if (hitAt1) r1++;
  if (hitAt5) r5++;
  if (!hitAt1) {
    const expectedContent = facts.find((f: any) => q.expected_fact_ids.includes(f.id))?.content ?? "?";
    fails.push(
      `[${q.category}] Q: "${q.query}"\n   expected: ${q.expected_fact_ids} rankFound=${rankOfFirstExpected}\n   expContent: ${expectedContent.slice(0, 70)}\n   top3: ${hits.slice(0, 3).map((h) => `${h.id}(${h.score.toFixed(2)})`).join(", ")}`,
    );
  }
}
console.log(`R@1=${((r1 / queries.length) * 100).toFixed(1)}%  R@5=${((r5 / queries.length) * 100).toFixed(1)}%  (${queries.length} queries)`);
console.log(`\n=== ${fails.length} R@1 FAILURES ===`);
for (const f of fails) console.log(f + "\n");

await a.close();
rmSync(tmp, { recursive: true, force: true });
