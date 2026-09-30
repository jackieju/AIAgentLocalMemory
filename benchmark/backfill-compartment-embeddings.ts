// Compartment embedding backfill.
//
// One-shot: walks compartments in graph.db that have no embedding yet, embeds their
// p1 text in batches via the configured provider, and persists the vector so strategy
// D's semantic fusion has vectors to work with on already-existing compartments (the
// hot path only embeds NEW compartments as they are written). Idempotent: re-running
// skips rows that already have an embedding.
//
// Env: PERF_EMBED_KEY (proxy key), PERF_EMBED_URL (default localhost:6655/openai/v1),
//      PERF_SESSION (optional: limit to one session), PERF_BATCH (default 32).
// Run: PERF_EMBED_KEY=... bun benchmark/backfill-compartment-embeddings.ts

import { Database } from "bun:sqlite";
import { OpenAICompatibleEmbedding } from "../packages/core/src/providers/index.ts";

const DB_PATH = process.env.HOME + "/.local/share/ai-agent-local-memory/graph.db";
const BATCH = Number(process.env.PERF_BATCH || 32);
const ONLY_SESSION = process.env.PERF_SESSION || null;

const embedder = new OpenAICompatibleEmbedding({
  baseUrl: process.env.PERF_EMBED_URL || "http://localhost:6655/openai/v1",
  apiKey: process.env.PERF_EMBED_KEY,
  embeddingModel: "text-embedding-3-small",
});

const db = new Database(DB_PATH);

// Mirror CompartmentStore's idempotent migration so this runs even before the plugin
// has restarted to add the column itself (SQLite lacks ADD COLUMN IF NOT EXISTS).
try { db.exec(`ALTER TABLE compartments ADD COLUMN embedding TEXT`); } catch { /* exists */ }

const where = ONLY_SESSION ? `AND session_id = ?` : ``;
const rows = db
  .query(`SELECT id, p1 FROM compartments WHERE embedding IS NULL AND p1 IS NOT NULL AND p1 != '' ${where} ORDER BY id ASC`)
  .all(...(ONLY_SESSION ? [ONLY_SESSION] : [])) as Array<{ id: number; p1: string }>;

if (rows.length === 0) {
  console.log("Nothing to backfill — all compartments already have embeddings.");
  process.exit(0);
}

const update = db.prepare(`UPDATE compartments SET embedding = ? WHERE id = ?`);
console.log(`Backfilling ${rows.length} compartments (batch ${BATCH})${ONLY_SESSION ? ` for ${ONLY_SESSION}` : ""} ...`);

let done = 0, failed = 0;
for (let i = 0; i < rows.length; i += BATCH) {
  const chunk = rows.slice(i, i + BATCH);
  try {
    const vecs = await embedder.embed(chunk.map((r) => String(r.p1).slice(0, 2000)));
    const tx = db.transaction((pairs: Array<{ id: number; vec: number[] }>) => {
      for (const p of pairs) update.run(JSON.stringify(p.vec), p.id);
    });
    tx(chunk.map((r, j) => ({ id: r.id, vec: vecs[j] })).filter((p) => Array.isArray(p.vec) && p.vec.length > 0));
    done += chunk.length;
  } catch (err) {
    failed += chunk.length;
    console.error(`  batch @${i} failed: ${err instanceof Error ? err.message : err}`);
  }
  process.stdout.write(`\r  ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
}
console.log(`\nDone. embedded=${done} failed=${failed}`);

const remaining = db.query(`SELECT COUNT(*) as n FROM compartments WHERE embedding IS NULL`).get() as { n: number };
console.log(`Compartments still without embedding: ${remaining.n}`);
