// Strategy A/B/D performance harness.
//
// Measures the ONLY point where the three strategies diverge: the compartment
// renderer. A -> renderCompartmentsB (80-char list); B/D -> renderCompartmentsCD
// (p1/p2/p3 tiers). B is FTS-only; D adds time-decay + embedding fusion. The rest
// of runCompartmentTransform is identical across strategies, so it is not measured.
//
// Metrics per strategy: rendered output tokens (compression size) and wall time
// (hot-path cost). Run: bun benchmark/strategy-perf.ts

import { Database } from "bun:sqlite";
import { renderCompartmentsB, renderCompartmentsCD } from "../packages/core/src/context-compressor.ts";

const DB_PATH = process.env.HOME + "/.local/share/ai-agent-local-memory/graph.db";
const SESSION = process.env.PERF_SESSION || "ses_166d0e7b9ffeBpCjAtqVkPPkP4";
const RUNS = Number(process.env.PERF_RUNS || 5);
const HISTORY_BUDGET_TOKENS = Number(process.env.PERF_BUDGET || 19200);

// crude token estimate identical to the plugin's fallback (char/4) so all three
// strategies are compared on the same ruler.
const countClaudeTokens = (t: string) => Math.ceil((t || "").length / 4);

const db = new Database(DB_PATH, { readonly: true });
const comps = db
  .query(
    `SELECT id, session_id as sessionId, start_ord as startOrd, end_ord as endOrd, p1, p2, p3, token_count as tokenCount, created_at as createdAt
     FROM compartments WHERE session_id = ? ORDER BY start_ord ASC`,
  )
  .all(SESSION) as any[];

if (comps.length === 0) {
  console.error(`No compartments for session ${SESSION}. Set PERF_SESSION to a session with compartments.`);
  process.exit(1);
}

// Query = a plausible recent-topic string. Use the newest compartment's p1 as a
// stand-in for "what the user is currently discussing" so FTS/semantic have signal.
const query = String(comps[comps.length - 1].p1 || "").slice(0, 500);

// FTS storage stub: score by lexical overlap against the query (bounded, no graph).
// This mirrors searchWithScores' shape without needing the live FTS index.
const qTokens = new Set(query.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
const storage = {
  async searchWithScores(q: string, n: number) {
    const qt = new Set(q.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
    const hits: Array<{ node: any; score: number }> = [];
    for (const c of comps) {
      const ct = new Set(String(c.p1).toLowerCase().split(/\W+/).filter((w) => w.length > 2));
      let overlap = 0;
      for (const t of qt) if (ct.has(t)) overlap++;
      const score = qt.size > 0 ? overlap / qt.size : 0;
      if (score > 0) hits.push({ node: { ord: c.startOrd, sessionId: SESSION }, score });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, n);
  },
};

// Deterministic pseudo-embedding for the D-sim variant (validates fusion cost only).
const dim = 64;
function fakeEmbed(text: string): number[] {
  const v = new Array(dim).fill(0);
  const toks = text.toLowerCase().split(/\W+/).filter(Boolean);
  for (const t of toks) {
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    v[h % dim] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}
const compsWithEmb = comps.map((c) => ({ ...c, embedding: fakeEmbed(String(c.p1)) }));
const qVec = fakeEmbed(query);
const embedQuery = async () => qVec;

type Variant = { name: string; run: () => Promise<any[]> };
const variants: Variant[] = [
  {
    name: "A  (80-char list)",
    // A uses renderCompartmentsB, which takes skipped messages; approximate with p1 titles.
    run: async () =>
      renderCompartmentsB(
        comps.map((c) => ({ info: { role: "user" }, parts: [{ type: "text", text: String(c.p1) }] })),
        comps.length,
      ),
  },
  {
    name: "B  (p1/p2/p3 FTS)",
    run: async () =>
      renderCompartmentsCD(comps, {
        query, storage, countClaudeTokens, sessionId: SESSION,
        historyBudgetTokens: HISTORY_BUDGET_TOKENS,
      }),
  },
  {
    name: "D-fts (FTS+decay, no embed)",
    run: async () =>
      renderCompartmentsCD(comps, {
        query, storage, countClaudeTokens, sessionId: SESSION,
        historyBudgetTokens: HISTORY_BUDGET_TOKENS, timeDecay: true, halfLifeRank: 5,
      }),
  },
  {
    name: "D-sim (FTS+decay+embed fusion)",
    run: async () =>
      renderCompartmentsCD(compsWithEmb, {
        query, storage, countClaudeTokens, sessionId: SESSION,
        historyBudgetTokens: HISTORY_BUDGET_TOKENS, timeDecay: true, halfLifeRank: 5,
        embedQuery, semanticWeight: 0.5,
      }),
  },
];

console.log(`\nStrategy performance — session ${SESSION.slice(0, 26)}  (${comps.length} compartments, budget ${HISTORY_BUDGET_TOKENS} tok, ${RUNS} runs)\n`);
console.log("strategy".padEnd(32), "out-tok".padStart(9), "msgs".padStart(6), "ms(avg)".padStart(9), "ms(min)".padStart(9));
console.log("-".repeat(70));

for (const v of variants) {
  await v.run();
  let lastMsgs: any[] = [];
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    lastMsgs = await v.run();
    times.push(performance.now() - t0);
  }
  const outText = lastMsgs
    .map((m) => (m.parts ?? []).map((p: any) => p.text ?? "").join(""))
    .join("\n");
  const outTok = countClaudeTokens(outText);
  const avg = times.reduce((s, x) => s + x, 0) / times.length;
  const min = Math.min(...times);
  console.log(
    v.name.padEnd(32),
    String(outTok).padStart(9),
    String(lastMsgs.length).padStart(6),
    avg.toFixed(3).padStart(9),
    min.toFixed(3).padStart(9),
  );
}
console.log("\nNotes:");
console.log("- out-tok = tokens in the rendered <earlier-topics>/compartment messages (lower = more compression).");
console.log("- D-fts is the real behavior TODAY (live compartments have no embedding yet; fusion degrades to FTS).");
console.log("- D-sim injects synthetic embeddings to measure the fusion cost delta vs D-fts.");
