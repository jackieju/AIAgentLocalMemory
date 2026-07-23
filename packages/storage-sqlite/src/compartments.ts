import type { Compartment } from "@ai-agent-local-memory/core";
import { Database } from "./sqlite-shim.ts";

interface CompartmentRow {
  id: number;
  sessionId: string;
  startOrd: number;
  endOrd: number;
  startMessageId: string;
  endMessageId: string;
  p1: string;
  p2: string;
  p3: string;
  tokenCount: number;
  createdAt: number;
}

export class CompartmentStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.createTable();
  }

  private createTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS compartments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        start_ord INTEGER NOT NULL,
        end_ord INTEGER NOT NULL,
        start_message_id TEXT NOT NULL DEFAULT '',
        end_message_id TEXT NOT NULL DEFAULT '',
        p1 TEXT NOT NULL,
        p2 TEXT NOT NULL,
        p3 TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(session_id, end_message_id)
      )
    `);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_compartments_session ON compartments(session_id, start_ord)`
    );
  }

  dropAndRecreate(): void {
    this.db.exec(`DROP TABLE IF EXISTS compartments`);
    this.createTable();
  }

  save(c: Omit<Compartment, "id">): Compartment {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO compartments (session_id, start_ord, end_ord, start_message_id, end_message_id, p1, p2, p3, token_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      c.sessionId,
      c.startOrd,
      c.endOrd,
      c.startMessageId ?? "",
      c.endMessageId ?? "",
      c.p1,
      c.p2,
      c.p3,
      c.tokenCount,
      c.createdAt
    );
    return { ...c, id: Number(result.lastInsertRowid) };
  }

  getForSession(sessionId: string): Compartment[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id as sessionId, start_ord as startOrd, end_ord as endOrd, start_message_id as startMessageId, end_message_id as endMessageId, p1, p2, p3, token_count as tokenCount, created_at as createdAt FROM compartments WHERE session_id = ? ORDER BY start_ord ASC`
      )
      .all(sessionId) as CompartmentRow[];
    return rows;
  }

  getMaxOrd(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT MAX(end_ord) as m FROM compartments WHERE session_id = ?`)
      .get(sessionId) as { m: number | null } | undefined;
    return row?.m ?? -1;
  }
}
