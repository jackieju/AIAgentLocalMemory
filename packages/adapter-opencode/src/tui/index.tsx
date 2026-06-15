/** @jsxImportSource @opentui/solid */
import { createSignal, onCleanup } from "solid-js"
import type { TuiPlugin, TuiSlotPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { execSync } from "node:child_process"
import { Database } from "bun:sqlite"

const VERSION = "0.4.1"

function rpcQuery(method: string): any {
  try {
    const { createConnection } = require("node:net")
    const conn = createConnection("/tmp/neural-context-rpc.sock")
    conn.write(JSON.stringify({ method }))
    const chunks: Buffer[] = []
    conn.on("data", (d: Buffer) => chunks.push(d))
    conn.end()
    const data = Buffer.concat(chunks).toString().trim()
    return data ? JSON.parse(data) : null
  } catch {
    return null
  }
}

function getServerBuild(): string {
  const rpcResult = rpcQuery("status")
  if (rpcResult?.build) return rpcResult.build
  try {
    const bnPath = "/tmp/neural-server-build.txt"
    if (existsSync(bnPath)) {
      const mtime = statSync(bnPath).mtime.getTime()
      if (Date.now() - mtime > 5 * 60 * 1000) return "?"
      return readFileSync(bnPath, "utf-8").trim()
    }
  } catch {}
  return "?"
}

const BUILD_NUMBER = getServerBuild()
const BUILD_TIME = (() => {
  try {
    const distPath = join(homedir(), "Desktop/ju/projects/AIAgentLocalMemory/packages/adapter-opencode/dist/index.js")
    if (existsSync(distPath)) {
      const mtime = statSync(distPath).mtime
      return mtime.toISOString().slice(0, 19).replace("T", " ")
    }
  } catch {}
  return "unknown"
})()

type Stats = {
  nodeCount: number
  edgeCount: number
  types: Record<string, number>
  workingMemory: number
  logLines: number
  syncRepo: string
  lastSync: string
  compartmentStatus: { ts: number; beforePct: number; afterPct: number; compartments: number } | null
}

function getStats(): Stats {
  const dataDir = join(homedir(), ".local/share/ai-agent-local-memory")
  const dbPath = join(dataDir, "graph.db")
  const syncDir = join(dataDir, "sync")
  const logFile = join(syncDir, "operations.jsonl")

  let nodeCount = 0
  let edgeCount = 0
  let workingMemory = 0
  const types: Record<string, number> = {}

  try {
    const db = new Database(dbPath, { readonly: true })
    nodeCount = (db.query("SELECT COUNT(*) as c FROM nodes").get() as { c: number }).c
    edgeCount = (db.query("SELECT COUNT(*) as c FROM synapses").get() as { c: number }).c
    const typeRows = db.query("SELECT type, COUNT(*) as c FROM nodes GROUP BY type").all() as Array<{ type: string; c: number }>
    for (const r of typeRows) types[r.type] = r.c
    try {
      workingMemory = (db.query("SELECT COUNT(*) as c FROM working_memory").get() as { c: number }).c
    } catch {}
    db.close()
  } catch {}

  let logLines = 0
  try {
    if (existsSync(logFile)) {
      const content = readFileSync(logFile, "utf-8").trim()
      logLines = content ? content.split("\n").length : 0
    }
  } catch {}

  let syncRepo = ""
  try {
    syncRepo = execSync("git remote get-url origin", { cwd: syncDir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {}

  let lastSync = ""
  try {
    const out = execSync("git log -1 --format=%ci", { cwd: syncDir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim()
    if (out) lastSync = out
  } catch {}

  let compartmentStatus: Stats["compartmentStatus"] = null
  try {
    const csPath = "/tmp/neural-compartment-status.json"
    if (existsSync(csPath)) {
      compartmentStatus = JSON.parse(readFileSync(csPath, "utf-8"))
    }
  } catch {}

  return { nodeCount, edgeCount, types, workingMemory, logLines, syncRepo, lastSync, compartmentStatus }
}

function formatRepo(url: string): string {
  if (!url) return "not configured"
  return url
    .replace(/^git@github\.com:/, "gh:")
    .replace(/^https:\/\/github\.com\//, "gh:")
    .replace(/\.git$/, "")
}

function formatLastSync(iso: string): string {
  if (!iso) return "never"
  const date = new Date(iso)
  if (isNaN(date.getTime())) return iso
  const diffMs = Date.now() - date.getTime()
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function createSidebarSlot(_api: TuiPluginApi): TuiSlotPlugin {
  return {
    order: 200,
    slots: {
      sidebar_content: (props) => {
        const [stats, setStats] = createSignal<Stats>(getStats())

        const timer = setInterval(() => setStats(getStats()), 30000)
        onCleanup(() => clearInterval(timer))

        return (
          <box flexDirection="column" paddingLeft={1} paddingRight={1}>
            <text bold fg="#60a5fa">◆ Neural Memory</text>
            <text fg="#475569">─────────────────</text>
            <text fg="#34d399">Nodes: {stats().nodeCount}</text>
            <text fg="#94a3b8">
              {Object.entries(stats().types)
                .map(([t, c]) => `  ${t}: ${c}`)
                .join("\n") || "  (empty)"}
            </text>
            <text fg="#fbbf24">Edges: {stats().edgeCount}</text>
            <text fg="#a78bfa">WM: {stats().workingMemory}</text>
            <text fg="#475569">─────────────────</text>
            <text bold fg="#c084fc">◆ Sync</text>
            <text fg="#94a3b8">Ops: {stats().logLines}</text>
            <text fg="#94a3b8">Last: {formatLastSync(stats().lastSync)}</text>
            <text fg="#22d3ee">{formatRepo(stats().syncRepo)}</text>
            <text fg="#475569">─────────────────</text>
            <text bold fg="#f472b6">◆ Session</text>
            <text fg="#94a3b8">{props.session_id ? props.session_id.slice(0, 12) : "—"}</text>
            <text fg="#475569">─────────────────</text>
            <text bold fg="#fb923c">◆ Compartments</text>
            <text fg="#94a3b8">{stats().compartmentStatus
              ? `${stats().compartmentStatus!.afterPct}%/${stats().compartmentStatus!.beforePct}%  ${formatLastSync(new Date(stats().compartmentStatus!.ts).toISOString())}  (${stats().compartmentStatus!.compartments})`
              : "no data"}</text>
            <text fg="#475569">─────────────────</text>
            <text fg="#64748b">v{VERSION} b{BUILD_NUMBER} | {BUILD_TIME}</text>
          </box>
        )
      },
    },
  }
}

const id = "ai-agent-local-memory"

const tui: TuiPlugin = async (api) => {
  api.slots.register(createSidebarSlot(api))
}

export default { id, tui }
