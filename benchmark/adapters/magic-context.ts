import { Database } from "bun:sqlite";
import { join } from "node:path";
import { statSync } from "node:fs";
import type { AdapterStats, MemoryAdapter } from "./types.ts";

function escapeFts(query: string): string {
  return query
    .replace(/"/g, "")
    .split(/[\s\p{P}]+/u)
    .filter(Boolean)
    .map((w) => `"${w}"`)
    .join(" OR ");
}

export class MagicContextBaselineAdapter implements MemoryAdapter {
  name = "magic-context (FTS5 baseline)";
  private db: Database | null = null;
  private dbPath = "";
  private docFreq = new Map<string, number>();
  private docCount = 0;

  async init(storageDir: string): Promise<void> {
    this.dbPath = join(storageDir, "magic.db");
    const db = new Database(this.dbPath, { create: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS docs (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        meta TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
        content,
        content='docs',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
        INSERT INTO docs_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
        INSERT INTO docs_fts(docs_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
    `);
    this.db = db;
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[\s\p{P}]+/u)
      .filter((t) => t.length > 1);
  }

  async remember(id: string, content: string, meta?: Record<string, unknown>): Promise<void> {
    if (!this.db) throw new Error("not initialized");
    this.db
      .prepare("INSERT OR REPLACE INTO docs (id, content, meta) VALUES (?, ?, ?)")
      .run(id, content, meta ? JSON.stringify(meta) : null);

    const seen = new Set(this.tokenize(content));
    for (const tok of seen) this.docFreq.set(tok, (this.docFreq.get(tok) ?? 0) + 1);
    this.docCount++;
  }

  async warmup(queries: string[]): Promise<void> {
    for (const q of queries) {
      await this.recall(q, 10);
    }
  }

  async recall(
    query: string,
    k: number,
  ): Promise<Array<{ id: string; score: number; content: string }>> {
    if (!this.db) throw new Error("not initialized");

    const ftsQuery = escapeFts(query);
    if (!ftsQuery) return [];

    let ftsRows: Array<{ id: string; content: string; rank: number }> = [];
    try {
      ftsRows = this.db
        .prepare(
          `SELECT d.id as id, d.content as content, bm25(docs_fts) as rank
           FROM docs_fts
           JOIN docs d ON d.rowid = docs_fts.rowid
           WHERE docs_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(ftsQuery, k * 4) as Array<{ id: string; content: string; rank: number }>;
    } catch {
      ftsRows = [];
    }

    const queryTokens = this.tokenize(query);
    const queryTf = new Map<string, number>();
    for (const t of queryTokens) queryTf.set(t, (queryTf.get(t) ?? 0) + 1);

    const queryVec = this.tfidf(queryTf);

    const candidates = ftsRows.length
      ? ftsRows
      : (this.db
          .prepare("SELECT id, content, 0 as rank FROM docs LIMIT ?")
          .all(k * 4) as Array<{ id: string; content: string; rank: number }>);

    const scored = candidates.map((row) => {
      const docTf = new Map<string, number>();
      for (const t of this.tokenize(row.content))
        docTf.set(t, (docTf.get(t) ?? 0) + 1);
      const docVec = this.tfidf(docTf);
      const cos = cosine(queryVec, docVec);
      const bm = -row.rank;
      const score = 0.7 * cos + 0.3 * Math.tanh(bm / 5);
      return { id: row.id, score, content: row.content };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  private tfidf(tf: Map<string, number>): Map<string, number> {
    const vec = new Map<string, number>();
    const N = Math.max(this.docCount, 1);
    for (const [tok, f] of tf) {
      const df = this.docFreq.get(tok) ?? 1;
      const idf = Math.log(1 + N / df);
      vec.set(tok, f * idf);
    }
    return vec;
  }

  async stats(): Promise<AdapterStats> {
    if (!this.db) throw new Error("not initialized");
    const row = this.db.prepare("SELECT COUNT(*) as c FROM docs").get() as { c: number };
    let size = 0;
    try {
      size = statSync(this.dbPath).size;
    } catch {
      size = 0;
    }
    return { nodeCount: row.c, dbSizeBytes: size, edgeCount: 0 };
  }

  async close(): Promise<void> {
    if (this.db) this.db.close();
    this.db = null;
  }
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [, v] of a) na += v * v;
  for (const [, v] of b) nb += v * v;
  const small = a.size <= b.size ? a : b;
  const large = small === a ? b : a;
  for (const [k, v] of small) {
    const w = large.get(k);
    if (w !== undefined) dot += v * w;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
