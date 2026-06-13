import { Database, Statement } from './sqlite-shim.ts';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  MemoryNode,
  NodeFilter,
  NodeType,
  StorageProvider,
  Synapse,
  SynapseType,
} from '@ai-agent-local-memory/core';

interface NodeRow {
  id: string;
  type: string;
  content: string;
  importance: number;
  strength: number;
  access_count: number;
  last_accessed: number | null;
  created_at: number;
  source_session: string | null;
  source_range: string | null;
  metadata: string | null;
}

interface EdgeRow {
  src: string;
  dst: string;
  type: string;
  weight: number;
  last_coactivated: number | null;
  coactivation_count: number;
}

const NODE_COLS =
  'id, type, content, importance, strength, access_count, last_accessed, created_at, source_session, source_range, metadata';

const NODE_COLS_PREFIXED =
  'n.id, n.type, n.content, n.importance, n.strength, n.access_count, n.last_accessed, n.created_at, n.source_session, n.source_range, n.metadata';

const EDGE_COLS = 'src, dst, type, weight, last_coactivated, coactivation_count';

const NODE_UPDATE_COLUMNS: Record<string, string> = {
  type: 'type',
  content: 'content',
  importance: 'importance',
  strength: 'strength',
  accessCount: 'access_count',
  lastAccessed: 'last_accessed',
  createdAt: 'created_at',
  sourceSession: 'source_session',
  sourceRange: 'source_range',
  metadata: 'metadata',
};

const EDGE_UPDATE_COLUMNS: Record<string, string> = {
  weight: 'weight',
  lastCoactivated: 'last_coactivated',
  coactivationCount: 'coactivation_count',
};

function getStoragePath(_projectId?: string): string {
  if (process.env.AI_AGENT_LOCAL_MEMORY_DIR) {
    return join(process.env.AI_AGENT_LOCAL_MEMORY_DIR, 'graph.db');
  }
  const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'ai-agent-local-memory', 'graph.db');
}

function rowToNode(row: NodeRow): MemoryNode {
  return {
    id: row.id,
    type: row.type as NodeType,
    content: row.content,
    importance: row.importance,
    strength: row.strength,
    accessCount: row.access_count,
    lastAccessed: row.last_accessed ?? 0,
    createdAt: row.created_at,
    sourceSession: row.source_session ?? undefined,
    sourceRange: row.source_range ? (JSON.parse(row.source_range) as [number, number]) : undefined,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
  };
}

function rowToEdge(row: EdgeRow): Synapse {
  return {
    src: row.src,
    dst: row.dst,
    type: row.type as SynapseType,
    weight: row.weight,
    lastCoactivated: row.last_coactivated ?? 0,
    coactivationCount: row.coactivation_count,
  };
}

