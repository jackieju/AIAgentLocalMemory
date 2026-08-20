#!/usr/bin/env bun
/**
 * Neural Memory Dashboard — local web UI for managing the memory graph.
 *
 * A single self-contained Bun HTTP server that talks directly to
 * SqliteStorageProvider (graph.db) and OperationLog (sync/operations.jsonl).
 *
 * Features:
 *   - Read-only stats (node/edge counts, type & layer distribution, sync state)
 *   - Node browse + FTS search + neighbor inspection
 *   - Node / edge edit + delete
 *   - One-way merge from a Git URL or a local operations.jsonl file
 *   - Character portrait summary (culture orientation + personality prefs)
 *
 * Usage:
 *   bun run src/server.ts [--port 7000] [--host 127.0.0.1]
 *   AI_AGENT_LOCAL_MEMORY_DIR=/path bun run src/server.ts
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { SqliteStorageProvider } from "@ai-agent-local-memory/storage-sqlite";
import type { MemoryNode, Synapse, SynapseType, NodeType } from "@ai-agent-local-memory/core";
import { renderHtml } from "./ui.ts";


function dataDir(): string {
  if (process.env.AI_AGENT_LOCAL_MEMORY_DIR) return process.env.AI_AGENT_LOCAL_MEMORY_DIR;
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "ai-agent-local-memory");
}

const DATA_DIR = dataDir();
const SYNC_DIR = join(DATA_DIR, "sync");
const OPS_LOG = join(SYNC_DIR, "operations.jsonl");


const LAYER_DEPTH: Record<string, number> = {
  worldview: 1.0,
  cultural_norm: 0.8,
  interpersonal_style: 0.55,
  work_habit: 0.35,
  surface_pref: 0.15,
};
const CHARACTER_LAYERS = new Set(Object.keys(LAYER_DEPTH));

function characterMeta(node: any): {
  layer: string;
  observationCount: number;
  confidence: number;
  reviewStatus: string;
  source: string;
  evidence: string;
} {
  const cd = (node?.metadata?.characterData ?? {}) as Record<string, unknown>;
  const layer = typeof cd.layer === "string" && CHARACTER_LAYERS.has(cd.layer) ? cd.layer : "surface_pref";
  const observationCount = typeof cd.observationCount === "number" ? cd.observationCount : 1;
  const confidence = typeof cd.confidence === "number" ? cd.confidence : 0.6;
  const reviewStatus = typeof cd.reviewStatus === "string" ? cd.reviewStatus : "ready";
  const source = typeof cd.source === "string" ? cd.source : "organic";
  const evidence = typeof cd.evidence === "string" ? cd.evidence : "";
  return { layer, observationCount, confidence, reviewStatus, source, evidence };
}


const storage = new SqliteStorageProvider({ storagePath: join(DATA_DIR, "graph.db") });
await storage.open("global");

function db() {
  return storage.getDb();
}


function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}


function getStats() {
  const d = db();
  const nodeCount = (d.prepare("SELECT COUNT(*) AS c FROM nodes").get() as { c: number }).c;
  const edgeCount = (d.prepare("SELECT COUNT(*) AS c FROM synapses").get() as { c: number }).c;

  const byType = (d.prepare("SELECT type, COUNT(*) AS c FROM nodes GROUP BY type ORDER BY c DESC").all() as {
    type: string;
    c: number;
  }[]).map((r) => ({ type: r.type, count: r.c }));

  const byEdgeType = (d.prepare("SELECT type, COUNT(*) AS c FROM synapses GROUP BY type ORDER BY c DESC").all() as {
    type: string;
    c: number;
  }[]).map((r) => ({ type: r.type, count: r.c }));

  const charRows = d
    .prepare("SELECT metadata FROM nodes WHERE type IN ('value','culture')")
    .all() as { metadata: string | null }[];
  const byLayer: Record<string, number> = {};
  for (const r of charRows) {
    let cd: any = {};
    try {
      cd = r.metadata ? JSON.parse(r.metadata).characterData ?? {} : {};
    } catch {}
    const layer = typeof cd.layer === "string" && CHARACTER_LAYERS.has(cd.layer) ? cd.layer : "surface_pref";
    byLayer[layer] = (byLayer[layer] ?? 0) + 1;
  }

  let dbSizeBytes = 0;
  try {
    dbSizeBytes = statSync(join(DATA_DIR, "graph.db")).size;
  } catch {}

  return {
    nodeCount,
    edgeCount,
    byType,
    byEdgeType,
    byLayer,
    dbSizeBytes,
    dataDir: DATA_DIR,
  };
}


function getSyncStatus() {
  const hasGit = existsSync(join(SYNC_DIR, ".git"));
  let opsLines = 0;
  let opsBytes = 0;
  if (existsSync(OPS_LOG)) {
    try {
      const raw = readFileSync(OPS_LOG, "utf-8");
      opsBytes = Buffer.byteLength(raw, "utf-8");
      opsLines = raw.length === 0 ? 0 : raw.split("\n").filter((l) => l.length > 0).length;
    } catch {}
  }

  let remote = "";
  let lastCommit = "";
  let lastCommitTs = 0;
  let pending = 0;
  if (hasGit) {
    try {
      remote = execSync("git remote get-url origin", { cwd: SYNC_DIR, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {}
    try {
      const line = execSync('git log -1 --format="%h|%ci|%s"', { cwd: SYNC_DIR, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      const [hash, ci, ...subj] = line.split("|");
      lastCommit = `${hash} ${subj.join("|")}`;
      lastCommitTs = ci ? new Date(ci).getTime() : 0;
    } catch {}
    try {
      const status = execSync("git status --porcelain", { cwd: SYNC_DIR, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
      pending = status.trim().length > 0 ? status.trim().split("\n").length : 0;
    } catch {}
  }

  return {
    syncDir: SYNC_DIR,
    hasGit,
    remote,
    opsLines,
    opsBytes,
    lastCommit,
    lastCommitTs,
    pendingChanges: pending,
  };
}


async function listNodes(params: URLSearchParams) {
  const type = params.get("type");
  const q = params.get("q");
  const limit = Math.min(500, Math.max(1, parseInt(params.get("limit") || "50", 10) || 50));

  if (q && q.trim().length > 0) {
    const results = await storage.search(q.trim(), limit);
    return results.filter((n) => !type || n.type === type).map(nodeSummary);
  }

  const d = db();
  const rows = type
    ? (d.prepare("SELECT id FROM nodes WHERE type = ? ORDER BY created_at DESC LIMIT ?").all(type, limit) as { id: string }[])
    : (d.prepare("SELECT id FROM nodes ORDER BY created_at DESC LIMIT ?").all(limit) as { id: string }[]);
  const nodes = await storage.getNodesByIds(rows.map((r) => r.id));
  // getNodesByIds does not preserve order; re-sort by createdAt desc
  nodes.sort((a, b) => b.createdAt - a.createdAt);
  return nodes.map(nodeSummary);
}

function nodeSummary(n: MemoryNode) {
  return {
    id: n.id,
    type: n.type,
    content: n.content.length > 200 ? n.content.slice(0, 200) + "…" : n.content,
    importance: n.importance,
    strength: n.strength,
    accessCount: n.accessCount,
    createdAt: n.createdAt,
    lastAccessed: n.lastAccessed,
    sourceSession: n.sourceSession,
  };
}

async function nodeDetail(id: string) {
  const node = await storage.getNode(id);
  if (!node) return null;
  const neighbors = await storage.getEdges(id, "both");
  const neighborIds = new Set<string>();
  for (const e of neighbors) {
    neighborIds.add(e.src === id ? e.dst : e.src);
  }
  const neighborNodes = await storage.getNodesByIds([...neighborIds]);
  const byId = new Map(neighborNodes.map((n) => [n.id, n]));

  const edges = neighbors.map((e) => {
    const otherId = e.src === id ? e.dst : e.src;
    const other = byId.get(otherId);
    return {
      src: e.src,
      dst: e.dst,
      type: e.type,
      weight: e.weight,
      direction: e.src === id ? "out" : "in",
      otherId,
      otherContent: other ? (other.content.length > 100 ? other.content.slice(0, 100) + "…" : other.content) : "(missing)",
      otherType: other?.type ?? "?",
    };
  });

  return { node, edges };
}


async function updateNode(id: string, body: any) {
  const node = await storage.getNode(id);
  if (!node) return { error: "node not found", status: 404 };
  const updates: Partial<Omit<MemoryNode, "id">> = {};
  if (typeof body.content === "string") updates.content = body.content;
  if (typeof body.importance === "number") updates.importance = Math.max(0, Math.min(1, body.importance));
  if (typeof body.type === "string") updates.type = body.type as NodeType;
  if (Object.keys(updates).length === 0) return { error: "no valid fields to update", status: 400 };
  await storage.updateNode(id, updates);
  return { ok: true, node: await storage.getNode(id) };
}

async function deleteNode(id: string) {
  const node = await storage.getNode(id);
  if (!node) return { error: "node not found", status: 404 };
  await storage.deleteNode(id);
  return { ok: true };
}

async function deleteEdge(src: string, dst: string, type: string) {
  await storage.deleteEdge(src, dst, type as SynapseType);
  return { ok: true };
}


async function replayOpsFile(logPath: string) {
  const raw = readFileSync(logPath, "utf-8").trim();
  const lines = raw.length > 0 ? raw.split("\n").filter(Boolean) : [];
  let applied = 0;
  let failed = 0;
  for (const line of lines) {
    let op: any;
    try {
      op = JSON.parse(line);
    } catch {
      failed++;
      continue;
    }
    try {
      switch (op.op) {
        case "add_node":
          await storage.putNode(op.data);
          applied++;
          break;
        case "update_node":
          await storage.updateNode(op.data.id, op.data.updates);
          applied++;
          break;
        case "delete_node":
          await storage.deleteNode(op.data.id);
          applied++;
          break;
        case "add_edge":
          await storage.putEdge(op.data);
          applied++;
          break;
        case "update_edge":
          await storage.updateEdge(op.data.src, op.data.dst, op.data.type, op.data.updates);
          applied++;
          break;
        case "delete_edge":
          await storage.deleteEdge(op.data.src, op.data.dst, op.data.type);
          applied++;
          break;
        default:
          break;
      }
    } catch {
      failed++;
    }
  }
  return { applied, failed, totalLines: lines.length };
}

async function importFromGit(repoUrl: string) {
  const tmpBase = mkdtempSync(join(tmpdir(), "neural-dash-import-"));
  try {
    execSync(`git clone --depth 1 ${JSON.stringify(repoUrl)} ${JSON.stringify(tmpBase)}`, { stdio: "ignore" });
    const theirLog = join(tmpBase, "operations.jsonl");
    if (!existsSync(theirLog)) {
      return { error: "cloned repo has no operations.jsonl (the owner must run neural_sync export+push first)", status: 400 };
    }
    const result = await replayOpsFile(theirLog);
    return { ok: true, source: repoUrl, ...result };
  } catch (e: any) {
    return { error: e.message || String(e), status: 500 };
  } finally {
    try {
      rmSync(tmpBase, { recursive: true, force: true });
    } catch {}
  }
}

async function importFromFile(filePath: string) {
  if (!existsSync(filePath)) return { error: `file not found: ${filePath}`, status: 400 };
  try {
    const result = await replayOpsFile(filePath);
    return { ok: true, source: filePath, ...result };
  } catch (e: any) {
    return { error: e.message || String(e), status: 500 };
  }
}


const WESTERN_HINTS = ["individual", "individualism", "自主", "自我", "个人", "自由", "efficiency", "直接", "assertive", "explicit", "self", "autonomy", "privacy"];
const EASTERN_HINTS = ["集体", "关系", "面子", "和谐", "含蓄", "谦", "礼", "群体", "harmony", "collective", "relationship", "hierarchy", "长幼", "family", "家"];
const MODERN_HINTS = ["敏捷", "迭代", "自动化", "async", "tooling", "ci", "devops", "现代", "workflow", "productivity", "效率", "自动"];
const CLASSICAL_HINTS = ["传统", "经典", "古典", "礼仪", "classical", "ritual", "heritage", "history", "史", "古", "典籍"];

function scoreHints(text: string, hints: string[]): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const h of hints) {
    if (lower.includes(h.toLowerCase())) score++;
  }
  return score;
}

function getPortrait() {
  const d = db();
  const rows = d.prepare("SELECT id, type, content, importance, strength, access_count, last_accessed, created_at, metadata FROM nodes WHERE type IN ('value','culture')").all() as any[];

  const traits = rows.map((r) => {
    const node: any = {
      id: r.id,
      type: r.type,
      content: r.content,
      importance: r.importance,
      strength: r.strength,
      accessCount: r.access_count,
      lastAccessed: r.last_accessed,
      createdAt: r.created_at,
      metadata: r.metadata ? safeParse(r.metadata) : {},
    };
    const meta = characterMeta(node);
    return {
      id: node.id,
      type: node.type,
      content: node.content,
      importance: node.importance,
      ...meta,
      depth: LAYER_DEPTH[meta.layer] ?? 0.15,
    };
  });

  let westScore = 0;
  let eastScore = 0;
  let modernScore = 0;
  let classicalScore = 0;
  for (const t of traits) {
    const w = t.depth * t.confidence;
    westScore += scoreHints(t.content, WESTERN_HINTS) * w;
    eastScore += scoreHints(t.content, EASTERN_HINTS) * w;
    modernScore += scoreHints(t.content, MODERN_HINTS) * w;
    classicalScore += scoreHints(t.content, CLASSICAL_HINTS) * w;
  }

  function axis(a: number, b: number, labelA: string, labelB: string): { label: string; lean: number } {
    const total = a + b;
    if (total === 0) return { label: "未知（样本不足）", lean: 0 };
    const lean = (a - b) / total; // -1..1, positive → labelA
    if (Math.abs(lean) < 0.15) return { label: `均衡（${labelA}/${labelB}兼有）`, lean };
    return { label: lean > 0 ? labelA : labelB, lean };
  }

  const cultureAxis = axis(eastScore, westScore, "偏东方/集体取向", "偏西方/个人取向");
  const eraAxis = axis(classicalScore, modernScore, "偏古典/传统", "偏现代/工具化");

  const layerCounts: Record<string, number> = {};
  for (const t of traits) layerCounts[t.layer] = (layerCounts[t.layer] ?? 0) + 1;

  const topTraits = [...traits]
    .sort((a, b) => b.depth * b.confidence * b.importance - a.depth * a.confidence * a.importance)
    .slice(0, 8)
    .map((t) => ({
      type: t.type,
      layer: t.layer,
      confidence: t.confidence,
      content: t.content.length > 160 ? t.content.slice(0, 160) + "…" : t.content,
    }));

  const sampleCount = traits.length;
  const enough = sampleCount >= 3;

  return {
    sampleCount,
    enough,
    cultureAxis,
    eraAxis,
    layerCounts,
    topTraits,
    scores: {
      east: round(eastScore),
      west: round(westScore),
      classical: round(classicalScore),
      modern: round(modernScore),
    },
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}


async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/" || path === "/index.html") {
    return new Response(renderHtml(), { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  try {
    if (path === "/api/stats" && req.method === "GET") return json(getStats());
    if (path === "/api/sync" && req.method === "GET") return json(getSyncStatus());
    if (path === "/api/portrait" && req.method === "GET") return json(getPortrait());

    if (path === "/api/nodes" && req.method === "GET") return json(await listNodes(url.searchParams));

    if (path.startsWith("/api/node/") && req.method === "GET") {
      const id = decodeURIComponent(path.slice("/api/node/".length));
      const detail = await nodeDetail(id);
      if (!detail) return err("node not found", 404);
      return json(detail);
    }

    if (path.startsWith("/api/node/") && req.method === "PATCH") {
      const id = decodeURIComponent(path.slice("/api/node/".length));
      const body = await req.json().catch(() => ({}));
      const r = await updateNode(id, body);
      if (r.error) return err(r.error, r.status);
      return json(r);
    }

    if (path.startsWith("/api/node/") && req.method === "DELETE") {
      const id = decodeURIComponent(path.slice("/api/node/".length));
      const r = await deleteNode(id);
      if (r.error) return err(r.error, r.status);
      return json(r);
    }

    if (path === "/api/edge" && req.method === "DELETE") {
      const body = await req.json().catch(() => ({}));
      if (!body.src || !body.dst || !body.type) return err("src, dst, type required");
      return json(await deleteEdge(body.src, body.dst, body.type));
    }

    if (path === "/api/import" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      let r: any;
      if (body.repoUrl) r = await importFromGit(String(body.repoUrl));
      else if (body.filePath) r = await importFromFile(String(body.filePath));
      else return err("repoUrl or filePath required");
      if (r.error) return err(r.error, r.status || 500);
      return json(r);
    }

    return err("not found", 404);
  } catch (e: any) {
    return err(e.message || String(e), 500);
  }
}


function parseArgs(): { port: number; host: string } {
  const args = process.argv.slice(2);
  let port = 7077;
  let host = "127.0.0.1";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) port = parseInt(args[++i], 10) || port;
    else if (args[i] === "--host" && args[i + 1]) host = args[++i];
  }
  return { port, host };
}

const { port, host } = parseArgs();

const server = Bun.serve({
  port,
  hostname: host,
  fetch: handle,
});

console.log(`\n  Neural Memory Dashboard`);
console.log(`  ────────────────────────`);
console.log(`  Data dir : ${DATA_DIR}`);
console.log(`  Sync dir : ${SYNC_DIR}`);
console.log(`  URL      : http://${host}:${server.port}\n`);
