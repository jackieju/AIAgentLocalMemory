/** @jsxImportSource @opentui/solid */
// @ts-nocheck
import { effect as _$effect } from "opentui:runtime-module:%40opentui%2Fsolid";
import { memo as _$memo } from "opentui:runtime-module:%40opentui%2Fsolid";
import { insert as _$insert } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createTextNode as _$createTextNode } from "opentui:runtime-module:%40opentui%2Fsolid";
import { insertNode as _$insertNode } from "opentui:runtime-module:%40opentui%2Fsolid";
import { setProp as _$setProp } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createElement as _$createElement } from "opentui:runtime-module:%40opentui%2Fsolid";
/** @jsxImportSource @opentui/solid */
import { createSignal, onCleanup } from "opentui:runtime-module:solid-js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
let Database = null;
try {
  Database = require("bun:sqlite").Database;
} catch {
  try {
    Database = require("better-sqlite3");
  } catch {}
}
const VERSION = "0.4.1";
function getServerBuild() {
  try {
    const bnPath = "/tmp/neural-server-build.txt";
    if (existsSync(bnPath)) {
      return readFileSync(bnPath, "utf-8").trim();
    }
  } catch {}
  return "?";
}
function getStats() {
  const dataDir = join(homedir(), ".local/share/ai-agent-local-memory");
  const dbPath = join(dataDir, "graph.db");
  const syncDir = join(dataDir, "sync");
  const logFile = join(syncDir, "operations.jsonl");
  let nodeCount = 0;
  let edgeCount = 0;
  let workingMemory = 0;
  const types = {};
  try {
    if (!Database) throw new Error("no sqlite");
    const db = new Database(dbPath, {
      readonly: true
    });
    nodeCount = db.query("SELECT COUNT(*) as c FROM nodes").get().c;
    edgeCount = db.query("SELECT COUNT(*) as c FROM synapses").get().c;
    const typeRows = db.query("SELECT type, COUNT(*) as c FROM nodes GROUP BY type").all();
    for (const r of typeRows) types[r.type] = r.c;
    try {
      workingMemory = db.query("SELECT COUNT(*) as c FROM working_memory").get().c;
    } catch {}
    db.close();
  } catch {}
  let logLines = 0;
  try {
    if (existsSync(logFile)) {
      const content = readFileSync(logFile, "utf-8").trim();
      logLines = content ? content.split("\n").length : 0;
    }
  } catch {}
  let syncRepo = "";
  try {
    syncRepo = execSync("git remote get-url origin", {
      cwd: syncDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {}
  let lastSync = "";
  try {
    const out = execSync("git log -1 --format=%ci", {
      cwd: syncDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (out) lastSync = out;
  } catch {}
  let compartmentStatus = null;
  try {
    const csPath = "/tmp/neural-compartment-status.json";
    if (existsSync(csPath)) {
      compartmentStatus = JSON.parse(readFileSync(csPath, "utf-8"));
    }
  } catch {}
  let training = null;
  try {
    const histPath = join(dataDir, "train-history.json");
    if (existsSync(histPath)) {
      const h = JSON.parse(readFileSync(histPath, "utf-8"));
      const lastRun = h.runs?.length > 0 ? h.runs[h.runs.length - 1] : null;
      training = {
        lastTime: lastRun?.timestamp || "never",
        lastResult: lastRun?.improved ? "improved" : "degraded",
        totalRuns: h.totalRuns || 0,
        improved: h.improved || 0
      };
    }
  } catch {}
  let trainingInProgress = false;
  try {
    const flagPath = join(dataDir, ".training-in-progress");
    if (existsSync(flagPath)) {
      const started = parseInt(readFileSync(flagPath, "utf-8")) || 0;
      trainingInProgress = Date.now() - started < 600000;
    }
  } catch {}
  return {
    nodeCount,
    edgeCount,
    types,
    workingMemory,
    logLines,
    syncRepo,
    lastSync,
    compartmentStatus,
    build: getServerBuild(),
    training,
    trainingInProgress
  };
}
function formatRepo(url) {
  if (!url) return "not configured";
  return url.replace(/^git@github\.com:/, "gh:").replace(/^https:\/\/github\.com\//, "gh:").replace(/\.git$/, "");
}
function formatLastSync(iso) {
  if (!iso) return "never";
  const date = new Date(iso);
  if (isNaN(date.getTime())) return iso;
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
function createSidebarSlot(api) {
  return {
    order: 200,
    slots: {
      sidebar_content: props => {
        const [stats, setStats] = createSignal(getStats());
        const timer = setInterval(() => setStats(getStats()), 30000);
        onCleanup(() => clearInterval(timer));
        return (() => {
          var _el$ = _$createElement("box"),
            _el$2 = _$createElement("text"),
            _el$4 = _$createElement("text"),
            _el$6 = _$createElement("text"),
            _el$7 = _$createTextNode(`Nodes: `),
            _el$8 = _$createElement("text"),
            _el$9 = _$createElement("text"),
            _el$0 = _$createTextNode(`Edges: `),
            _el$1 = _$createElement("text"),
            _el$10 = _$createTextNode(`WM: `),
            _el$11 = _$createElement("text"),
            _el$13 = _$createElement("text"),
            _el$15 = _$createElement("text"),
            _el$16 = _$createTextNode(`Ops: `),
            _el$17 = _$createElement("text"),
            _el$18 = _$createTextNode(`Last: `),
            _el$19 = _$createElement("text"),
            _el$20 = _$createElement("text"),
            _el$22 = _$createElement("text"),
            _el$24 = _$createElement("text"),
            _el$25 = _$createElement("text"),
            _el$27 = _$createElement("text"),
            _el$29 = _$createElement("text"),
            _el$30 = _$createElement("text"),
            _el$32 = _$createElement("text"),
            _el$34 = _$createElement("text"),
            _el$35 = _$createElement("text"),
            _el$36 = _$createElement("text"),
            _el$38 = _$createElement("text"),
            _el$39 = _$createTextNode(`v0.4.1 b`);
          _$insertNode(_el$, _el$2);
          _$insertNode(_el$, _el$4);
          _$insertNode(_el$, _el$6);
          _$insertNode(_el$, _el$8);
          _$insertNode(_el$, _el$9);
          _$insertNode(_el$, _el$1);
          _$insertNode(_el$, _el$11);
          _$insertNode(_el$, _el$13);
          _$insertNode(_el$, _el$15);
          _$insertNode(_el$, _el$17);
          _$insertNode(_el$, _el$19);
          _$insertNode(_el$, _el$20);
          _$insertNode(_el$, _el$22);
          _$insertNode(_el$, _el$24);
          _$insertNode(_el$, _el$25);
          _$insertNode(_el$, _el$27);
          _$insertNode(_el$, _el$29);
          _$insertNode(_el$, _el$30);
          _$insertNode(_el$, _el$32);
          _$insertNode(_el$, _el$34);
          _$insertNode(_el$, _el$35);
          _$insertNode(_el$, _el$36);
          _$insertNode(_el$, _el$38);
          _$setProp(_el$, "flexDirection", "column");
          _$setProp(_el$, "paddingLeft", 1);
          _$setProp(_el$, "paddingRight", 1);
          _$insertNode(_el$2, _$createTextNode(`◆ Neural Memory`));
          _$setProp(_el$2, "bold", true);
          _$setProp(_el$2, "fg", "#2888ff");
          _$insertNode(_el$4, _$createTextNode(`─────────────────`));
          _$setProp(_el$4, "fg", "#2c3b51");
          _$insertNode(_el$6, _el$7);
          _$setProp(_el$6, "fg", "#1bb97f");
          _$insert(_el$6, () => stats().nodeCount, null);
          _$setProp(_el$8, "fg", "#6a87af");
          _$insert(_el$8, () => Object.entries(stats().types).map(([t, c]) => `  ${t}: ${c}`).join("\n") || "  (empty)");
          _$insertNode(_el$9, _el$0);
          _$setProp(_el$9, "fg", "#ecaa00");
          _$insert(_el$9, () => stats().edgeCount, null);
          _$insertNode(_el$1, _el$10);
          _$setProp(_el$1, "fg", "#7e53ff");
          _$insert(_el$1, () => stats().workingMemory, null);
          _$insertNode(_el$11, _$createTextNode(`─────────────────`));
          _$setProp(_el$11, "fg", "#2c3b51");
          _$insertNode(_el$13, _$createTextNode(`◆ Sync`));
          _$setProp(_el$13, "bold", true);
          _$setProp(_el$13, "fg", "#a64eff");
          _$insertNode(_el$15, _el$16);
          _$setProp(_el$15, "fg", "#6a87af");
          _$insert(_el$15, () => stats().logLines, null);
          _$insertNode(_el$17, _el$18);
          _$setProp(_el$17, "fg", "#6a87af");
          _$insert(_el$17, () => formatLastSync(stats().lastSync), null);
          _$setProp(_el$19, "fg", "#05bcd8");
          _$insert(_el$19, () => formatRepo(stats().syncRepo));
          _$insertNode(_el$20, _$createTextNode(`─────────────────`));
          _$setProp(_el$20, "fg", "#2c3b51");
          _$insertNode(_el$22, _$createTextNode(`◆ Session`));
          _$setProp(_el$22, "bold", true);
          _$setProp(_el$22, "fg", "#fa399e");
          _$setProp(_el$24, "fg", "#6a87af");
          _$insert(_el$24, (() => {
            var _c$ = _$memo(() => !!props.session_id);
            return () => _c$() ? props.session_id.slice(0, 12) : "—";
          })());
          _$insertNode(_el$25, _$createTextNode(`─────────────────`));
          _$setProp(_el$25, "fg", "#2c3b51");
          _$insertNode(_el$27, _$createTextNode(`◆ Compartments`));
          _$setProp(_el$27, "bold", true);
          _$setProp(_el$27, "fg", "#ff7605");
          _$setProp(_el$29, "fg", "#6a87af");
          _$insert(_el$29, (() => {
            var _c$2 = _$memo(() => !!stats().compartmentStatus);
            return () => _c$2() ? `${stats().compartmentStatus.afterPct}%/${stats().compartmentStatus.beforePct}%  ${formatLastSync(new Date(stats().compartmentStatus.ts).toISOString())}  (${stats().compartmentStatus.compartments})` : "no data";
          })());
          _$insertNode(_el$30, _$createTextNode(`─────────────────`));
          _$setProp(_el$30, "fg", "#2c3b51");
          _$insertNode(_el$32, _$createTextNode(`◆ LoRA Training`));
          _$setProp(_el$32, "bold", true);
          _$setProp(_el$32, "fg", "#e640ff");
          _$insert(_el$34, (() => {
            var _c$3 = _$memo(() => !!stats().trainingInProgress);
            return () => _c$3() ? "⏳ Training in progress..." : _$memo(() => !!stats().training)() ? `Last: ${formatLastSync(stats().training.lastTime)} ${stats().training.lastResult === "improved" ? "✓" : "✗"}` : "no training yet";
          })());
          _$setProp(_el$35, "fg", "#6a87af");
          _$insert(_el$35, (() => {
            var _c$4 = _$memo(() => !!stats().training);
            return () => _c$4() ? `Runs: ${stats().training.totalRuns}  Improved: ${stats().training.improved}/${stats().training.totalRuns}` : "";
          })());
          _$insertNode(_el$36, _$createTextNode(`─────────────────`));
          _$setProp(_el$36, "fg", "#2c3b51");
          _$insertNode(_el$38, _el$39);
          _$setProp(_el$38, "fg", "#455a77");
          _$insert(_el$38, () => stats().build, null);
          _$effect(_$p => _$setProp(_el$34, "fg", stats().trainingInProgress ? "#ecaa00" : "#6a87af", _$p));
          return _el$;
        })();
      }
    }
  };
}
const id = "ai-agent-local-memory";
const tui = async api => {
  api.slots.register(createSidebarSlot(api));
};
export default {
  id,
  tui
};