function escapeFtsQuery(query: string): string {
  const tokens = query
    .replace(/"/g, '')
    .split(/[\s\p{P}]+/u)
    .filter((w) => w.length > 0);
  if (tokens.length === 0) return '';
  return tokens.map((word) => `"${word}"`).join(' OR ');
}

export class SqliteStorageProvider implements StorageProvider {
  private db: Database | null = null;
  private statements: Statement[] = [];
  private customPath?: string;

  private stmtGetNode!: Statement;
  private stmtPutNode!: Statement;
  private stmtDeleteNode!: Statement;
  private stmtGetEdgesOut!: Statement;
  private stmtGetEdgesIn!: Statement;
  private stmtGetEdgesBoth!: Statement;
  private stmtPutEdge!: Statement;
  private stmtDeleteEdge!: Statement;
  private stmtSearch!: Statement;
  private stmtAllNodes!: Statement;
  private stmtAllEdges!: Statement;
  private stmtNodeCount!: Statement;

  constructor(options?: { storagePath?: string }) {
    this.customPath = options?.storagePath;
  }

  async open(projectId: string): Promise<void> {
    if (this.db) return;

    const path = this.customPath || getStoragePath(projectId);
    mkdirSync(dirname(path), { recursive: true });

    const db = new Database(path, { create: true });
    db.exec('PRAGMA foreign_keys = ON');

    db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 0.5,
        strength REAL NOT NULL DEFAULT 1.0,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed INTEGER,
        created_at INTEGER NOT NULL,
        source_session TEXT,
        source_range TEXT,
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS synapses (
        src TEXT NOT NULL,
        dst TEXT NOT NULL,
        type TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 0.5,
        last_coactivated INTEGER,
        coactivation_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (src, dst, type)
      );

      CREATE INDEX IF NOT EXISTS idx_synapses_src ON synapses(src);
      CREATE INDEX IF NOT EXISTS idx_synapses_dst ON synapses(dst);
      CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
      CREATE INDEX IF NOT EXISTS idx_nodes_last_accessed ON nodes(last_accessed);

      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
        content,
        content='nodes',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
        INSERT INTO nodes_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
        INSERT INTO nodes_fts(nodes_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE OF content ON nodes BEGIN
        INSERT INTO nodes_fts(nodes_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO nodes_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `);

    this.db = db;

    this.stmtGetNode = this.prepare(`SELECT ${NODE_COLS} FROM nodes WHERE id = ?`);
    this.stmtPutNode = this.prepare(`
      INSERT INTO nodes (${NODE_COLS})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        content = excluded.content,
        importance = excluded.importance,
        strength = excluded.strength,
        access_count = excluded.access_count,
        last_accessed = excluded.last_accessed,
        created_at = excluded.created_at,
        source_session = excluded.source_session,
        source_range = excluded.source_range,
        metadata = excluded.metadata
    `);
    this.stmtDeleteNode = this.prepare('DELETE FROM nodes WHERE id = ?');

    this.stmtGetEdgesOut = this.prepare(`SELECT ${EDGE_COLS} FROM synapses WHERE src = ?`);
    this.stmtGetEdgesIn = this.prepare(`SELECT ${EDGE_COLS} FROM synapses WHERE dst = ?`);
    this.stmtGetEdgesBoth = this.prepare(
      `SELECT ${EDGE_COLS} FROM synapses WHERE src = ? OR dst = ?`,
    );
    this.stmtPutEdge = this.prepare(`
      INSERT INTO synapses (${EDGE_COLS})
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(src, dst, type) DO UPDATE SET
        weight = excluded.weight,
        last_coactivated = excluded.last_coactivated,
        coactivation_count = excluded.coactivation_count
    `);
    this.stmtDeleteEdge = this.prepare(
      'DELETE FROM synapses WHERE src = ? AND dst = ? AND type = ?',
    );

    this.stmtSearch = this.prepare(`
      SELECT ${NODE_COLS_PREFIXED}
      FROM nodes_fts f
      JOIN nodes n ON n.rowid = f.rowid
      WHERE nodes_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);

    this.stmtAllNodes = this.prepare(`SELECT ${NODE_COLS} FROM nodes`);
    this.stmtAllEdges = this.prepare(`SELECT ${EDGE_COLS} FROM synapses`);
    this.stmtNodeCount = this.prepare('SELECT COUNT(*) AS count FROM nodes');
  }

  async close(): Promise<void> {
    if (!this.db) return;
    for (const stmt of this.statements) {
      try {
        stmt.finalize();
      } catch {
        void 0;
      }
    }
    this.statements = [];
    this.db.close();
    this.db = null;
  }

  async getNode(id: string): Promise<MemoryNode | null> {
    const row = this.stmtGetNode.get(id) as NodeRow | null;
    return row ? rowToNode(row) : null;
  }

  async putNode(node: MemoryNode): Promise<void> {
    this.stmtPutNode.run(
      node.id,
      node.type,
      node.content,
      node.importance,
      node.strength,
      node.accessCount,
      node.lastAccessed ?? null,
      node.createdAt,
      node.sourceSession ?? null,
      node.sourceRange ? JSON.stringify(node.sourceRange) : null,
      node.metadata ? JSON.stringify(node.metadata) : null,
    );
  }

  async updateNode(id: string, updates: Partial<Omit<MemoryNode, 'id'>>): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(updates)) {
      const column = NODE_UPDATE_COLUMNS[key];
      if (!column) continue;
      fields.push(`${column} = ?`);
      if (key === 'sourceRange' || key === 'metadata') {
        values.push(value == null ? null : JSON.stringify(value));
      } else {
        values.push(value ?? null);
      }
    }

    if (fields.length === 0) return;
    values.push(id);
    const sql = `UPDATE nodes SET ${fields.join(', ')} WHERE id = ?`;
    this.requireDb().prepare(sql).run(...(values as never[]));
  }

  async deleteNode(id: string): Promise<void> {
    this.stmtDeleteNode.run(id);
  }

  async getNodesByIds(ids: string[]): Promise<MemoryNode[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const sql = `SELECT ${NODE_COLS} FROM nodes WHERE id IN (${placeholders})`;
    const rows = this.requireDb().prepare(sql).all(...(ids as never[])) as NodeRow[];
    return rows.map(rowToNode);
  }

  async queryNodes(filter: NodeFilter): Promise<MemoryNode[]> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filter.type !== undefined) {
      const types = Array.isArray(filter.type) ? filter.type : [filter.type];
      if (types.length > 0) {
        where.push(`type IN (${types.map(() => '?').join(',')})`);
        params.push(...types);
      }
    }
    if (filter.minImportance !== undefined) {
      where.push('importance >= ?');
      params.push(filter.minImportance);
    }
    if (filter.maxAge !== undefined) {
      where.push('created_at >= ?');
      params.push(Date.now() - filter.maxAge);
    }
    if (filter.sourceSession !== undefined) {
      where.push('source_session = ?');
      params.push(filter.sourceSession);
    }

    let sql = `SELECT ${NODE_COLS} FROM nodes`;
    if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
    if (filter.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }

    const rows = this.requireDb().prepare(sql).all(...(params as never[])) as NodeRow[];
    return rows.map(rowToNode);
  }

  async getEdges(
    nodeId: string,
    direction: 'in' | 'out' | 'both' = 'both',
  ): Promise<Synapse[]> {
    let rows: EdgeRow[];
    if (direction === 'out') {
      rows = this.stmtGetEdgesOut.all(nodeId) as EdgeRow[];
    } else if (direction === 'in') {
      rows = this.stmtGetEdgesIn.all(nodeId) as EdgeRow[];
    } else {
      rows = this.stmtGetEdgesBoth.all(nodeId, nodeId) as EdgeRow[];
    }
    return rows.map(rowToEdge);
  }

  async putEdge(edge: Synapse): Promise<void> {
    this.stmtPutEdge.run(
      edge.src,
      edge.dst,
      edge.type,
      edge.weight,
      edge.lastCoactivated ?? null,
      edge.coactivationCount,
    );
  }

  async updateEdge(
    src: string,
    dst: string,
    type: SynapseType,
    updates: Partial<Omit<Synapse, 'src' | 'dst' | 'type'>>,
  ): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(updates)) {
      const column = EDGE_UPDATE_COLUMNS[key];
      if (!column) continue;
      fields.push(`${column} = ?`);
      values.push(value ?? null);
    }

    if (fields.length === 0) return;
    values.push(src, dst, type);
    const sql = `UPDATE synapses SET ${fields.join(', ')} WHERE src = ? AND dst = ? AND type = ?`;
    this.requireDb().prepare(sql).run(...(values as never[]));
  }

  async deleteEdge(src: string, dst: string, type: SynapseType): Promise<void> {
    this.stmtDeleteEdge.run(src, dst, type);
  }

  async getEdgesBatch(
    nodeIds: string[],
    direction: 'in' | 'out' | 'both' = 'both',
  ): Promise<Synapse[]> {
    if (nodeIds.length === 0) return [];
    const placeholders = nodeIds.map(() => '?').join(',');

    let sql: string;
    let params: unknown[];
    if (direction === 'out') {
      sql = `SELECT ${EDGE_COLS} FROM synapses WHERE src IN (${placeholders})`;
      params = nodeIds;
    } else if (direction === 'in') {
      sql = `SELECT ${EDGE_COLS} FROM synapses WHERE dst IN (${placeholders})`;
      params = nodeIds;
    } else {
      sql = `SELECT ${EDGE_COLS} FROM synapses WHERE src IN (${placeholders}) OR dst IN (${placeholders})`;
      params = [...nodeIds, ...nodeIds];
    }

    const rows = this.requireDb().prepare(sql).all(...(params as never[])) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  async search(query: string, limit = 10): Promise<MemoryNode[]> {
    const ftsQuery = escapeFtsQuery(query);
    if (!ftsQuery) return [];
    const rows = this.stmtSearch.all(ftsQuery, limit) as NodeRow[];
    return rows.map(rowToNode);
  }

  async searchWithScores(query: string, limit = 10): Promise<Array<{ node: MemoryNode; score: number }>> {
    const ftsQuery = escapeFtsQuery(query);
    if (!ftsQuery) return [];
    const db = this.db!;
    const rows = db.prepare(`
      SELECT ${NODE_COLS_PREFIXED}, rank
      FROM nodes_fts f
      JOIN nodes n ON n.rowid = f.rowid
      WHERE nodes_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, limit) as (NodeRow & { rank: number })[];

    if (rows.length === 0) return [];

    const ranks = rows.map(r => r.rank);
    const bestRank = Math.min(...ranks);
    const worstRank = Math.max(...ranks);
    const range = worstRank - bestRank || 1;

    return rows.map((row) => ({
      node: rowToNode(row),
      score: 1 - (row.rank - bestRank) / range,
    }));
  }

  async getAllNodes(): Promise<MemoryNode[]> {
    const rows = this.stmtAllNodes.all() as NodeRow[];
    return rows.map(rowToNode);
  }

  async getAllEdges(): Promise<Synapse[]> {
    const rows = this.stmtAllEdges.all() as EdgeRow[];
    return rows.map(rowToEdge);
  }

  async getNodeCount(): Promise<number> {
    const row = this.stmtNodeCount.get() as { count: number };
    return row.count;
  }

  private prepare(sql: string): Statement {
    const stmt = this.requireDb().prepare(sql);
    this.statements.push(stmt);
    return stmt;
  }

  private requireDb(): Database {
    if (!this.db) throw new Error('SqliteStorageProvider: database is not open');
    return this.db;
  }

  getDb(): Database {
    return this.requireDb();
  }
}
