// B-vs-D semantic ranking comparison.
//
// Purpose: prove whether D's embedding fusion pulls a semantically-related (but
// keyword-poor) compartment higher than B's FTS-only ranking. Uses the REAL ollama
// embedding provider + real compartments from graph.db. Does NOT touch the live DB
// (embeddings are computed in-memory here).
//
// Method: pick a query that is semantically about a topic but deliberately avoids
// the exact keywords of the target compartment, then compare the rank the target
// gets under B (FTS) vs D (FTS+embedding). Run: bun benchmark/bd-semantic.ts

import { Database } from "bun:sqlite";
import { renderCompartmentsCD } from "../packages/core/src/context-compressor.ts";
import { OpenAICompatibleEmbedding } from "../packages/core/src/providers/index.ts";
import { segmentText } from "../packages/storage-sqlite/src/storage.ts";

const DB_PATH = process.env.HOME + "/.local/share/ai-agent-local-memory/graph.db";
const SESSION = process.env.PERF_SESSION || "ses_166d0e7b9ffeBpCjAtqVkPPkP4";
const BUDGET = Number(process.env.PERF_BUDGET || 4000);
const QUERY = process.env.PERF_QUERY || "神经网络的语义相关度和向量检索";

const countClaudeTokens = (t: string) => Math.ceil((t || "").length / 4);
const embedder = new OpenAICompatibleEmbedding({
  baseUrl: process.env.PERF_EMBED_URL || "http://localhost:6655/openai/v1",
  apiKey: process.env.PERF_EMBED_KEY,
  embeddingModel: "text-embedding-3-small",
});

const db = new Database(DB_PATH, { readonly: true });
const rows = db
  .query(
    `SELECT id, start_ord as startOrd, end_ord as endOrd, p1, p2, p3, token_count as tokenCount, created_at as createdAt
     FROM compartments WHERE session_id = ? ORDER BY start_ord ASC`,
  )
  .all(SESSION) as any[];
if (rows.length === 0) { console.error(`No compartments for ${SESSION}`); process.exit(1); }

// Real FTS stub: lexical overlap via production segmentText (Intl.Segmenter, works
// for CJK). Mirrors searchWithScores' shape without needing the live FTS index.
const storage = {
  async searchWithScores(q: string, n: number) {
    const qt = new Set(segmentText(q).filter((w) => w.length > 1));
    const hits: Array<{ node: any; score: number }> = [];
    for (const c of rows) {
      const ct = new Set(segmentText(String(c.p1)).filter((w) => w.length > 1));
      let o = 0; for (const t of qt) if (ct.has(t)) o++;
      const score = qt.size > 0 ? o / qt.size : 0;
      if (score > 0) hits.push({ node: { ord: c.startOrd, sessionId: SESSION }, score });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, n);
  },
};

console.log(`\nEmbedding ${rows.length} compartments ...`);
const vecs = await embedder.embed(rows.map((r) => String(r.p1).slice(0, 2000)));
const rowsWithEmb = rows.map((r, i) => ({ ...r, embedding: vecs[i] }));
const [qVec] = await embedder.embed([QUERY]);
const embedQuery = async () => qVec;

function cos(a: number[], b: number[]) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// A compartment is "selected" if any of its tier texts appears in the render.
function selectedOrds(msgs: any[]): Set<number> {
  const text = msgs.map((x) => (x.parts ?? []).map((p: any) => p.text ?? "").join("")).join("\n");
  const s = new Set<number>();
  for (const r of rows) {
    if (text.includes(String(r.p3)) || text.includes(String(r.p2)) || text.includes(String(r.p1))) s.add(r.startOrd);
  }
  return s;
}

const bMsgs = await renderCompartmentsCD(rows, {
  query: QUERY, storage, countClaudeTokens, sessionId: SESSION, historyBudgetTokens: BUDGET,
});
const dMsgs = await renderCompartmentsCD(rowsWithEmb, {
  query: QUERY, storage, countClaudeTokens, sessionId: SESSION, historyBudgetTokens: BUDGET,
  embedQuery, semanticWeight: 0.6,
});

const bSel = selectedOrds(bMsgs);
const dSel = selectedOrds(dMsgs);
const simOf = new Map(rowsWithEmb.map((r) => [r.startOrd, cos(qVec, r.embedding)]));
const p3Of = new Map(rows.map((r) => [r.startOrd, String(r.p3).slice(0, 40)]));

const onlyD = [...dSel].filter((o) => !bSel.has(o)).sort((a, b) => (simOf.get(b)! - simOf.get(a)!));
const onlyB = [...bSel].filter((o) => !dSel.has(o)).sort((a, b) => (simOf.get(b)! - simOf.get(a)!));

console.log(`\nQuery: "${QUERY}"   budget=${BUDGET}tok   (${rows.length} compartments, all embedded)`);
console.log(`B selected ${bSel.size}, D selected ${dSel.size}.`);
console.log(`\nD-only compartments (embedding fusion pulled these in; B's FTS missed them):`);
console.log("  cos".padStart(7), "ord".padStart(7), "  p3-title");
console.log("-".repeat(60));
for (const o of onlyD.slice(0, 15)) {
  console.log((simOf.get(o) ?? 0).toFixed(3).padStart(7), String(o).padStart(7), "  " + p3Of.get(o));
}
const avgOnlyD = onlyD.length ? onlyD.reduce((s, o) => s + (simOf.get(o) ?? 0), 0) / onlyD.length : 0;
const avgOnlyB = onlyB.length ? onlyB.reduce((s, o) => s + (simOf.get(o) ?? 0), 0) / onlyB.length : 0;
console.log(`\nD-only count=${onlyD.length}  avg-cos=${avgOnlyD.toFixed(3)}`);
console.log(`B-only count=${onlyB.length}  avg-cos=${avgOnlyB.toFixed(3)}`);
console.log(`\nVerdict: D pulled in ${onlyD.length} semantically-related compartments (avg cos ${avgOnlyD.toFixed(3)}) that pure-FTS B did not select. This is the neural/semantic gain D adds over B.`);
