import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, statSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Plugin, Hooks } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { NeuralContextEngine, ContextRenderer, NeuralGraph, WorkingMemory, OpenAICompatibleLLM, OpenAICompatibleEmbedding, OllamaLLM, OllamaEmbedding, EmbeddingLinker, OperationLog, LoggedStorageProvider, Historian, LightweightLinker } from "@ai-agent-local-memory/core";
import type { NodeType, RecallResult, MemoryNode, ContextRenderConfig, EpisodicData, LLMProvider, EmbeddingProvider, Compartment } from "@ai-agent-local-memory/core";
import { SqliteStorageProvider, CompartmentStore } from "@ai-agent-local-memory/storage-sqlite";
import { Tokenizer } from "ai-tokenizer";
import * as claudeEncoding from "ai-tokenizer/encoding/claude";

// Real Claude BPE tokenizer (same approach as magic-context). A char/4 + CJK
// heuristic mis-measures the conversation bucket — it over-counts prose ~4x and
// under-counts JSON/base64/CJK tool blobs, so no single fudge factor works. Using
// the actual tokenizer removes the guesswork that caused both over-compression and
// the 67K-estimate/214K-wire "Input is too long" overflow.
const claudeTokenizer = new Tokenizer(claudeEncoding as any);

// ai-tokenizer's `claude` encoding is the OLD Claude tokenizer. Opus 4.7+, Sonnet 5,
// Fable/Mythos 5 switched to a NEW tokenizer that produces ~30% more tokens for the same
// text (per Anthropic's pricing docs). Upstream ai-tokenizer (1.0.6, latest) ships no
// separate encoding for it, so we compensate: multiply the old-encoding count by ~1.3 when
// the active model uses the new tokenizer. Without this the tail budget under-counts ~30%
// on 4.8 and overflows the context ("Input is too long"). Updated via setActiveTokenizerModel().
let newTokenizerMultiplier = 1.0;
const NEW_TOKENIZER_PATTERN = /(opus-4[.-](?:[7-9]|1[0-9])|claude-4[.-](?:[7-9]|1[0-9])-opus|sonnet-5|haiku-5|claude-fable|claude-mythos|fable-5|mythos-5)/i;
function setActiveTokenizerModel(modelKey: string | undefined | null): void {
  newTokenizerMultiplier = modelKey && NEW_TOKENIZER_PATTERN.test(modelKey) ? 1.3 : 1.0;
}
function countClaudeTokens(text: string): number {
  if (!text) return 0;
  try { return Math.ceil(claudeTokenizer.encode(text, [], "all").length * newTokenizerMultiplier); }
  catch { return Math.ceil((text.length / 4) * newTokenizerMultiplier); }
}

interface PluginConfig {
  injectSystemPrompt?: boolean;
  contextWindowTokens?: number;
  budgetRatio?: number;
  protectedTags?: number;
  systemToolsReservePct?: number;
  coexistWithOtherContextManager?: boolean;
  syncRepo?: string;
  recallStrategy?: "plugin" | "llm";
  readExtractBackend?: "server" | "local";
  llm?: {
    provider: "openai" | "ollama" | "custom";
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  };
  embedding?: {
    provider: "openai" | "ollama" | "custom";
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  };
  localLlm?: {
    provider: "ollama" | "openai" | "custom";
    endpoint?: string;
    model?: string;
    apiKey?: string;
    mode: "observer" | "student" | "primary";
    confidence?: {
      userThreshold?: number;
      autoEscalateAfter?: number;
    };
    training?: {
      triggerCount?: number;
      cotStrategy?: "thinking-tag" | "post-rewrite" | "none";
    };
  };
  // When the session goes idle, the agent may proactively ask the user for
  // learning material to feed into neural_read ("agent asks to read a book").
  idleReadingPrompt?: {
    enabled?: boolean;      // default true — set false to fully opt out
    minIntervalMs?: number; // min gap between prompts per session (default 1h)
    maxPerDay?: number;     // per-session daily cap (default 3)
  };
}

function loadConfig(directory: string): PluginConfig {
  const candidates = [
    join(directory, ".opencode", "neural-context.json"),
    join(directory, "neural-context.json"),
    join(homedir(), ".config", "opencode", "neural-context.json"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, "utf-8")) as PluginConfig;
      } catch {
        return {};
      }
    }
  }
  return {};
}

function detectMagicContext(directory: string): boolean {
  const opencodePaths = [
    join(directory, "opencode.json"),
    join(directory, "opencode.jsonc"),
    join(directory, ".opencode", "opencode.json"),
    join(directory, ".opencode", "opencode.jsonc"),
  ];
  for (const p of opencodePaths) {
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, "utf-8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
        if (raw.includes("@cortexkit/opencode-magic-context") || raw.includes("magic-context")) {
          return true;
        }
      } catch {
        continue;
      }
    }
  }
  return false;
}

const NODE_TYPES: readonly NodeType[] = [
  "concept",
  "assertion",
  "definition",
  "filler",
  "episode",
  "meta",
  "fact",
  "experience",
  "value",
  "culture",
] as const;

const LAYER_DEPTH: Record<string, number> = {
  worldview: 1.0,
  cultural_norm: 0.8,
  interpersonal_style: 0.55,
  work_habit: 0.35,
  surface_pref: 0.15,
};
const CHARACTER_LAYERS = new Set(Object.keys(LAYER_DEPTH));

function characterMeta(node: any): { layer: string; observationCount: number; confidence: number } {
  const cd = (node?.metadata?.characterData ?? {}) as Record<string, unknown>;
  const layer = typeof cd.layer === "string" && CHARACTER_LAYERS.has(cd.layer) ? cd.layer : "surface_pref";
  const observationCount = typeof cd.observationCount === "number" ? cd.observationCount : 1;
  const confidence = typeof cd.confidence === "number" ? cd.confidence : 0.6;
  return { layer, observationCount, confidence };
}

function injectionScore(node: any, now: number): number {
  const { layer, observationCount, confidence } = characterMeta(node);
  const d = LAYER_DEPTH[layer] ?? 0.15;
  const importance = Math.max(0, Math.min(1, node?.importance ?? 0.5));
  const strength = Math.max(0, Math.min(1, node?.strength ?? 0.5));
  const trust = Math.min(1, observationCount / 3);
  const daysSince = Math.max(0, (now - (node?.lastAccessed ?? node?.createdAt ?? now)) / 86400000);
  const recency = Math.exp(-daysSince / 60);
  return (
    d *
    importance *
    (0.5 + 0.5 * strength) *
    (0.4 + 0.6 * trust) *
    (0.5 + 0.5 * recency) *
    Math.max(0.1, Math.min(1, confidence))
  );
}

const STEREOTYPE_RE = /\b(chinese|japanese|korean|american|indian|typical of|as a (chinese|japanese|korean|american|indian|western|eastern)|people from|people who are)\b/i;

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[\s\p{P}]+/u).filter((w) => w.length > 2));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const w of a) if (b.has(w)) intersect++;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

function projectIdFromDir(dir: string): string {
  return createHash("sha256").update(dir).digest("hex").slice(0, 16);
}

function formatRecall(results: RecallResult[]): string {
  if (results.length === 0) return "No memories found.";
  return results
    .map((r, i) => {
      const path = r.path && r.path.length > 1 ? ` [path: ${r.path.join(" → ")}]` : "";
      const time = r.node.createdAt ? new Date(r.node.createdAt).toISOString().slice(0, 16).replace("T", " ") : "";
      return `${i + 1}. [${r.node.type}] (score=${r.score.toFixed(3)}) ${time}${path}\n   ${r.node.content}`;
    })
    .join("\n\n");
}

function formatNode(n: MemoryNode): string {
  return `id=${n.id} type=${n.type} importance=${n.importance.toFixed(2)} strength=${n.strength.toFixed(2)} accesses=${n.accessCount}\n${n.content}`;
}

function parseTagRanges(input: string): number[] {
  const tags: number[] = [];
  for (const part of input.split(",")) {
    const trimmed = part.trim();
    if (trimmed.includes("-")) {
      const [start, end] = trimmed.split("-").map(Number);
      for (let i = start; i <= end; i++) tags.push(i);
    } else {
      tags.push(Number(trimmed));
    }
  }
  return tags.filter((n) => !isNaN(n) && n > 0);
}

const AIAgentLocalMemoryPlugin: Plugin = async ({ directory, client }) => {
  const sessionId = projectIdFromDir(directory);
  const pluginConfig = loadConfig(directory);
  const rawStorage = new SqliteStorageProvider();
  const engine = new NeuralContextEngine();
  const dataBase = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  const episodesDir = join(dataBase, 'ai-agent-local-memory', 'episodes');
  const syncDir = join(dataBase, 'ai-agent-local-memory', 'sync');

  const opLog = new OperationLog(syncDir);
  const storage = new LoggedStorageProvider(rawStorage, opLog);

  const NODE_ALLOW_TYPES = new Set([
    "episode", "fact", "concept", "assertion", "definition", "experience", "meta", "filler", "value", "culture",
  ]);
  async function safePutNode(node: any, opts?: { fromToolOutput?: boolean }): Promise<boolean> {
    try {
      if (opts?.fromToolOutput === true) return false;
      if (!node || typeof node.content !== "string") return false;
      if (!NODE_ALLOW_TYPES.has(node.type)) return false;
      const c = node.content;
      if (c.length === 0) return false;
      // Reject raw tool-output signatures: JSON result envelopes and result markers.
      if (/^\s*\{[\s\S]*"(output|stdout|stderr|tool_result|exit_code)"\s*:/.test(c)) return false;
      if (/\[tool[_-]?result\]|\[replay-shortcircuit\]/i.test(c)) return false;
      await storage.putNode(node);
      return true;
    } catch {
      return false;
    }
  }

  let llmProvider: LLMProvider | undefined;
  let embeddingProvider: EmbeddingProvider | undefined;

  if (pluginConfig.llm) {
    const c = pluginConfig.llm;
    if (c.provider === "ollama") {
      llmProvider = new OllamaLLM({ model: c.model });
    } else if (c.provider === "openai" || c.provider === "custom") {
      llmProvider = new OpenAICompatibleLLM({
        baseUrl: c.baseUrl ?? "https://api.openai.com/v1",
        apiKey: c.apiKey ?? process.env.OPENAI_API_KEY,
        model: c.model,
      });
    }
  }

  if (pluginConfig.embedding) {
    const c = pluginConfig.embedding;
    if (c.provider === "ollama") {
      embeddingProvider = new OllamaEmbedding({ model: c.model });
    } else if (c.provider === "openai" || c.provider === "custom") {
      embeddingProvider = new OpenAICompatibleEmbedding({
        baseUrl: c.baseUrl ?? "https://api.openai.com/v1",
        apiKey: c.apiKey ?? process.env.OPENAI_API_KEY,
        embeddingModel: c.model,
      });
    }
  }

  let localLlmProvider: LLMProvider | undefined;
  const localLlmMode = pluginConfig.localLlm?.mode ?? null;
  if (pluginConfig.localLlm) {
    const lc = pluginConfig.localLlm;
    const endpoint = lc.endpoint ?? "http://localhost:11434";
    if (lc.provider === "ollama") {
      localLlmProvider = new OllamaLLM({ model: lc.model, baseUrl: endpoint });
    } else if (lc.provider === "openai" || lc.provider === "custom") {
      localLlmProvider = new OpenAICompatibleLLM({
        baseUrl: endpoint,
        apiKey: lc.apiKey ?? process.env.OPENAI_API_KEY,
        model: lc.model,
      });
    }
  }

  const localTrainingDir = join(dataBase, "ai-agent-local-memory", "training-pairs");
  let dissatisfactionCount = 0;
  const confidenceThreshold = pluginConfig.localLlm?.confidence?.userThreshold ?? 0.5;
  const autoEscalateAfter = pluginConfig.localLlm?.confidence?.autoEscalateAfter ?? 3;
  const trainingTriggerCount = pluginConfig.localLlm?.training?.triggerCount ?? (localLlmMode === "observer" ? 100 : 50);
  const cotStrategy = pluginConfig.localLlm?.training?.cotStrategy ?? "none";

  try {
    await engine.init({ storage, projectId: "global", episodesDir, llm: llmProvider, embedding: embeddingProvider });
  } catch (err) {
    console.error("[ai-agent-local-memory] init failed:", err);
    return {} as Hooks;
  }

  const compartmentStore = new CompartmentStore(rawStorage.getDb());

  // One-time migration: compartments created before schema 2 stored transform-array
  // indices as ordinals (no messageId anchor), which misaligned across passes. They
  // can't be salvaged, so drop them once; sessions re-compress from scratch and episode
  // memories in the graph are unaffected.
  try {
    const db = rawStorage.getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)`);
    const v = db.prepare(`SELECT value FROM kv WHERE key = 'compartments_schema'`).get() as { value: string } | undefined;
    if (v?.value !== "4") {
      compartmentStore.dropAndRecreate();
      db.prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES ('compartments_schema', '4')`).run();
    }
  } catch {}

  let openCodeDb: any = null;
  try {
    const xdgData = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
    const openCodeDbPath = join(xdgData, 'opencode', 'opencode.db');
    if (existsSync(openCodeDbPath)) {
      const mainDb = rawStorage.getDb();
      mainDb.exec(`ATTACH DATABASE '${openCodeDbPath}' AS opencode`);
      openCodeDb = mainDb;
    }
  } catch {}

  function getContextUsage(sid: string): { percentage: number; inputTokens: number } {
    if (!openCodeDb) return { percentage: 0, inputTokens: 0 };
    try {
      const row = openCodeDb.prepare(`
        SELECT 
          COALESCE(json_extract(data, '$.tokens.input'), 0)
            + COALESCE(json_extract(data, '$.tokens.cache.read'), 0)
            + COALESCE(json_extract(data, '$.tokens.cache.write'), 0) AS prompt
        FROM opencode.message
        WHERE session_id = ?
          AND json_extract(data, '$.role') = 'assistant'
          AND data IS NOT NULL
        ORDER BY time_created DESC
        LIMIT 1
      `).get(sid) as { prompt: number } | undefined;
      if (!row) return { percentage: 0, inputTokens: 0 };
      const contextLimit = pluginConfig.contextWindowTokens ?? 128000;
      return { percentage: (row.prompt / contextLimit) * 100, inputTokens: row.prompt };
    } catch { return { percentage: 0, inputTokens: 0 }; }
  }

  function getSessionMessageList(sid: string): Array<{ id: string; role: string; ord: number }> {
    if (!openCodeDb) return [];
    try {
      const rows = openCodeDb.prepare(`
        SELECT id, json_extract(data, '$.role') AS role,
               json_extract(data, '$.summary') AS summary,
               json_extract(data, '$.finish') AS finish
        FROM opencode.message
        WHERE session_id = ? AND data IS NOT NULL
        ORDER BY time_created ASC, id ASC
      `).all(sid) as Array<{ id: string; role: string; summary: unknown; finish: string | null }>;
      const out: Array<{ id: string; role: string; ord: number }> = [];
      let ord = 0;
      for (const r of rows) {
        if (r.summary === true || r.summary === 1) continue;
        ord++;
        out.push({ id: r.id, role: String(r.role ?? "user"), ord });
      }
      return out;
    } catch { return []; }
  }

  function getSessionMessagePartsForOrds(sid: string, startOrd: number, endOrd: number): Array<{ ord: number; id: string; role: string; content: string }> {
    if (!openCodeDb) return [];
    try {
      const list = getSessionMessageList(sid);
      const wanted = list.filter((m) => m.ord >= startOrd && m.ord <= endOrd);
      if (wanted.length === 0) return [];
      const partStmt = openCodeDb.prepare(
        `SELECT json_extract(data, '$.text') AS text, json_extract(data, '$.type') AS type
         FROM opencode.part WHERE session_id = ? AND message_id = ? ORDER BY id ASC`
      );
      return wanted.map((m) => {
        let content = "";
        try {
          const rows = partStmt.all(sid, m.id) as Array<{ text: string | null; type: string | null }>;
          content = rows.filter((r) => r.type === "text" && r.text).map((r) => r.text).join("\n").slice(0, 1000);
        } catch {}
        return { ord: m.ord, id: m.id, role: m.role, content };
      });
    } catch { return []; }
  }

  const historianModels = ["claude-sonnet-4-6", "gpt-4.1-mini", "gpt-5-mini"];
  const historianLlm = llmProvider ?? new OpenAICompatibleLLM({
    baseUrl: pluginConfig.embedding?.baseUrl ?? pluginConfig.llm?.baseUrl ?? "http://localhost:6655/openai/v1",
    apiKey: pluginConfig.embedding?.apiKey ?? pluginConfig.llm?.apiKey ?? process.env.OPENAI_API_KEY,
    model: historianModels[0],
    maxTokens: 400,
  });
  const historian = (embeddingProvider || llmProvider || pluginConfig.embedding || pluginConfig.llm)
    ? new Historian({ llm: historianLlm, fallbackModels: historianModels.slice(1) })
    : null;
  let historianTurnCount = 0;

  // ---- Shared neural_read runner --------------------------------------------
  // Extracts durable character traits from `material` via a detached sub-session
  // on the main model, polling every 1.5s. Yields the moment the main session
  // gets fresh user input or other work (__neuralMainBusyAt) and saves whatever
  // was extracted so far. Used by BOTH the neural_read tool and the idle
  // "resume the unfinished book" path so there is exactly one code path.
  //
  // On interrupt it persists the FULL material+origin into .reading-state.json
  // so the idle branch can pick the same book back up later. On completion it
  // clears the material so we never re-read a finished book.
  const NEURAL_READ_PROMPT_HEAD = `Below is source material a user wants to use to shape an AI agent's character (its values, worldview, and working norms).
Extract 0-8 durable character traits the material TEACHES or ENDORSES. For each emit one JSON object:
{"type":"value"|"culture","layer":"worldview"|"cultural_norm"|"interpersonal_style"|"work_habit"|"surface_pref","trait":"<one neutral sentence describing the principle to adopt>","evidence":"<short quote/paraphrase from the material>","confidence":0.0-1.0}

LAYER GUIDE (pick the SHALLOWER one when unsure):
- worldview: fundamental beliefs about reality/self/others/morality.
- cultural_norm: patterned expectations about how work/life/relationships should work (use type="culture").
- interpersonal_style: how to communicate 1-on-1.
- work_habit: task/execution patterns.
- surface_pref: swappable preferences.

RULES:
- Extract ONLY principles the material actually advocates; cite the moment as evidence.
- NEVER attribute a trait to a national/ethnic/religious group. Describe the PRINCIPLE, not a group.
- Prefer fewer, higher-confidence, deeper-layer items.
Return a JSON array. If nothing qualifies, return [].`;

  const readingStatePath = () => join(dataBase, "ai-agent-local-memory", ".reading-state.json");

  const salvageReadItems = (raw: string): any[] => {
    const arr = raw.match(/\[[\s\S]*\]/);
    if (arr) { try { return JSON.parse(arr[0]); } catch {} }
    const objs: any[] = [];
    let depth = 0, start = -1;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === "{") { if (depth === 0) start = i; depth++; }
      else if (ch === "}") { depth--; if (depth === 0 && start >= 0) { try { objs.push(JSON.parse(raw.slice(start, i + 1))); } catch {} start = -1; } }
    }
    return objs;
  };

  const storeReadTraits = async (
    items: any[],
    origin: string,
  ): Promise<{ id: string; type: string; layer: string; trait: string; confidence: number }[]> => {
    const out: { id: string; type: string; layer: string; trait: string; confidence: number }[] = [];
    for (const it of items) {
      if (out.length >= 8) break;
      if (!it || typeof it.trait !== "string") continue;
      const trait = it.trait.trim();
      if (trait.length < 15 || trait.length > 500) continue;
      if (STEREOTYPE_RE.test(trait)) continue;
      const layer = CHARACTER_LAYERS.has(it.layer) ? it.layer : "surface_pref";
      const nodeType = it.type === "culture" ? "culture" : "value";
      const confidence = Math.max(0.1, Math.min(1, typeof it.confidence === "number" ? it.confidence : 0.6));
      const depth = LAYER_DEPTH[layer] ?? 0.15;
      const node = await engine.remember(trait, nodeType as NodeType, {
        importance: Math.min(0.95, 0.55 + 0.35 * depth),
        metadata: {
          characterData: {
            scope: "global",
            layer,
            observationCount: 1,
            confidence,
            source: "curated",
            reviewStatus: "pending",
            origin,
            evidence: typeof it.evidence === "string" ? it.evidence.slice(0, 300) : "",
          },
        },
      });
      out.push({ id: node.id, type: nodeType, layer, trait, confidence });
    }
    return out;
  };

  // Fire-and-forget detached read. `material` is already fetched/truncated prose;
  // `origin` is the URL or "inline-text". Never blocks the caller.
  const runNeuralReadServer = (material: string, origin: string): void => {
    const readPrompt = `${NEURAL_READ_PROMPT_HEAD}\n\nMATERIAL:\n${material}\n\nJSON:`;
    const readStartTs = Date.now();
    (globalThis as any).__neuralReadInFlight = true;
    (async () => {
      let childId: string | undefined;
      let bestText = "";
      let interrupted = false;
      const notify = (msg: string) => { try { writeFileSync("/tmp/neural-read-result.txt", `${new Date().toISOString()} ${msg}\n`); } catch {} };
      try {
        const child = await client.session.create({ body: { system: "You extract durable character traits as a JSON array. Return ONLY the JSON array, nothing else." } });
        childId = child.data?.id;
        if (!childId) { notify("neural_read: failed to create sub-session"); return; }
        await client.session.promptAsync({ path: { id: childId }, body: { parts: [{ type: "text", text: readPrompt }] } });

        const MAX_WAIT_MS = 120000;
        const POLL_MS = 1500;
        const deadline = readStartTs + MAX_WAIT_MS;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, POLL_MS));
          const busyAt = (globalThis as any).__neuralMainBusyAt ?? 0;
          if (busyAt > readStartTs) { interrupted = true; break; }
          const msgs = await client.session.messages({ path: { id: childId }, query: { limit: 5 } });
          let text = "";
          for (const msg of (msgs.data ?? [])) {
            if (msg.info?.role !== "assistant") continue;
            text = (msg.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => (p as { text?: string }).text ?? "").join("\n");
            break;
          }
          if (text) bestText = text;
          if (bestText && /\]\s*$/.test(bestText.trim())) break;
        }
      } catch (e) {
        notify(`neural_read: error ${(e as Error)?.message ?? e}`);
      } finally {
        if (childId) { try { await client.session.delete({ path: { id: childId } }); } catch {} }
      }
      const outcome = interrupted ? "interrupted" : "done";
      try {
        const items = salvageReadItems(bestText);
        const stored = await storeReadTraits(items, origin);
        notify(`neural_read ${outcome}: ${stored.length} pending trait(s) saved. Approve with neural_adopt. ids=${JSON.stringify(stored.map((s) => s.id))}`);
      } catch (e) {
        notify(`neural_read: store error ${(e as Error)?.message ?? e}`);
      } finally {
        (globalThis as any).__neuralReadInFlight = false;
        try {
          mkdirSync(join(dataBase, "ai-agent-local-memory"), { recursive: true });
          // On interrupt, persist the material+origin so the idle branch can
          // resume this exact book later. On done, drop it so we never re-read.
          const state = interrupted
            ? { lastOutcome: "interrupted", material, origin, updatedAt: Date.now() }
            : { lastOutcome: "done", updatedAt: Date.now() };
          writeFileSync(readingStatePath(), JSON.stringify(state));
        } catch {}
      }
    })();
  };

  const recallStrategy = pluginConfig.recallStrategy ?? "plugin";

  // recallStrategy="llm" mirrors Claude Code: build a cheap lexical manifest,
  // then let the LLM pick relevant entries (no embedding/spreading-activation).
  async function llmRecall(query: string, maxResults: number): Promise<RecallResult[]> {
    const CANDIDATE_LIMIT = 30;
    const candidates = await storage.search(query, CANDIDATE_LIMIT);
    if (candidates.length === 0) return [];
    if (!historianLlm) {
      return candidates.slice(0, maxResults).map((node) => ({ node, score: 0.5 }));
    }

    const manifest = candidates
      .map((n, i) => {
        const snippet = n.content.replace(/\s+/g, " ").slice(0, 240);
        return `${i + 1}. [${n.type}] ${snippet}`;
      })
      .join("\n");

    const prompt = [
      "You are selecting which stored memories are relevant to a user query.",
      "Below is a numbered list of candidate memories.",
      `Query: ${query}`,
      "",
      "Candidates:",
      manifest,
      "",
      `Return ONLY a JSON array of the numbers (max ${Math.min(maxResults, 5)}) of the memories that are genuinely relevant to the query, most relevant first. If none are relevant, return []. Example: [3,1,7]`,
    ].join("\n");

    let picked: number[] = [];
    try {
      const response = await historianLlm.complete(prompt, { maxTokens: 100 });
      const match = response.match(/\[[\s\d,]*\]/);
      if (match) {
        picked = JSON.parse(match[0]) as number[];
      }
    } catch {
      picked = [];
    }

    const seen = new Set<number>();
    const results: RecallResult[] = [];
    let rank = 0;
    for (const idx of picked) {
      const node = candidates[idx - 1];
      if (!node || seen.has(idx)) continue;
      seen.add(idx);
      results.push({ node, score: 1 - rank * 0.1 });
      rank++;
      if (results.length >= maxResults) break;
    }
    if (results.length === 0) {
      return candidates.slice(0, maxResults).map((node) => ({ node, score: 0.5 }));
    }
    return results;
  }
  const SERVER_BUILD = "__BUILD_NUMBER__";
  writeFileSync("/tmp/neural-server-build.txt", SERVER_BUILD);
  writeFileSync("/tmp/neural-plugin-init.log", JSON.stringify({
    ts: new Date().toISOString(),
    build: SERVER_BUILD,
    hasEmbedding: !!embeddingProvider,
    hasLlm: !!llmProvider,
    configLoaded: !!pluginConfig.embedding,
    directory,
  }, null, 2));

  let rpcServer: any = null;
  try {
    const { createServer } = await import("node:net");
    const rpcPath = "/tmp/neural-context-rpc.sock";
    try { const { unlinkSync } = await import("node:fs"); unlinkSync(rpcPath); } catch {}
    rpcServer = createServer((conn) => {
      conn.on("data", async (data) => {
        try {
          const req = JSON.parse(data.toString());
          let res: any = {};
          if (req.method === "status") {
            const usage = getContextUsage(sessionId);
            const compartments = compartmentStore.getForSession(sessionId);
            const nodeCount = await storage.getNodeCount();
            res = { build: SERVER_BUILD, usage, compartments: compartments.length, nodes: nodeCount, historianFailures: 0, model: "" };
          } else if (req.method === "compartments") {
            res = { compartments: compartmentStore.getForSession(sessionId) };
          }
          conn.write(JSON.stringify(res) + "\n");
        } catch { conn.write("{}\n"); }
      });
    });
    rpcServer.listen(rpcPath);
  } catch {}

  if (historian && openCodeDb) {
    setTimeout(async () => {
      try {
        const sessions = await client.session.list();
        if (!sessions.data || sessions.data.length === 0) return;
        const currentSession = sessions.data[0];
        const sid = currentSession.id;
        const row = openCodeDb.prepare(`
          SELECT 
            COALESCE(json_extract(data, '$.tokens.input'), 0)
              + COALESCE(json_extract(data, '$.tokens.cache.read'), 0)
              + COALESCE(json_extract(data, '$.tokens.cache.write'), 0) AS prompt
          FROM opencode.message
          WHERE session_id = ?
            AND json_extract(data, '$.role') = 'assistant'
            AND data IS NOT NULL
          ORDER BY time_created DESC
          LIMIT 1
        `).get(sid) as { prompt: number } | undefined;
        if (!row) return;
        const contextLimit = pluginConfig.contextWindowTokens ?? 128000;
        const pct = (row.prompt / contextLimit) * 100;
        if (pct >= 90) {
          const comps = compartmentStore.getForSession(sid);
          const lastEndOrd = comps.length > 0 ? comps[comps.length - 1].endOrd : 0;
          const dbList = getSessionMessageList(sid);
          if (dbList.length - lastEndOrd < 26) return;
          const chunkSize = Math.min(64, dbList.length - lastEndOrd - 20);
          if (chunkSize < 6) return;
          const windowMsgs = getSessionMessagePartsForOrds(sid, lastEndOrd + 1, lastEndOrd + chunkSize);
          if (windowMsgs.length < 6) return;
          const result = await (historian as any).compress(sid, windowMsgs);
          if (result) compartmentStore.save(result);
          writeFileSync("/tmp/neural-init-compress.log", JSON.stringify({ ts: Date.now(), pct, chunkSize, success: !!result }));
        }
      } catch {}
    }, 3000);
  }

  setTimeout(async () => {
    try {
      if (!currentOpenCodeSessionId) return;
      const msgsResult = await client.session.messages({ path: { id: currentOpenCodeSessionId }, query: { limit: 50 } });
      if (!msgsResult.data || msgsResult.data.length === 0) return;
      for (const msg of msgsResult.data.slice(-20)) {
        const role = msg.info.role;
        if (role !== "user" && role !== "assistant") continue;
        const textParts = msg.parts.filter((p: any) => p.type === "text");
        const content = textParts.map((p: any) => (p as { text?: string }).text ?? "").join("\n").trim();
        if (content.length < 10 || content.length > 3000) continue;
        await safePutNode({
          id: crypto.randomUUID(),
          type: "episode",
          content: content.slice(0, 2000),
          importance: role === "user" ? 0.6 : 0.5,
          strength: 0.5,
          accessCount: 0,
          lastAccessed: Date.now(),
          createdAt: Date.now(),
          sourceSession: sessionId,
        });
      }
    } catch {}
  }, 8000);

  if (existsSync(join(syncDir, ".git"))) {
  }

  const magicContextPresent = pluginConfig.coexistWithOtherContextManager ?? detectMagicContext(directory);
  if (magicContextPresent) {
    console.log("[ai-agent-local-memory] magic-context detected — running in coexistence mode (messages.transform disabled)");
  }

  if (pluginConfig.syncRepo && !existsSync(join(syncDir, ".git"))) {
    try {
      const { mkdirSync: mkSync } = await import("node:fs");
      const { execSync } = await import("node:child_process");
      mkSync(syncDir, { recursive: true });
      execSync(`git init && git remote add origin ${pluginConfig.syncRepo}`, { cwd: syncDir, stdio: "ignore" });
      console.log(`[ai-agent-local-memory] sync repo initialized: ${pluginConfig.syncRepo}`);
    } catch {
      console.warn("[ai-agent-local-memory] sync repo auto-init failed");
    }
  }

  // Keep large binaries and full-session JSONL out of git history — committing them
  // every sync grew .git to 1.6G (each 46MB session export stored as a fresh blob per
  // commit). Written unconditionally so existing repos get the ignore rules too.
  if (pluginConfig.syncRepo) {
    try {
      const gitignorePath = join(syncDir, ".gitignore");
      const wanted = "session-backup/\n*.db.gz\n*.db\nopencode-sessions/*.jsonl\n";
      if (!existsSync(gitignorePath) || readFileSync(gitignorePath, "utf-8") !== wanted) {
        writeFileSync(gitignorePath, wanted);
      }
    } catch {}
  }

  let syncTimer: ReturnType<typeof setInterval> | null = null;
  let reconciliationTimer: ReturnType<typeof setInterval> | null = null;

  reconciliationTimer = setInterval(async () => {
    try {
      if (!openCodeDb) return;
      const row = openCodeDb.prepare(`SELECT COUNT(*) as cnt FROM opencode.message WHERE session_id = ?`).get(sessionId) as { cnt: number } | undefined;
      if (!row || row.cnt === 0) return;
      const storedCount = await storage.getNodeCount();
      if (row.cnt > storedCount * 2) {
        if (!currentOpenCodeSessionId) return;
        const msgsResult = await client.session.messages({ path: { id: currentOpenCodeSessionId }, query: { limit: 10 } });
        if (!msgsResult.data) return;
        for (const msg of msgsResult.data.slice(-5)) {
          const role = msg.info.role;
          if (role !== "user" && role !== "assistant") continue;
          const textParts = msg.parts.filter((p: any) => p.type === "text");
          const content = textParts.map((p: any) => (p as { text?: string }).text ?? "").join("\n").trim();
          if (content.length < 10 || content.length > 3000) continue;
          await safePutNode({
            id: crypto.randomUUID(),
            type: "episode",
            content: content.slice(0, 2000),
            importance: role === "user" ? 0.6 : 0.5,
            strength: 0.5,
            accessCount: 0,
            lastAccessed: Date.now(),
            createdAt: Date.now(),
            sourceSession: sessionId,
          });
        }
      }
    } catch {}
  }, 5 * 60 * 1000);

  if (historian) {
    // Turn-end cooldown trigger (mirrors Claude Code's autoDream). A 2AM cron never fired
    // because OpenCode is rarely running then; instead maybeRunDreamer() runs once per turn
    // from the transform hook, does one stat() on a lock file, and bails unless COOLDOWN_MS
    // elapsed. The lock's mtime IS "last consolidated at"; its body holds the holder PID so a
    // dead holder's lock can be reclaimed. Cross-process safe.
    const DREAM_LOCK = join(dataBase, "ai-agent-local-memory", ".dream-lock");
    const COOLDOWN_MS = 24 * 60 * 60 * 1000; // daily consolidation, mirrors magic-context's nightly cron cadence
    const HOLDER_STALE_MS = 60 * 60 * 1000;
    let dreamerRunning = false;

    const runDreamer = async () => {
      try {
        const recentEpisodes = await storage.queryNodes({ type: "episode", sourceSession: sessionId, limit: 20 });
        if (recentEpisodes.length < 5) return;

        const existingFacts = await storage.queryNodes({ type: "fact" });
        const existingFactContents = new Set(existingFacts.map(f => f.content.toLowerCase()));

        const transcript = recentEpisodes
          .slice(-10)
          .map(e => e.content.slice(0, 500))
          .join("\n");

        // ---- Phase A: Consolidate (extract durable facts) ----
        const extractPrompt = `Extract user preferences, decisions, and constraints from this conversation excerpt.
Return a JSON array of strings — each string is one standalone fact worth remembering long-term.
Only extract CLEAR preferences/decisions (e.g. "User prefers TypeScript over JavaScript", "Project uses Bun runtime").
If nothing worth extracting, return [].
Do NOT extract opinions, questions, or temporary states.

CONVERSATION:
${transcript}

JSON:`;

        const response = await historianLlm.complete(extractPrompt, { maxTokens: 300 });
        if (response) {
          const jsonMatch = response.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const facts: string[] = JSON.parse(jsonMatch[0]);
            for (const fact of facts) {
              if (typeof fact !== "string" || fact.length < 10 || fact.length > 500) continue;
              if (existingFactContents.has(fact.toLowerCase())) continue;
              await engine.remember(fact, "fact", {
                importance: 0.8,
                metadata: { factData: { scope: "global", activationFloor: 0.5, ready: true } },
              });
              existingFactContents.add(fact.toLowerCase());
            }
          }
        }

        const existingChar = [
          ...(await storage.queryNodes({ type: "value" })),
          ...(await storage.queryNodes({ type: "culture" })),
        ];

        const charPrompt = `Extract 0-5 character traits the user EXPLICITLY stated or unambiguously demonstrated in the conversation below.
For each trait emit one JSON object:
{"type":"value"|"culture","layer":"worldview"|"cultural_norm"|"interpersonal_style"|"work_habit"|"surface_pref","trait":"<one neutral sentence, no group stereotype>","evidence":"<quote or paraphrase of the exact moment>","confidence":0.0-1.0}

LAYER GUIDE (pick the SHALLOWER one when unsure — never guess deeper):
- worldview: fundamental beliefs about reality/self/others/morality (e.g. "believes honesty matters more than convenience").
- cultural_norm: culturally-patterned expectations about how work/life/relationships should work (e.g. "prefers relationship and context before diving into the task"). Use type="culture" for these.
- interpersonal_style: how the user communicates 1-on-1 (e.g. "wants full context before a conclusion").
- work_habit: task/execution patterns (e.g. "verifies before reporting done").
- surface_pref: swappable preferences (e.g. "prefers concise replies").

RULES:
- Extract ONLY what is explicitly stated or clearly demonstrated in THIS conversation.
- If you cannot cite a specific moment as evidence, DO NOT emit the item.
- NEVER attribute a trait to a national/ethnic/religious group. Describe THIS user only.
- Max 5 items. Prefer fewer, higher-confidence items.
Return a JSON array. If nothing qualifies, return [].

CONVERSATION:
${transcript}

JSON:`;

        const charResponse = await historianLlm.complete(charPrompt, { maxTokens: 600 });
        if (charResponse) {
          const cMatch = charResponse.match(/\[[\s\S]*\]/);
          if (cMatch) {
            let items: any[] = [];
            try { items = JSON.parse(cMatch[0]); } catch { items = []; }
            let emitted = 0;
            for (const it of items) {
              if (emitted >= 5) break;
              if (!it || typeof it.trait !== "string") continue;
              const trait = it.trait.trim();
              if (trait.length < 15 || trait.length > 500) continue;
              if (STEREOTYPE_RE.test(trait)) continue;
              const layer = CHARACTER_LAYERS.has(it.layer) ? it.layer : "surface_pref";
              const nodeType = it.type === "culture" ? "culture" : "value";
              const confidence = Math.max(0.1, Math.min(1, typeof it.confidence === "number" ? it.confidence : 0.6));

              const existing = existingChar.find(
                e => jaccard(tokenize(e.content), tokenize(trait)) >= 0.6,
              );
              if (existing) {
                const cd = (existing.metadata?.characterData ?? {}) as Record<string, unknown>;
                const obs = (typeof cd.observationCount === "number" ? cd.observationCount : 1) + 1;
                const newImportance = Math.min(0.95, (existing.importance ?? 0.6) + 0.05);
                try {
                  await storage.putNode({
                    ...existing,
                    importance: newImportance,
                    strength: Math.min(1, (existing.strength ?? 0.5) + 0.1),
                    lastAccessed: Date.now(),
                    metadata: {
                      ...existing.metadata,
                      characterData: { ...cd, layer: cd.layer ?? layer, observationCount: obs, confidence: Math.max(Number(cd.confidence) || confidence, confidence) },
                    },
                  } as any);
                } catch {}
                continue;
              }

              const depth = LAYER_DEPTH[layer] ?? 0.15;
              await engine.remember(trait, nodeType, {
                importance: Math.min(0.95, 0.55 + 0.35 * depth),
                metadata: {
                  characterData: { scope: "global", layer, observationCount: 1, confidence, source: "organic", reviewStatus: "ready", evidence: typeof it.evidence === "string" ? it.evidence.slice(0, 300) : "" },
                },
              });
              existingChar.push({ id: "pending", type: nodeType, content: trait, importance: 0.6, strength: 0.5, accessCount: 0, lastAccessed: Date.now(), createdAt: Date.now(), metadata: { characterData: { layer, observationCount: 1, confidence } } } as any);
              emitted++;
            }
          }
        }

        const filePathRegex = /(?:\/[\w.-]+)+\.\w+/g;
        const fileCounts = new Map<string, number>();
        for (const ep of recentEpisodes) {
          const matches = ep.content.match(filePathRegex);
          if (matches) {
            for (const m of matches) {
              fileCounts.set(m, (fileCounts.get(m) ?? 0) + 1);
            }
          }
        }
        const keyFiles = [...fileCounts.entries()]
          .filter(([, count]) => count >= 3)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([path]) => path);

        for (const filePath of keyFiles) {
          const factContent = `Key file: ${filePath}`;
          if (existingFactContents.has(factContent.toLowerCase())) continue;
          await engine.remember(factContent, "fact", {
            importance: 0.7,
            metadata: { factData: { scope: "session", activationFloor: 0.3, ready: true, keyFile: true } },
          });
          existingFactContents.add(factContent.toLowerCase());
        }

        // ---- Phase B: Prune (delete facts contradicted/superseded by recent signal) ----
        // Claude Code's dream phase 4 deletes facts that "today's investigation disproves".
        // We ask the LLM which of the current stored facts are now stale/contradicted given
        // the recent conversation, and forget those nodes. Only prune GLOBAL/SESSION facts,
        // never keyFile entries (those are cheap structural pointers), and cap deletions per
        // run so a hallucinated response can't wipe the store.
        try {
          const factsForReview = existingFacts
            .filter(f => !(f.metadata as any)?.factData?.keyFile)
            .slice(0, 40);
          if (factsForReview.length > 0) {
            const numbered = factsForReview
              .map((f, i) => `${i}. ${f.content.slice(0, 200)}`)
              .join("\n");
            const prunePrompt = `Below is a list of long-term memory facts, and a recent conversation excerpt.
Return a JSON array of the INDEX NUMBERS of facts that the recent conversation CONTRADICTS or makes clearly OBSOLETE/SUPERSEDED.
Only include a fact if the conversation provides direct evidence it is now wrong or outdated.
If none are contradicted, return [].
Be conservative — when in doubt, keep the fact (omit it).

FACTS:
${numbered}

RECENT CONVERSATION:
${transcript}

JSON array of stale indexes:`;

            const pruneResp = await historianLlm.complete(prunePrompt, { maxTokens: 100 });
            if (pruneResp) {
              const m = pruneResp.match(/\[[\s\S]*\]/);
              if (m) {
                const stale: unknown[] = JSON.parse(m[0]);
                const idxs = stale
                  .filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n < factsForReview.length)
                  .slice(0, 5); // hard cap: never delete more than 5 facts per run
                for (const idx of idxs) {
                  const victim = factsForReview[idx];
                  if (victim?.id) {
                    try { await storage.deleteNode(victim.id); } catch {}
                  }
                }
              }
            }
          }
        } catch (pruneErr: any) {
          try { writeFileSync("/tmp/neural-dream-error.log", `${Date.now()} [prune] ${pruneErr?.message ?? pruneErr}\n${pruneErr?.stack ?? ""}\n`, { flag: "a" }); } catch {}
        }
      } catch (dreamErr: any) {
        try { writeFileSync("/tmp/neural-dream-error.log", `${Date.now()} [dream] ${dreamErr?.message ?? dreamErr}\n${dreamErr?.stack ?? ""}\n`, { flag: "a" }); } catch {}
      }
    };

    // Cheap, cross-process-safe cooldown gate. Called once per turn from the transform hook.
    const maybeRunDreamer = async () => {
      if (dreamerRunning) return;
      const now = Date.now();
      try {
        const st = statSync(DREAM_LOCK);
        const age = now - st.mtimeMs;
        if (age < COOLDOWN_MS) {
          // Cooldown not elapsed — unless the lock is held by a dead holder AND itself stale.
          let holderAlive = false;
          try {
            const pid = parseInt(readFileSync(DREAM_LOCK, "utf-8").trim(), 10);
            if (Number.isInteger(pid) && pid > 0) {
              try { process.kill(pid, 0); holderAlive = true; } catch { holderAlive = false; }
            }
          } catch {}
          if (holderAlive || age < HOLDER_STALE_MS) return;
        }
      } catch {
        // No lock file yet → first run is allowed.
      }
      // Claim the lock: write our PID and bump mtime to now. This is the "last consolidated at".
      dreamerRunning = true;
      try {
        mkdirSync(join(dataBase, "ai-agent-local-memory"), { recursive: true });
        writeFileSync(DREAM_LOCK, String(process.pid));
        utimesSync(DREAM_LOCK, new Date(), new Date());
      } catch {}
      try {
        await runDreamer();
      } finally {
        // Refresh mtime on completion so the full cooldown counts from finish, not start.
        try { utimesSync(DREAM_LOCK, new Date(), new Date()); } catch {}
        dreamerRunning = false;
      }
    };

    // Expose the gate so the transform hook can trigger it once per turn.
    (globalThis as any).__neuralMaybeRunDreamer = maybeRunDreamer;
  }

  if (existsSync(join(syncDir, ".git"))) {
    syncTimer = setInterval(async () => {
      try {
        const { exec } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execP = promisify(exec);
        const { stdout } = await execP("git status --porcelain", { cwd: syncDir });
        if (stdout.trim().length > 0) {
          await execP('git add -A && git commit -m "sync: auto" && git push', { cwd: syncDir });
        }
        await execP("git pull --rebase", { cwd: syncDir });
      } catch {}
    }, 60 * 60 * 1000);
  }

  const sessionBackupDir = join(dataBase, 'ai-agent-local-memory', 'session-backup');
  setTimeout(async () => {
    try {
      const { mkdirSync, copyFileSync } = await import("node:fs");
      const { execSync } = await import("node:child_process");

      const lastBackupFile = join(sessionBackupDir, ".last-session-backup");
      mkdirSync(sessionBackupDir, { recursive: true });
      const lastBackup = existsSync(lastBackupFile) ? parseInt(readFileSync(lastBackupFile, "utf-8")) || 0 : 0;
      if (Date.now() - lastBackup < 24 * 60 * 60 * 1000) return;

      const xdgData = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
      const openCodeDbPath = join(xdgData, 'opencode', 'opencode.db');
      if (!existsSync(openCodeDbPath)) return;

      const icloudDir = join(homedir(), "Library", "Mobile Documents", "com~apple~CloudDocs", "opencode-backup");
      mkdirSync(icloudDir, { recursive: true });

      const backupFile = join(icloudDir, "opencode.db.gz");
      const { exec: execAsync } = await import("node:child_process");
      execAsync(`nice -n 19 gzip -1 -c "${openCodeDbPath}" > "${backupFile}"`, { stdio: "ignore" } as any, () => {
        writeFileSync(lastBackupFile, String(Date.now()));
      });

      const configDir = join(homedir(), '.config', 'opencode');
      for (const f of ['opencode.jsonc', 'opencode.json', 'neural-context.json']) {
        const src = join(configDir, f);
        if (existsSync(src)) copyFileSync(src, join(icloudDir, f));
      }
    } catch {}
  }, 30 * 1000);

  setTimeout(async () => {
    try {
      const { exec } = await import("node:child_process");
      const stateFile = join(homedir(), ".local", "share", "ai-agent-local-memory", ".auto-train-state");
      const lastTrained = existsSync(stateFile) ? parseInt(readFileSync(stateFile, "utf-8")) || 0 : 0;
      const db = rawStorage.getDb();
      const expCount = (db.prepare("SELECT COUNT(*) as c FROM nodes WHERE type='experience'").get() as any)?.c ?? 0;
      const newSinceLast = expCount - lastTrained;
      const MIN_NEW = 20;
      if (newSinceLast >= MIN_NEW) {
        const pipelineScript = join(homedir(), "Desktop", "ju", "projects", "AIAgentLocalMemory", "packages", "lora-pipeline", "auto-train.sh");
        if (existsSync(pipelineScript)) {
          const flagFile = join(homedir(), ".local", "share", "ai-agent-local-memory", ".training-in-progress");
          writeFileSync(flagFile, String(Date.now()));
          exec(`nice -n 19 bash "${pipelineScript}"`, { timeout: 600000 } as any, () => {
            try { const { unlinkSync } = require("node:fs"); unlinkSync(flagFile); } catch {}
          });
        }
      }
    } catch {}
  }, 120 * 1000);

  const renderConfig: ContextRenderConfig = {
    contextWindowTokens: pluginConfig.contextWindowTokens ?? 128000,
    budgetRatio: pluginConfig.budgetRatio ?? 0.6,
  };

  const graph = new NeuralGraph(storage);
  const workingMemory = new WorkingMemory();
  const renderer = new ContextRenderer(graph, workingMemory, storage, renderConfig);

  let turnCounter = 0;
  const droppedTags = new Set<number>();
  let lastModelKey = "";
  let lastContextPercentage = 0;
  let reasoningWatermark = 0;
  let historianFailureCount = 0;
  let lastTailStartIdx = -1;
  let lastSystemHash = "";
  let lastCompressTime = 0;
  let currentOpenCodeSessionId = "";
  // Guards against concurrent compress runs for the same session — critical to keep
  // transform non-blocking on sessions with large uncovered gaps. Mirrors magic-context's
  // compartmentInProgress flag: 80-95% pct triggers a background compress; further transform
  // passes see the flag and skip re-triggering until this run resolves.
  const compressInFlight = new Set<string>();

  try {
    const row = rawStorage.getDb().prepare(`SELECT value FROM kv WHERE key = 'reasoning_watermark'`).get() as { value: string } | undefined;
    if (row) reasoningWatermark = parseInt(row.value) || 0;
    const row2 = rawStorage.getDb().prepare(`SELECT value FROM kv WHERE key = 'last_compress_time'`).get() as { value: string } | undefined;
    if (row2) lastCompressTime = parseInt(row2.value) || 0;
  } catch {
    try { rawStorage.getDb().exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)`); } catch {}
  }

  const z = tool.schema;

  function buildTeachingPrompt(problem: string, context: string | undefined, learnFrom: string): string {
    let prompt = `You are a senior expert helping a junior developer learn. The junior is stuck on a problem and needs your guidance.

## Problem
${problem}
`;
    if (context) {
      prompt += `
## What has been tried
${context}
`;
    }

    if (learnFrom === "reasoning") {
      prompt += `
## Instructions
Explain your REASONING PROCESS step by step. Focus on HOW you think about this problem, not just the answer. The goal is to teach the junior to solve similar problems independently in the future.

## Required Response Format
Your response MUST be structured EXACTLY as follows, with these exact section headers:

[Reasoning]
<Your step-by-step thinking process. Show HOW you approach the problem: what you notice first, what hypotheses you consider, why you rule some out, how you narrow down. This is the most important section for teaching.>

[Answer]
<Your final concrete answer, with code/commands/config as needed.>`;
    } else if (learnFrom === "solution") {
      prompt += `
## Instructions
Provide a clear, actionable SOLUTION. Be specific with code examples, commands, or configurations as needed.

## Required Response Format
Your response MUST be structured EXACTLY as follows, with these exact section headers:

[Reasoning]
<Brief explanation of your approach — why this solution works and what alternatives you considered.>

[Answer]
<Your concrete solution with code/commands/configs.>`;
    } else {
      prompt += `
## Instructions
First explain your reasoning process (how you approach this problem), then provide a concrete solution. The goal is both to solve the immediate problem AND teach the junior to handle similar situations independently.

## Required Response Format
Your response MUST be structured EXACTLY as follows, with these exact section headers:

[Reasoning]
<Your step-by-step thinking process. Show HOW you approach the problem: what you notice, what hypotheses you consider, why you rule some out, how you narrow down. This is the most important section for teaching.>

[Answer]
<Your final concrete solution with code/commands/configs as needed.>`;
    }

    return prompt;
  }

  return {
    dispose: async () => {
      try {
        await engine.shutdown();
      } catch (err) {
        console.error("[ai-agent-local-memory] shutdown failed:", err);
      }
    },

    config: async (config: any) => {
      const agentCfg = { ...(config.agent ?? {}) };
      if (!agentCfg["neural-historian"]) {
        agentCfg["neural-historian"] = {
          prompt: "You compress conversation history. Output STRICT JSON only: {\"p1\":\"...\",\"p2\":\"...\",\"p3\":\"...\"}. p1: paragraph <=150 tokens capturing goals, decisions, files/symbols, errors, current state. p2: single sentence <=25 tokens. p3: title <=8 tokens. Use same language as the conversation. Preserve concrete identifiers verbatim.",
          mode: "subagent",
          hidden: true,
          maxSteps: 3,
          steps: 3,
          permission: {
            bash: "deny",
            edit: "deny",
            write: "deny",
            webfetch: "deny",
          },
          tools: {
            bash: false,
            edit: false,
            write: false,
            read: false,
            grep: false,
            glob: false,
            webfetch: false,
            todowrite: false,
            task: false,
          },
        };
        config.agent = agentCfg;
      }
    },

    "chat.message": async (input: any, output: any) => {
      // Fires the instant the user hits Enter, independent of messages.transform.
      // If transform later hangs, OpenCode may never persist the message and the
      // plugin's graph-ingestion (inside transform's async tail) never runs — the
      // message is lost. MUST stay synchronous with no LLM/DB/network so this path
      // cannot hang or block the main session.
      try {
        const parts = output?.parts ?? [];
        const text = parts
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text ?? "")
          .join("\n")
          .trim();
        if (text && text.length >= 1) {
          (globalThis as any).__neuralMainBusyAt = Date.now();
          const sid =
            output?.message?.sessionID ??
            output?.info?.sessionID ??
            input?.message?.sessionID ??
            input?.sessionID ??
            "unknown";
          try {
            const pendingDir = join(dataBase, "ai-agent-local-memory", "pending-messages");
            mkdirSync(pendingDir, { recursive: true });
            const line = JSON.stringify({ ts: Date.now(), sid, role: "user", text: text.slice(0, 8000) }) + "\n";
            appendFileSync(join(pendingDir, `${sid}.log`), line);
          } catch {}
        }
        if (process.env.NEURAL_REPLAY_ORIG_SESSION_ID && text && text.length >= 5) {
          (globalThis as any).__neuralReplayLastUserMsg = { text, ts: Date.now() };
        }
      } catch {}
    },

    "tool.execute.after": async (input: any, output: any) => {
      try {
        if (!process.env.NEURAL_REPLAY_ORIG_SESSION_ID) return;
        mkdirSync(localTrainingDir, { recursive: true });
        const outStr = typeof output?.output === "string" ? output.output.slice(0, 6000) : JSON.stringify(output?.output ?? "").slice(0, 6000);
        const lastUser = (globalThis as any).__neuralReplayLastUserMsg?.text?.slice(0, 3000) ?? "";
        let thinking = "";
        try {
          const sid = input?.sessionID;
          if (sid) {
            const msgsResult = await client.session.messages({ path: { id: sid }, query: { limit: 5 } });
            const msgs = (msgsResult as any)?.data ?? [];
            for (let i = msgs.length - 1; i >= 0; i--) {
              const m = msgs[i];
              if (m?.info?.role !== "assistant") continue;
              const parts = m.parts ?? [];
              const txt = parts.filter((p: any) => p.type === "text").map((p: any) => p.text ?? "").join("\n");
              const match = txt.match(/<thinking>([\s\S]*?)<\/thinking>/i);
              if (match) { thinking = match[1].trim().slice(0, 3000); break; }
            }
          }
        } catch {}
        const sample: any = {
          instruction: "You are an autonomous coding agent. Given the user request, think step-by-step then decide the next tool call.",
          input: `[User request]\n${lastUser}\n\n[Next tool decision]`,
          output: thinking
            ? `<thinking>\n${thinking}\n</thinking>\n${JSON.stringify({ tool: input.tool, args: input.args }, null, 2)}`
            : JSON.stringify({ tool: input.tool, args: input.args }, null, 2),
          tool_result_preview: outStr.slice(0, 500),
          has_cot: !!thinking,
        };
        appendFileSync(join(localTrainingDir, "tool-calls.jsonl"), JSON.stringify(sample) + "\n");
      } catch {}
    },

    // Replay-mode tool interception. When env NEURAL_REPLAY_ORIG_SESSION_ID is set,
    // every tool call is served from that session's historical opencode.db results
    // instead of running for real. Requires the fork of opencode with the
    // tool.execute.before shortcircuit hook (branch replay-shortcircuit).
    "tool.execute.before": async (input: any, output: any) => {
      try {
        const tn = String(input?.tool ?? "");
        if (tn && !tn.startsWith("neural_")) (globalThis as any).__neuralMainBusyAt = Date.now();
      } catch {}
      try {
        const origSid = process.env.NEURAL_REPLAY_ORIG_SESSION_ID;
        if (!origSid) return;
        const openCodeDbPath = process.env.NEURAL_REPLAY_HISTORY_DB || join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "opencode.db");
        if (!existsSync(openCodeDbPath)) return;
        let Db: any = null;
        try { Db = require("bun:sqlite").Database; } catch {
          try { Db = require("better-sqlite3"); } catch {}
        }
        if (!Db) return;
        const db = new Db(openCodeDbPath, { readonly: true });
        try {
          const argsJson = JSON.stringify(output?.args ?? {});
          const currentArgs = output?.args ?? {};
          const currentKey = currentArgs.filePath || currentArgs.path || currentArgs.file || currentArgs.pattern || currentArgs.command || currentArgs.query || currentArgs.url;
          const rows = db.prepare(`
            SELECT p.data FROM part p
            JOIN message m ON m.id = p.message_id
            WHERE m.session_id = ?
              AND json_extract(p.data, '$.type') = 'tool'
              AND json_extract(p.data, '$.tool') = ?
              AND json_extract(p.data, '$.state.status') = 'completed'
            ORDER BY p.time_created
          `).all(origSid, input.tool) as Array<{ data: string }>;
          for (const row of rows) {
            const p = JSON.parse(row.data);
            const historyArgs = p?.state?.input ?? p?.state?.args ?? {};
            const historyKey = historyArgs.filePath || historyArgs.path || historyArgs.file || historyArgs.pattern || historyArgs.command || historyArgs.query || historyArgs.url;
            const exactMatch = JSON.stringify(historyArgs) === argsJson;
            const keyMatch = currentKey && historyKey && currentKey === historyKey;
            if (exactMatch || keyMatch) {
              const state = p.state ?? {};
              output.shortcircuit = {
                title: state.title || `[replay: ${input.tool}]`,
                output: typeof state.output === "string" ? state.output : JSON.stringify(state.output ?? ""),
                metadata: state.metadata ?? {},
              };
              if (process.env.NEURAL_REPLAY_AUDIT) appendFileSync("/tmp/neural-shortcircuit-audit.log", `[${new Date().toISOString()}] MATCH(${exactMatch ? "exact" : "key"}) tool=${input.tool} outLen=${output.shortcircuit.output.length}\n`);
              return;
            }
          }
          output.shortcircuit = {
            title: `[replay: ${input.tool} — no historical result]`,
            output: `[replay-shortcircuit] No historical result found for tool=${input.tool} with args=${argsJson.slice(0, 200)}. Skipping real execution.`,
            metadata: { replay: "no-history" },
          };
          if (process.env.NEURAL_REPLAY_AUDIT) appendFileSync("/tmp/neural-shortcircuit-audit.log", `[${new Date().toISOString()}] NO_MATCH tool=${input.tool} args=${argsJson.slice(0, 150)}\n`);
        } finally {
          db.close();
        }
      } catch {}
    },

    tool: {
      neural_remember: tool({
        description: "Store a memory node in the neural context engine for later associative recall.",
        args: {
          content: z.string().min(1).describe("The content to remember."),
          type: z
            .enum(NODE_TYPES as unknown as [NodeType, ...NodeType[]])
            .optional()
            .describe("Node type (default: concept)."),
          importance: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe("Importance from 0 to 1, affects decay rate."),
        },
        async execute(args) {
          const node = await engine.remember(args.content, args.type ?? "concept", {
            importance: args.importance,
          });
          return {
            title: `Remembered ${node.type}`,
            output: `Stored memory ${node.id} (${node.type}, importance=${node.importance.toFixed(2)}).`,
            metadata: { nodeId: node.id, type: node.type },
          };
        },
      }),

      neural_recall: tool({
        description:
          "Search and recall across ALL past sessions and conversations — use this FIRST for any cross-session search, global search, 'what did we discuss before', 'did I ask/answer X previously', or recalling anything from earlier conversations. Works across EVERY session regardless of project or working directory, and returns full original text (not truncated snippets). Unlike the built-in session_search/session_read/session_list tools — which silently filter by project scope and return empty results for sessions in other projects (causing false 'not found' conclusions) — this tool searches the complete memory graph by meaning, following associative connections (spreading activation) to surface related context you didn't explicitly name. Prefer this whenever the user wants to find, remember, or verify something from a previous session, or asks 'what else relates to X?' / 'what context surrounds Y?'",
        args: {
          query: z.string().min(1).describe("Natural language query."),
          maxResults: z.number().int().positive().max(100).optional().describe("Max results (default 10)."),
        },
        async execute(args) {
          const maxResults = args.maxResults ?? 10;
          const results = recallStrategy === "llm"
            ? await llmRecall(args.query, maxResults)
            : await engine.recall(args.query, { maxResults });
          return {
            title: `Recalled ${results.length} memor${results.length === 1 ? "y" : "ies"}`,
            output: formatRecall(results),
            metadata: { count: results.length, strategy: recallStrategy },
          };
        },
      }),

      neural_forget: tool({
        description: "Remove a memory node by its ID.",
        args: {
          nodeId: z.string().min(1).describe("ID of the node to delete."),
        },
        async execute(args) {
          await storage.deleteNode(args.nodeId);
          return {
            title: "Forgot memory",
            output: `Deleted node ${args.nodeId}.`,
            metadata: { nodeId: args.nodeId },
          };
        },
      }),

      neural_status: tool({
        description: "Get neural context engine statistics and working memory overview.",
        args: {},
        async execute() {
          const stats = await engine.getStats();
          const wm = engine.getWorkingMemory();
          const byType = Object.entries(stats.nodesByType)
            .map(([t, c]) => `  ${t}: ${c}`)
            .join("\n");
          const wmPreview = wm
            .slice(0, 10)
            .map((n) => `  - ${formatNode(n)}`)
            .join("\n");
          const output = [
            `Session: ${sessionId}`,
            `Nodes: ${stats.nodeCount}`,
            `Edges: ${stats.edgeCount}`,
            `Working memory: ${stats.workingMemorySize}`,
            "Nodes by type:",
            byType,
            "",
            `Top working memory (${Math.min(wm.length, 10)} of ${wm.length}):`,
            wmPreview || "  (empty)",
          ].join("\n");
          return {
            title: `Engine stats (${stats.nodeCount} nodes)`,
            output,
            metadata: { stats, workingMemorySize: wm.length },
          };
        },
      }),

      neural_reduce: tool({
        description:
          "Drop tagged content you no longer need. Use §N§ identifiers visible in conversation. Accepts ranges: '3-5', '1,2,9', '1-5,8'.",
        args: {
          drop: z.string().min(1).describe("Tag IDs to suppress, supports ranges."),
        },
        async execute(args) {
          const tags = parseTagRanges(args.drop);
          for (const t of tags) droppedTags.add(t);
          const episodes = await storage.queryNodes({ type: "episode", sourceSession: sessionId });
          let suppressed = 0;
          for (const node of episodes) {
            const ep = (node.metadata?.episodicData as Record<string, unknown> | undefined) ?? undefined;
            const tag = ep && typeof ep.tag === "number" ? (ep.tag as number) : undefined;
            if (tag !== undefined && tags.includes(tag)) {
              await storage.updateNode(node.id, {
                metadata: {
                  ...node.metadata,
                  episodicData: { ...ep, suppressed: true },
                },
              });
              suppressed++;
            }
          }
          return {
            title: `Suppressed ${suppressed} tag${suppressed === 1 ? "" : "s"}`,
            output: `Dropped tags ${tags.join(", ")} from context. Changes take effect next turn.`,
            metadata: { suppressed, requested: tags },
          };
        },
      }),

      neural_pin: tool({
        description: "Pin tagged content to always show at full fidelity. Use §N§ identifiers.",
        args: {
          tags: z.string().min(1).describe("Tag IDs to pin, supports ranges."),
        },
        async execute(args) {
          const tags = parseTagRanges(args.tags);
          const episodes = await storage.queryNodes({ type: "episode", sourceSession: sessionId });
          let pinned = 0;
          for (const node of episodes) {
            const ep = (node.metadata?.episodicData as Record<string, unknown> | undefined) ?? undefined;
            const tag = ep && typeof ep.tag === "number" ? (ep.tag as number) : undefined;
            if (tag !== undefined && tags.includes(tag)) {
              await storage.updateNode(node.id, {
                metadata: {
                  ...node.metadata,
                  episodicData: { ...ep, pinned: true },
                },
              });
              pinned++;
            }
          }
          return {
            title: `Pinned ${pinned} tag${pinned === 1 ? "" : "s"}`,
            output: `Marked ${pinned} episodic node(s) as pinned (requested tags: ${tags.join(", ")}).`,
            metadata: { pinned, requested: tags },
          };
        },
      }),

      neural_expand: tool({
        description: "Expand a compressed compartment from <session-history> back to full original text. Only use this when you see <compartment start=\"N\" end=\"M\"> in the session history and want to read the original conversation. NOT for expanding regular messages — those are already visible in full.",
        args: {
          tags: z.string().optional().describe("Tag numbers to restore if previously dropped via neural_reduce (e.g. '3-5', '1,2,9')."),
          start: z.number().int().optional().describe("Start ordinal from compartment's start attribute."),
          end: z.number().int().optional().describe("End ordinal from compartment's end attribute."),
        },
        async execute(args) {
          if (args.start !== undefined && args.end !== undefined) {
            try {
              const expandSessionId = currentOpenCodeSessionId || sessionId;
              const msgsResult = await client.session.messages({ path: { id: expandSessionId }, query: {} });
              if (!msgsResult.data) return { title: "Error", output: "Failed to read session messages." };
              
              const allMsgs = msgsResult.data;
              const slice = allMsgs.slice(args.start, args.end + 1);
              const texts: string[] = [];
              for (const msg of slice) {
                const role = msg.info.role;
                const textParts = msg.parts.filter((p: any) => p.type === "text");
                const content = textParts.map((p: any) => (p as { text?: string }).text ?? "").join("\n");
                if (content) texts.push(`[${role}] ${content}`);
              }
              if (texts.length === 0) return { title: "Empty", output: `No messages in range ${args.start}-${args.end}.` };
              return {
                title: `Expanded ${texts.length} messages (ordinal ${args.start}-${args.end})`,
                output: texts.join("\n\n---\n\n"),
              };
            } catch (e: any) {
              return { title: "Error", output: e.message };
            }
          }

          if (!args.tags) return { title: "Error", output: "Provide tags or start+end range." };
          const tagNumbers = parseTagRanges(args.tags);
          const episodes = await storage.queryNodes({ type: "episode", sourceSession: sessionId });
          const results: string[] = [];

          for (const node of episodes) {
            const ep = (node.metadata?.episodicData as Record<string, unknown> | undefined);
            const tag = ep && typeof ep.tag === "number" ? ep.tag : undefined;
            if (tag !== undefined && tagNumbers.includes(tag)) {
              const fidelity = ep?.fidelity as Record<string, string> | undefined;
              const fullText = fidelity?.f0 ?? node.content;
              results.push(`§${tag}§ [${ep?.role ?? "?"}]\n${fullText}`);
            }
          }

          if (results.length === 0) {
            return { title: "No matches", output: `No episodic nodes found for tags: ${tagNumbers.join(", ")}` };
          }
          return {
            title: `Expanded ${results.length} message(s)`,
            output: results.join("\n\n---\n\n"),
            metadata: { expanded: results.length, tags: tagNumbers },
          };
        },
      }),

      neural_import_history: tool({
        description:
          "Import conversation history from past OpenCode sessions into the neural memory graph. Processes messages, extracts entities, and builds associative edges. Use this to bootstrap the memory graph with existing knowledge.",
        args: {
          limit: z.number().int().positive().optional().describe("Max number of sessions to import (default: all)."),
          since: z.string().optional().describe("Only import sessions created after this date (ISO format, e.g. '2025-01-01')."),
        },
        async execute(args) {
          if (!client) {
            return { title: "Error", output: "OpenCode client not available." };
          }

          const sessionsResult = await client.session.list();
          if (!sessionsResult.data) {
            return { title: "Error", output: "Failed to list sessions." };
          }
          let sessions = sessionsResult.data;

          if (args.since) {
            const sinceMs = new Date(args.since).getTime();
            sessions = sessions.filter((s) => s.time.created >= sinceMs / 1000);
          }

          if (args.limit) {
            sessions = sessions.slice(0, args.limit);
          }

          let totalNodes = 0;
          let totalEdges = 0;
          let processed = 0;

          for (const session of sessions) {
            try {
              const msgsResult = await client.session.messages({ path: { id: session.id } });
              if (!msgsResult.data) continue;

              const messages = msgsResult.data.flatMap((msg) => {
                const role = msg.info.role;
                if (role !== "user" && role !== "assistant") return [];
                return msg.parts
                  .filter((p) => p.type === "text" && (p as { text?: string }).text)
                  .map((p) => ({
                    role: role as "user" | "assistant",
                    content: (p as { text: string }).text,
                    timestamp: msg.info.time?.created ? msg.info.time.created * 1000 : undefined,
                  }));
              });

              if (messages.length === 0) continue;

              await engine.ingest({
                id: session.id,
                messages,
              });

              processed++;
              const stats = await engine.getStats();
              totalNodes = stats.nodeCount;
              totalEdges = stats.edgeCount;
            } catch {
              continue;
            }
          }

          return {
            title: `Imported ${processed} session(s)`,
            output: `Processed ${processed}/${sessions.length} sessions.\nGraph now has ${totalNodes} nodes and ${totalEdges} edges.`,
            metadata: { processed, totalSessions: sessions.length, totalNodes, totalEdges },
          };
        },
      }),

      neural_backup: tool({
        description:
          "Backup the entire neural memory graph to a timestamped directory. Returns the backup path.",
        args: {
          destination: z.string().optional().describe("Custom backup directory. Default: ~/.local/share/ai-agent-local-memory/backups/<timestamp>/"),
        },
        async execute(args) {
          const { cpSync, mkdirSync } = await import("node:fs");
          const dataDir = process.env.AI_AGENT_LOCAL_MEMORY_DIR
            ? join(process.env.AI_AGENT_LOCAL_MEMORY_DIR)
            : join(homedir(), ".local", "share", "ai-agent-local-memory");
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          const backupDir = args.destination || join(dataDir, "backups", timestamp);

          mkdirSync(backupDir, { recursive: true });
          cpSync(dataDir, backupDir, {
            recursive: true,
            filter: (src) => !src.includes("/backups/"),
          });

          const { statSync, readdirSync } = await import("node:fs");
          let totalSize = 0;
          const countFiles = (dir: string): number => {
            let count = 0;
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              const p = join(dir, entry.name);
              if (entry.isDirectory()) {
                count += countFiles(p);
              } else {
                count++;
                totalSize += statSync(p).size;
              }
            }
            return count;
          };
          const fileCount = countFiles(backupDir);
          const sizeMB = (totalSize / 1024 / 1024).toFixed(2);

          return {
            title: `Backup complete (${sizeMB} MB)`,
            output: `Backed up to: ${backupDir}\nFiles: ${fileCount}\nSize: ${sizeMB} MB`,
            metadata: { backupDir, fileCount, sizeMB },
          };
        },
      }),

      neural_sync: tool({
        description:
          "Synchronize neural memory across machines via Git. Commits local changes, pulls remote changes, and replays new operations into the local graph.",
        args: {
          action: z.enum(["status", "push", "pull", "init", "export"]).optional().describe("Action: status (default), push (commit+push), pull (pull+replay), init (initialize sync repo), export (backfill existing memories into operation log)."),
          repoUrl: z.string().optional().describe("Git remote URL (required for init)."),
        },
        async execute(args) {
          const action = args.action ?? "status";
          const syncDir = join(homedir(), ".local", "share", "ai-agent-local-memory", "sync");

          if (action === "init") {
            if (!args.repoUrl) return { title: "Error", output: "repoUrl required for init." };
            const { execSync } = await import("node:child_process");
            const { mkdirSync } = await import("node:fs");
            mkdirSync(syncDir, { recursive: true });
            try {
              execSync(`git init && git remote add origin ${args.repoUrl}`, { cwd: syncDir });
              return { title: "Sync initialized", output: `Sync repo created at ${syncDir}\nRemote: ${args.repoUrl}` };
            } catch (e: any) {
              return { title: "Error", output: e.message };
            }
          }

          if (action === "status") {
            const { existsSync: ex, statSync } = await import("node:fs");
            if (!ex(syncDir)) return { title: "Not initialized", output: "Run neural_sync(action='init', repoUrl='...') first." };
            const logFile = join(syncDir, "operations.jsonl");
            const logExists = ex(logFile);
            const logSize = logExists ? statSync(logFile).size : 0;
            const pending = opLog.getPendingCount();
            return { title: "Sync status", output: `Sync dir: ${syncDir}\nLog: ${logExists ? `${logSize} bytes` : "empty"}\nPending ops: ${pending}\nAuto-sync: every 5 min` };
          }

          if (action === "push") {
            const { execSync } = await import("node:child_process");
            try {
              execSync('git add -A && git commit -m "sync: update operations" --allow-empty && git push', { cwd: syncDir });
              return { title: "Pushed", output: "Local operations committed and pushed." };
            } catch (e: any) {
              return { title: "Push failed", output: e.message };
            }
          }

          if (action === "pull") {
            const { execSync } = await import("node:child_process");
            try {
              execSync("git pull --rebase", { cwd: syncDir, stdio: "ignore" });
              const result = await opLog.replay(storage);
              let embedded = 0;
              if (result.applied > 0 && embeddingProvider) {
                const { EmbeddingLinker } = await import("@ai-agent-local-memory/core");
                const linker = new EmbeddingLinker(rawStorage, embeddingProvider, { batchSize: 32, similarityThreshold: 0.7 });
                const embResult = await linker.run({ limit: result.applied });
                embedded = embResult.embedded;
              }
              return { title: "Pulled", output: `Remote changes pulled.\nApplied: ${result.applied} operations, Skipped: ${result.skipped}.\nEmbedded: ${embedded} new nodes.` };
            } catch (e: any) {
              return { title: "Pull failed", output: e.message };
            }
          }

          if (action === "export") {
            const { readFileSync: rfs, existsSync: ex } = await import("node:fs");
            const logFile = join(syncDir, "operations.jsonl");
            const existingIds = new Set<string>();
            if (ex(logFile)) {
              const lines = rfs(logFile, "utf-8").trim().split("\n").filter(Boolean);
              for (const line of lines) {
                try {
                  const op = JSON.parse(line);
                  if (op.op === "add_node" && op.data?.id) existingIds.add(op.data.id);
                  if (op.op === "add_edge" && op.data) existingIds.add(`${op.data.src}|${op.data.dst}|${op.data.type}`);
                } catch {}
              }
            }

            const allNodes = await storage.getAllNodes();
            const allEdges = await storage.getAllEdges();
            let exported = 0;
            let skipped = 0;
            for (const node of allNodes) {
              if (existingIds.has(node.id)) { skipped++; continue; }
              const { metadata, ...nodeWithoutMeta } = node;
              const cleanMeta = metadata ? { ...metadata } : undefined;
              if (cleanMeta) delete (cleanMeta as any).embedding;
              opLog.append({ ts: node.createdAt || Date.now(), machine: opLog.machineId, op: "add_node", data: { ...nodeWithoutMeta, metadata: cleanMeta } });
              exported++;
            }
            for (const edge of allEdges) {
              const key = `${edge.src}|${edge.dst}|${edge.type}`;
              if (existingIds.has(key)) { skipped++; continue; }
              opLog.append({ ts: edge.lastCoactivated || Date.now(), machine: opLog.machineId, op: "add_edge", data: edge });
              exported++;
            }
            return { title: `Exported ${exported} operations`, output: `Backfilled ${allNodes.length} nodes + ${allEdges.length} edges.\nNew: ${exported}, Skipped (already in log): ${skipped}.\nRun neural_sync(action='push') to upload.` };
          }

          return { title: "Error", output: `Unknown action: ${action}` };
        },
      }),

      neural_ask_server: tool({
        description:
          "Consult the server-side LLM (OpenCode's configured model) for problems the local agent cannot solve. Creates a sub-session, sends the problem, gets back reasoning and solution, then stores the experience for future recall. Use when: (1) user says '问一下大模型' or 'ask the server model', (2) you've failed to solve a problem after multiple attempts, (3) you encounter something beyond your knowledge.",
        args: {
          problem: z.string().min(1).describe("Description of the problem or question to ask the server LLM."),
          context: z.string().optional().describe("Additional context: what you've already tried, relevant code snippets, error messages."),
          learnFrom: z.enum(["reasoning", "solution", "both"]).optional().describe("What to learn from the response: reasoning process, final solution, or both (default: both)."),
        },
        async execute(args) {
          const learnFrom = args.learnFrom ?? "both";

          // Phase 1: Local LLM pre-processing (if available)
          let refinedProblem = args.problem;
          let refinedContext = args.context;
          let localPreAnalysis = "";

          if (llmProvider) {
            try {
              // Step 1: Check existing experiences first — maybe we already know the answer
              const existingExp = await engine.recall(args.problem, 3);
              const relevantExp = existingExp.filter((n: any) => n.type === "experience" && n.content);
              if (relevantExp.length > 0) {
                const expSummary = relevantExp.map((n: any) => n.content.slice(0, 500)).join("\n---\n");
                // Ask local LLM: is this already answered by existing experience?
                const checkPrompt = `You are evaluating whether existing experience answers a new problem.

Problem: ${args.problem}
${args.context ? `Context: ${args.context}` : ""}

Existing experiences:
${expSummary}

If the existing experience FULLY answers the problem, respond with:
RESOLVED: [brief answer extracted from experience]

If NOT fully resolved, respond with:
ESCALATE: [refined problem statement focusing on what's still unknown]`;

                const checkResult = await llmProvider.complete(checkPrompt, { maxTokens: 500 });
                if (checkResult.startsWith("RESOLVED:")) {
                  const answer = checkResult.replace("RESOLVED:", "").trim();
                  return {
                    title: "Resolved from experience",
                    output: `Found answer from past experience:\n\n${answer}\n\n(Source: previously learned from server LLM)`,
                    metadata: { learned: false, fromExperience: true },
                  };
                } else if (checkResult.startsWith("ESCALATE:")) {
                  refinedProblem = checkResult.replace("ESCALATE:", "").trim();
                }
              }

              // Step 2: Local LLM refines the problem + context for server LLM
              const refinePrompt = `You are preparing a question to ask a senior expert. Make the question clear, specific, and well-structured.

Original problem: ${args.problem}
${args.context ? `Context provided: ${args.context}` : "No additional context."}

Rewrite as a focused, well-structured question for the expert. Include:
1. Core question (1-2 sentences)
2. Key constraints or requirements
3. What has been tried (if any)

Output ONLY the refined question, nothing else.`;

              const refined = await llmProvider.complete(refinePrompt, { maxTokens: 800 });
              if (refined && refined.length > 20) {
                refinedProblem = refined;
              }

              // Step 3: Local LLM pre-analysis — what angles should server LLM consider?
              const analysisPrompt = `Briefly analyze this problem and suggest 2-3 angles the expert should consider:

Problem: ${refinedProblem}

List the angles in 1-2 sentences each. Be concise.`;

              localPreAnalysis = await llmProvider.complete(analysisPrompt, { maxTokens: 300 });
            } catch {
              // Local LLM failure is non-fatal — proceed with original problem
            }
          }

          // Phase 2: Server LLM consultation
          const teachingPrompt = buildTeachingPrompt(refinedProblem, refinedContext, learnFrom);

          try {
            const childSession = await client.session.create({
              body: { system: teachingPrompt },
            });
            const childId = childSession.data?.id;
            if (!childId) {
              return { title: "Error", output: "Failed to create sub-session for server LLM consultation." };
            }

            let userMessage = refinedProblem;
            if (refinedContext) userMessage += `\n\nContext:\n${refinedContext}`;
            if (localPreAnalysis) userMessage += `\n\nPre-analysis (from local model):\n${localPreAnalysis}`;

            await client.session.promptAsync({
              path: { id: childId },
              body: { parts: [{ type: "text", text: userMessage }] },
            });

            await new Promise(r => setTimeout(r, 30000));

            const childMsgs = await client.session.messages({ path: { id: childId }, query: { limit: 5 } });
            let response = "";
            if (childMsgs.data) {
              for (const msg of childMsgs.data) {
                if (msg.info?.role === "assistant") {
                  const textParts = (msg.parts ?? []).filter((p: any) => p.type === "text");
                  response = textParts.map((p: any) => (p as { text?: string }).text ?? "").join("\n");
                  break;
                }
              }
            }

            try { await client.session.delete({ path: { id: childId } }); } catch {}

            if (!response) {
              return { title: "No response", output: "Server LLM did not return a response within timeout." };
            }

            // Phase 3: Store experience
            const experienceContent = `[Problem] ${args.problem}\n[Refined] ${refinedProblem}\n[Server Response] ${response.slice(0, 3000)}`;
            await engine.remember(experienceContent, "experience", {
              importance: 0.9,
              metadata: {
                experienceData: {
                  source: "server_llm",
                  problem: args.problem.slice(0, 200),
                  refinedProblem: refinedProblem.slice(0, 200),
                  learnFrom,
                  hadLocalPreAnalysis: !!localPreAnalysis,
                  timestamp: Date.now(),
                },
              },
            });

            if (localLlmMode === "student" || localLlmMode === "primary") {
              try {
                const { mkdirSync: mkDir, appendFileSync } = await import("node:fs");
                mkDir(localTrainingDir, { recursive: true });
                const trainingPair = {
                  instruction: "You are a helpful AI assistant. Answer the user's question thoroughly with clear reasoning.",
                  input: refinedProblem.slice(0, 4000),
                  output: response.slice(0, 8000),
                };
                appendFileSync(join(localTrainingDir, "pairs.jsonl"), JSON.stringify(trainingPair) + "\n");
              } catch {}
            }

            return {
              title: "Server LLM consulted",
              output: response,
              metadata: { learned: true, learnFrom, localPreProcessed: !!llmProvider },
            };
          } catch (err: any) {
            return {
              title: "Server LLM error",
              output: `Failed to consult server LLM: ${err?.message ?? String(err)}`,
            };
          }
        },
      }),

      neural_export_training: tool({
        description: "Export accumulated experience data as MLX LoRA training format (JSONL). Run this before fine-tuning the local LLM.",
        args: {},
        async execute() {
          const db = rawStorage.getDb();
          const experiences = db.prepare(
            `SELECT id, content, metadata, createdAt FROM nodes WHERE type = 'experience' ORDER BY createdAt ASC`
          ).all() as Array<{ id: string; content: string; metadata: string | null; createdAt: number }>;

          if (experiences.length === 0) {
            return { title: "No data", output: "No experience nodes found. Use neural_ask_server to accumulate learning data first." };
          }

          const trainingData: Array<{ instruction: string; input: string; output: string }> = [];
          let skipped = 0;

          for (const exp of experiences) {
            const problemMatch = exp.content.match(/\[Problem\]\s*(.*?)(?=\[Refined\]|\[Server Response\])/s);
            const refinedMatch = exp.content.match(/\[Refined\]\s*(.*?)(?=\[Server Response\])/s);
            const responseMatch = exp.content.match(/\[Server Response\]\s*(.*)/s);

            if (!problemMatch || !responseMatch) { skipped++; continue; }

            trainingData.push({
              instruction: "You are a senior expert. Solve the following problem with clear reasoning and a concrete solution.",
              input: (refinedMatch?.[1] || problemMatch[1]).trim(),
              output: responseMatch[1].trim(),
            });
          }

          const outputDir = join(homedir(), ".local", "share", "ai-agent-local-memory", "lora-training");
          const { mkdirSync: mkDir, writeFileSync: writeF } = await import("node:fs");
          mkDir(outputDir, { recursive: true });

          const validCount = trainingData.length >= 10 ? Math.max(2, Math.floor(trainingData.length * 0.1)) : 0;
          const trainData = validCount > 0 ? trainingData.slice(0, -validCount) : trainingData;
          const validData = validCount > 0 ? trainingData.slice(-validCount) : trainingData;

          writeF(join(outputDir, "train.jsonl"), trainData.map(d => JSON.stringify(d)).join("\n") + "\n");
          writeF(join(outputDir, "valid.jsonl"), validData.map(d => JSON.stringify(d)).join("\n") + "\n");

          return {
            title: "Training data exported",
            output: `Exported ${trainingData.length} examples (${trainData.length} train, ${validData.length} valid) to ${outputDir}/\nSkipped: ${skipped}\n\nNext step: cd packages/lora-pipeline && ./train.sh`,
          };
        },
      }),

      neural_session_import: tool({
        description:
          "Import an OpenCode session from the sync repo into this machine's opencode.db. Use when you moved to a new machine and want to continue a session that was written on another device. Requires that the sync repo (git-backed) already has the session exported by the other machine.",
        args: {
          sessionId: z.string().min(1).describe("The OpenCode session ID to import, e.g. 'ses_abc123...'."),
          overwrite: z.boolean().optional().describe("If true, re-insert messages even if they already exist locally (default false — safe idempotent replay)."),
        },
        async execute(args) {
          const sessionExportDir = join(syncDir, "opencode-sessions");
          const jsonlPath = join(sessionExportDir, `${args.sessionId}.jsonl`);
          const metaPath = join(sessionExportDir, `${args.sessionId}.session.json`);
          if (!existsSync(jsonlPath)) {
            return { title: "Not found", output: `No exported data for session ${args.sessionId}. Ensure the other machine has pushed and this machine has pulled the sync repo.` };
          }
          const openCodeDbPath = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "opencode.db");
          if (!existsSync(openCodeDbPath)) {
            return { title: "No opencode.db", output: "OpenCode has never been run on this machine — start OpenCode once (any session) to create the database first." };
          }
          let Db: any = null;
          try { Db = require("bun:sqlite").Database; } catch {
            try { Db = require("better-sqlite3"); } catch {}
          }
          if (!Db) return { title: "No SQLite", output: "bun:sqlite / better-sqlite3 unavailable in this runtime." };

          const db = new Db(openCodeDbPath);
          let sessionInserted = false;
          let msgCount = 0;
          let partCount = 0;
          try {
            if (existsSync(metaPath)) {
              const sess = JSON.parse(readFileSync(metaPath, "utf-8"));
              const cols = Object.keys(sess);
              const placeholders = cols.map(() => "?").join(",");
              const verb = args.overwrite ? "INSERT OR REPLACE" : "INSERT OR IGNORE";
              const info = db.prepare(`${verb} INTO session (${cols.map(c => `\`${c}\``).join(",")}) VALUES (${placeholders})`).run(...cols.map(c => sess[c]));
              sessionInserted = info.changes > 0;
            }
            const lines = readFileSync(jsonlPath, "utf-8").split("\n").filter(l => l.trim());
            const verbMsg = args.overwrite ? "INSERT OR REPLACE" : "INSERT OR IGNORE";
            for (const line of lines) {
              const { msg, parts } = JSON.parse(line) as { msg: any; parts: any[] };
              const mCols = Object.keys(msg);
              const mInfo = db.prepare(`${verbMsg} INTO message (${mCols.map(c => `\`${c}\``).join(",")}) VALUES (${mCols.map(() => "?").join(",")})`).run(...mCols.map(c => msg[c]));
              if (mInfo.changes > 0) msgCount++;
              for (const p of parts) {
                const pCols = Object.keys(p);
                const pInfo = db.prepare(`${verbMsg} INTO part (${pCols.map(c => `\`${c}\``).join(",")}) VALUES (${pCols.map(() => "?").join(",")})`).run(...pCols.map(c => p[c]));
                if (pInfo.changes > 0) partCount++;
              }
            }
          } finally {
            db.close();
          }
          return {
            title: "Session imported",
            output: `Session ${args.sessionId}: ${sessionInserted ? "created" : "already existed"}; ${msgCount} new messages, ${partCount} new parts inserted. Reopen OpenCode to see the session.`,
          };
        },
      }),

      neural_note: tool({
        description:
          "Save or manage durable notes/facts that persist across conversation and survive compression. Facts are automatically surfaced in context when relevant concepts activate.",
        args: {
          action: z.enum(["write", "read", "dismiss"]).optional().describe("Operation: write (default), read, or dismiss."),
          content: z.string().optional().describe("Note text (required for write)."),
          scope: z.enum(["session", "project", "global"]).optional().describe("Scope: session (default), project, or global."),
          noteId: z.string().optional().describe("Note ID (required for dismiss)."),
        },
        async execute(args) {
          const action = args.action ?? "write";

          if (action === "write") {
            if (!args.content) return { title: "Error", output: "Content is required for write." };
            const factData = {
              scope: args.scope ?? "session",
              activationFloor: 0.5,
              ready: true,
            };
            const node = await engine.remember(args.content, "fact", {
              importance: 0.9,
              metadata: { factData, sourceSession: sessionId },
            });
            return {
              title: "Note saved",
              output: `Saved note ${node.id} (scope=${factData.scope}).`,
              metadata: { noteId: node.id, scope: factData.scope },
            };
          }

          if (action === "read") {
            const facts = await storage.queryNodes({ type: "fact" });
            const relevant = facts.filter((f) => {
              const fd = f.metadata?.factData as Record<string, unknown> | undefined;
              if (!fd) return false;
              if (fd.scope === "session") return f.sourceSession === sessionId;
              return true;
            });
            if (relevant.length === 0) return { title: "No notes", output: "No saved notes found." };
            const list = relevant
              .map((f, i) => {
                const fd = f.metadata?.factData as Record<string, unknown> | undefined;
                return `${i + 1}. [${fd?.scope ?? "?"}] id=${f.id}\n   ${f.content}`;
              })
              .join("\n\n");
            return { title: `${relevant.length} note(s)`, output: list };
          }

          if (action === "dismiss") {
            if (!args.noteId) return { title: "Error", output: "noteId is required for dismiss." };
            await storage.deleteNode(args.noteId);
            return { title: "Note dismissed", output: `Deleted note ${args.noteId}.` };
          }

          return { title: "Error", output: `Unknown action: ${action}` };
        },
      }),

      neural_session_read: tool({
        description: "Read messages from another OpenCode session. Use this when the user asks about something from a different session or you need context from past conversations.",
        args: {
          sessionId: z.string().optional().describe("Session ID to read (e.g. 'ses_abc123'). If omitted, lists recent sessions."),
          limit: z.number().int().positive().optional().describe("Max messages to return (default: 20)."),
        },
        async execute(args) {
          if (!client) {
            return { title: "Error", output: "OpenCode client not available." };
          }

          if (!args.sessionId) {
            const sessionsResult = await client.session.list();
            if (!sessionsResult.data) return { title: "Error", output: "Failed to list sessions." };
            const sessions = sessionsResult.data.slice(0, 20);
            const list = sessions.map((s, i) => `${i + 1}. ${s.id} — "${s.title}" (${new Date(s.time.created * 1000).toLocaleDateString()})`).join("\n");
            return { title: `${sessions.length} recent sessions`, output: list };
          }

          const msgsResult = await client.session.messages({ path: { id: args.sessionId }, query: { limit: args.limit ?? 20 } });
          if (!msgsResult.data) return { title: "Error", output: `Failed to read session ${args.sessionId}.` };

          const texts: string[] = [];
          for (const msg of msgsResult.data) {
            const role = msg.info.role;
            for (const part of msg.parts) {
              if (part.type === "text" && (part as { text?: string }).text) {
                const text = (part as { text: string }).text;
                texts.push(`[${role}] ${text.slice(0, 500)}${text.length > 500 ? "..." : ""}`);
              }
            }
          }

          if (texts.length === 0) return { title: "Empty", output: `No text messages found in session ${args.sessionId}.` };
          return {
            title: `${texts.length} messages from ${args.sessionId}`,
            output: texts.join("\n\n"),
            metadata: { sessionId: args.sessionId, messageCount: texts.length },
          };
        },
      }),

      neural_read: tool({
        description:
          "Curate character material for the agent from a URL or a block of text (the 'family picks the books' path). Extracts candidate values/cultural patterns and stores them as PENDING for review — they do NOT influence the agent until you approve them with neural_adopt. Use this to deliberately teach the agent principles, worldview, or working norms from an article, essay, code-of-conduct, or your own written guidance. This is distinct from the Dreamer, which absorbs character passively from conversation.",
        args: {
          source: z.string().min(1).describe("A URL to fetch, or 'text' to indicate the material is passed inline via the text field."),
          text: z.string().optional().describe("Inline material to extract from (used when source is not a fetchable URL)."),
        },
        async execute(args) {
          let material = "";
          const looksLikeUrl = /^https?:\/\//i.test(args.source.trim());
          if (looksLikeUrl) {
            try {
              const res = await fetch(args.source.trim(), { redirect: "follow" });
              if (!res.ok) return { title: "Fetch failed", output: `HTTP ${res.status} fetching ${args.source}` };
              material = await res.text();
              // Strip obvious HTML tags so the LLM sees prose, not markup.
              material = material.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
            } catch (e) {
              return { title: "Fetch error", output: `Could not fetch ${args.source}: ${(e as Error).message}` };
            }
          } else {
            material = (args.text ?? args.source).trim();
          }
          if (material.length < 20) return { title: "Nothing to read", output: "Material too short to extract character traits from." };
          material = material.slice(0, 12000);

          const origin = looksLikeUrl ? args.source.trim() : "inline-text";
          const backend = pluginConfig.readExtractBackend ?? "server";

          if (backend === "local") {
            const readPrompt = `${NEURAL_READ_PROMPT_HEAD}\n\nMATERIAL:\n${material}\n\nJSON:`;
            const resp = await historianLlm.complete(readPrompt, { maxTokens: 900 });
            if (!resp) return { title: "Extraction failed", output: "The extraction model returned no response." };
            const items = salvageReadItems(resp);
            if (items.length === 0) return { title: "No candidates", output: "No character traits could be extracted from the material." };
            const stored = await storeReadTraits(items, origin);
            try {
              mkdirSync(join(dataBase, "ai-agent-local-memory"), { recursive: true });
              writeFileSync(readingStatePath(), JSON.stringify({ lastOutcome: "done", updatedAt: Date.now() }));
            } catch {}
            if (stored.length === 0) return { title: "No candidates", output: "No qualifying character traits found in the material." };
            const list = stored
              .map((s, i) => `${i + 1}. [${s.type}/${s.layer}] (conf=${s.confidence.toFixed(2)}) ${s.trait}\n   id=${s.id}`)
              .join("\n");
            return {
              title: `${stored.length} pending trait${stored.length === 1 ? "" : "s"}`,
              output: `Extracted ${stored.length} candidate trait(s), stored as PENDING. Approve with neural_adopt(ids=[...]):\n\n${list}`,
              metadata: { count: stored.length, ids: stored.map((s) => s.id), status: "pending" },
            };
          }

          runNeuralReadServer(material, origin);
          return {
            title: "Reading in background",
            output: "Started reading the material in the background on the main model. It will yield immediately if you type or the session gets busy, and whatever was extracted is saved as PENDING traits. Check /tmp/neural-read-result.txt for the outcome, then approve with neural_adopt.",
            metadata: { status: "background", backend: "server" },
          };
        },
      }),


      neural_adopt: tool({
        description:
          "Approve pending character traits created by neural_read so they start influencing the agent. Pass the ids (or leave empty to adopt ALL currently pending traits). Adopted traits join the same value/culture pool as passively-learned ones but are marked curated — they take effect immediately and bypass the corroboration gate because you vetted them.",
        args: {
          ids: z.array(z.string()).optional().describe("Node ids to adopt. If omitted, adopts all pending curated traits."),
        },
        async execute(args) {
          const pending = [
            ...(await storage.queryNodes({ type: "value" })),
            ...(await storage.queryNodes({ type: "culture" })),
          ].filter((n) => (n.metadata as any)?.characterData?.reviewStatus === "pending");

          if (pending.length === 0) return { title: "Nothing pending", output: "There are no pending curated traits to adopt." };

          const adoptAll = !args.ids || args.ids.length === 0;
          const wanted = adoptAll ? null : new Set(args.ids);
          const target = wanted ? pending.filter((n) => wanted.has(n.id)) : pending;
          if (target.length === 0) return { title: "No match", output: `None of the given ids matched a pending trait. Pending ids: ${pending.map((n) => n.id).join(", ")}` };

          const adopted: string[] = [];
          for (const n of target) {
            const cd = (n.metadata as any)?.characterData ?? {};
            try {
              await storage.putNode({
                ...n,
                lastAccessed: Date.now(),
                metadata: { ...n.metadata, characterData: { ...cd, reviewStatus: "ready" } },
              } as any);
              adopted.push(n.content.slice(0, 80));
            } catch {}
          }
          const remaining = pending.length - adopted.length;
          if (adopted.length > 0) {
            try {
              mkdirSync(join(dataBase, "ai-agent-local-memory"), { recursive: true });
              writeFileSync(join(dataBase, "ai-agent-local-memory", ".reading-state.json"), JSON.stringify({ lastOutcome: "done", updatedAt: Date.now() }));
            } catch {}
          }
          return {
            title: `Adopted ${adopted.length} trait${adopted.length === 1 ? "" : "s"}`,
            output: `Now influencing the agent:\n${adopted.map((c, i) => `${i + 1}. ${c}`).join("\n")}${remaining > 0 ? `\n\n(${remaining} trait(s) still pending)` : ""}`,
            metadata: { adopted: adopted.length, remaining },
          };
        },
      }),
    },

    "experimental.chat.messages.transform": magicContextPresent
      ? undefined
      : async (input, output) => {
      try { writeFileSync("/tmp/neural-transform-heartbeat.log", `${new Date().toISOString()} msgs=${output.messages?.length ?? 0}\n`, { flag: "a" }); } catch {}
      // Hoisted above the try so the post-catch fallback block (which restores these on an
      // empty render) can still see them; block-scoping them inside the try caused a
      // ReferenceError that crashed every transform on the !hasContent path.
      const RENDERED_SENTINEL = Symbol.for("ai-agent-local-memory.rendered");
      const originalMessagesSnapshot = (output.messages ?? []).slice();
      try {
        const messages = output.messages;
        if (!messages || messages.length === 0) return;

        // Idempotency guard. OpenCode may invoke this transform more than once per turn
        // on the SAME output.messages reference (mutated in place). We detect this ONLY via a
        // non-enumerable Symbol on the array object — NOT via a §N§ text scan. The §N§ tags we
        // prepend get persisted into opencode's DB and reappear as ordinary input on later
        // turns; a text scan then false-positives on any array containing tagged history and
        // no-ops the whole thing, emitting thousands of un-compressed messages ("Input is too
        // long"). The Symbol lives only on the live array reference, so it cannot leak via the
        // DB. Per-part re-tagging is already guarded (startsWith("§")), so a rare missed no-op
        // just re-renders harmlessly rather than double-tagging.
        if ((messages as any)[RENDERED_SENTINEL]) {
          try {
            writeFileSync("/tmp/neural-echo-diag.log",
              `${new Date().toISOString()} out=${messages.length} IDEMPOTENT-NOOP (already rendered)\n`,
              { flag: "a" });
          } catch {}
          return;
        }


        const openCodeSessionId = (() => {
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg.info?.role === "user" && typeof msg.info.sessionID === "string") {
              return msg.info.sessionID;
            }
          }
          return sessionId;
        })();
        currentOpenCodeSessionId = openCodeSessionId;

        const estimateTokens = (text: string) => {
          if (text.length < 200) {
            let tokens = 0;
            for (let i = 0; i < text.length; i++) {
              const code = text.charCodeAt(i);
              if (code > 0x4E00 && code < 0x9FFF) tokens += 0.7;
              else if (code > 0x3000 && code < 0x303F) tokens += 0.5;
              else if (code > 0xAC00 && code < 0xD7AF) tokens += 0.7;
              else if (code > 0x3040 && code < 0x30FF) tokens += 0.7;
              else tokens += 0.28;
            }
            return Math.ceil(tokens);
          }
          // Longer text: sample 64 chars at 4 anchor points for CJK ratio, extrapolate.
          const sampleSize = 64;
          const anchors = [0, Math.floor(text.length * 0.33), Math.floor(text.length * 0.66), Math.max(0, text.length - sampleSize)];
          let sampledChars = 0;
          let sampledTokens = 0;
          for (const anchor of anchors) {
            const end = Math.min(anchor + sampleSize, text.length);
            for (let i = anchor; i < end; i++) {
              const code = text.charCodeAt(i);
              if (code > 0x4E00 && code < 0x9FFF) sampledTokens += 0.7;
              else if (code > 0x3000 && code < 0x303F) sampledTokens += 0.5;
              else if (code > 0xAC00 && code < 0xD7AF) sampledTokens += 0.7;
              else if (code > 0x3040 && code < 0x30FF) sampledTokens += 0.7;
              else sampledTokens += 0.28;
              sampledChars++;
            }
          }
          const avgTokensPerChar = sampledChars > 0 ? sampledTokens / sampledChars : 0.28;
          return Math.ceil(text.length * avgTokensPerChar);
        };

        // A part's billable size is NOT just part.text. tool parts carry their command
        // and output under state.input/state.output (avg 42KB, up to 2MB), which the
        // model is actually charged for. Counting only part.text estimated tool parts as
        // ~0, so the tail budget kept 500+ messages whose real size was 200K+ tokens —
        // the true cause of "Input is too long" at a falsely-low reported usage.
        const partBillableText = (part: any): string => {
          if (typeof part?.text === "string" && part.text) return part.text;
          // tool_result parts in the transform array carry their payload under `content`
          // (shape {type, tool_use_id, content}); tool_use parts carry `input`. DB-shaped
          // parts use state.input/state.output. Cover all three or tool payloads score 0.
          if (typeof part?.content === "string" && part.content) return part.content;
          if (part?.content !== undefined && part?.content !== null && typeof part.content !== "string") {
            try { return JSON.stringify(part.content); } catch { /* fall through */ }
          }
          if (part?.input !== undefined) {
            return typeof part.input === "string" ? part.input : (() => { try { return JSON.stringify(part.input); } catch { return ""; } })();
          }
          const st = part?.state;
          if (st && typeof st === "object") {
            let s = "";
            if (st.input !== undefined) s += typeof st.input === "string" ? st.input : JSON.stringify(st.input);
            if (st.output !== undefined) s += typeof st.output === "string" ? st.output : JSON.stringify(st.output);
            return s;
          }
          return "";
        };

        const FILLER_WORDS = /\b(basically|actually|really|just|very|quite|pretty|somewhat|certainly|definitely|obviously|clearly|simply|literally|honestly|frankly|anyway|so|well|now|then|also|still|already|even)\b/gi;
        const HEDGING = /\b(I think|I believe|I would say|it seems like|it appears that|in my opinion|from my perspective|if you will|sort of|kind of|more or less|to be honest|at the end of the day)\b/gi;
        const PLEASANTRIES = /\b(please|thanks|thank you|kindly|if possible)\b/gi;

        const cavemanCompress = (text: string, level: "lite" | "full" | "ultra"): string => {
          let w = text;
          w = w.replace(FILLER_WORDS, "");
          w = w.replace(HEDGING, "");
          w = w.replace(PLEASANTRIES, "");
          if (level === "full" || level === "ultra") {
            w = w.replace(/\b(the|a|an)\b/gi, "");
            w = w.replace(/\b(is|are|was|were|has been|have been|will be|would be|could be|should be)\b/gi, "");
          }
          if (level === "ultra") {
            w = w.replace(/\b(however|therefore|furthermore|additionally|moreover|nevertheless|consequently)\b/gi, "→");
            w = w.replace(/\bfor example\b/gi, "eg");
            w = w.replace(/\bin order to\b/gi, "to");
            w = w.replace(/\bas well as\b/gi, "&");
          }
          w = w.replace(/  +/g, " ").replace(/\n{3,}/g, "\n\n").trim();
          return w;
        };

        const contextLimit = pluginConfig.contextWindowTokens ?? 128000;
        const EXECUTE_THRESHOLD = 65;
        const HISTORY_BUDGET_PCT = 0.15;
        const PROTECTED_TAGS_COUNT = pluginConfig.protectedTags ?? 20;
        const CLEAR_REASONING_AGE = 50;
        const TRIGGER_BUDGET_PCT = 0.05;
        const TRIGGER_MULTIPLIER = 3;
        const HISTORIAN_CHUNK_PCT = 0.25;
        const FORCE_COMPARTMENT_PCT = 80;
        const TARGET_USAGE_PCT = 0.55;
        const ABORT_PCT = 95;
        const historyBudgetTokens = Math.round(contextLimit * HISTORY_BUDGET_PCT);
        const triggerBudget = Math.max(5000, Math.min(50000, Math.round(contextLimit * TRIGGER_BUDGET_PCT)));

        const realUsage = getContextUsage(openCodeSessionId);
        const usagePct = realUsage.percentage;

        const lastAssistantModel = (() => {
          for (let i = messages.length - 1; i >= 0; i--) {
            const info = messages[i].info;
            if (info?.role === "assistant" && info.providerID && info.modelID) {
              return { providerID: info.providerID, modelID: info.modelID };
            }
          }
          return null;
        })();

        if (lastAssistantModel && lastModelKey) {
          const newKey = `${lastAssistantModel.providerID}/${lastAssistantModel.modelID}`;
          if (lastModelKey !== newKey) {
            lastModelKey = newKey;
            lastContextPercentage = 0;
            reasoningWatermark = 0;
          }
        } else if (lastAssistantModel) {
          lastModelKey = `${lastAssistantModel.providerID}/${lastAssistantModel.modelID}`;
        }

        setActiveTokenizerModel(lastAssistantModel?.modelID ?? lastModelKey);

        if (realUsage.percentage > 0) {
          lastContextPercentage = realUsage.percentage;
        }

        const isMidTurn = (() => {
          // Mirror magic-context: derive mid-turn from the latest assistant's finish
          // reason in OpenCode's DB, not from the transform messages array. The array's
          // last entry is often the just-arrived user message, which made the old
          // array-tail check misreport mid-turn as false and mishandle rapid double-sends.
          if (openCodeDb) {
            try {
              const row = openCodeDb.prepare(
                `SELECT json_extract(data, '$.finish') AS finish
                 FROM opencode.message
                 WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant'
                 ORDER BY time_created DESC LIMIT 1`
              ).get(openCodeSessionId) as { finish: string | null } | undefined;
              if (row && row.finish === "tool-calls") return true;
            } catch {}
          }
          if (messages.length === 0) return false;
          const last = messages[messages.length - 1];
          return last.info?.role === "assistant" && (last.parts ?? []).some((p: any) => p.type === "tool_call");
        })();

        let schedulerDecision: "execute" | "defer" | "skip" = "skip";
        if (usagePct >= EXECUTE_THRESHOLD) {
          schedulerDecision = isMidTurn ? "defer" : "execute";
        } else if (usagePct >= EXECUTE_THRESHOLD - 2) {
          schedulerDecision = "defer";
        }

        let compartments = compartmentStore.getForSession(openCodeSessionId);

        const rendered: Array<any> = [];

        // Compartments are injected via system.transform — NOT as fake user messages here.
        // This avoids LLM language confusion (English summaries as "user" messages)
        // and double-injection of the same content.

        // Locate the tail by the last compartment's endMessageId inside the CURRENT transform
        // array, not by a persisted array index. opencode hands transform a differently-sized
        // array each pass (parts expand/collapse), so a stored index points at the wrong
        // message on the next pass — that misalignment stalled compression ("Input too long").
        const msgIdToIndex = new Map<string, number>();
        for (let i = 0; i < messages.length; i++) {
          const mid = messages[i].info?.id;
          if (typeof mid === "string") msgIdToIndex.set(mid, i);
        }
        const lastEndMessageId = compartments.length > 0 ? compartments[compartments.length - 1].endMessageId : "";
        let tailStart: number;
        if (lastEndMessageId && msgIdToIndex.has(lastEndMessageId)) {
          tailStart = (msgIdToIndex.get(lastEndMessageId) as number) + 1;
        } else {
          tailStart = 0;
        }
        let maxCompartOrd = compartments.length > 0 ? compartments[compartments.length - 1].endOrd : -1;
        let tail: Array<any>;

        // L2 headroom reserve: transform sees only the conversation, but opencode
        // later prepends system prompt + tool schemas billed heavier than estimate
        // (~1.51x/1.57x). Spending the full TARGET_USAGE_PCT on conversation lets
        // system+tools overflow the assembled request ("Input too long" mid-turn).
        const SYSTEM_TOOLS_RESERVE_PCT = pluginConfig.systemToolsReservePct ?? 0.18;
        const systemToolsReserveTokens = Math.round(contextLimit * SYSTEM_TOOLS_RESERVE_PCT);
        // L4 circuit breaker: when the historian keeps failing (413/timeout), no
        // compartment is produced so the tail cannot shrink and the next request
        // 413s again. Each consecutive failure halves the tail budget (down to a
        // floor) so the wire request drops below the limit even without compaction.
        const breakerFactor = Math.max(0.25, Math.pow(0.5, Math.min(historianFailureCount, 3)));
        const tailBudgetTokens = Math.max(
          Math.round(contextLimit * 0.1),
          Math.round((Math.round(contextLimit * TARGET_USAGE_PCT) - systemToolsReserveTokens) * breakerFactor),
        );

        // L1 microCompact MUST run before the L2 budget scan below: it stubs oversized
        // tool outputs on messages[] so the scan measures post-stub sizes. Mutating
        // messages[] propagates into the tail slice (shared object refs). Reordering
        // reintroduces the "Input too long" under-budgeting bug.
        const MICROCOMPACT_TRIGGER_CHARS = 50000;
        const MICROCOMPACT_STUB_CHARS = 2000;
        const MICROCOMPACT_KEEP_RECENT = 3;
        {
          const largeToolMsgIdx: number[] = [];
          for (let i = 0; i < messages.length; i++) {
            for (const part of (messages[i].parts ?? [])) {
              const st = (part as any).state;
              const out = st && typeof st.output === "string" ? st.output : (typeof (part as any).content === "string" ? (part as any).content : "");
              if (out && out.length > MICROCOMPACT_TRIGGER_CHARS) { largeToolMsgIdx.push(i); break; }
            }
          }
          const microKeepFrom = largeToolMsgIdx.length > MICROCOMPACT_KEEP_RECENT
            ? largeToolMsgIdx[largeToolMsgIdx.length - MICROCOMPACT_KEEP_RECENT]
            : Infinity;
          for (const i of largeToolMsgIdx) {
            if (i >= microKeepFrom) continue;
            for (const part of (messages[i].parts ?? [])) {
              const st = (part as any).state;
              if (st && typeof st.output === "string" && st.output.length > MICROCOMPACT_TRIGGER_CHARS) {
                st.output = st.output.slice(0, MICROCOMPACT_STUB_CHARS) + "\n…[large tool result compacted]";
              }
              if (typeof (part as any).content === "string" && (part as any).content.length > MICROCOMPACT_TRIGGER_CHARS) {
                (part as any).content = (part as any).content.slice(0, MICROCOMPACT_STUB_CHARS) + "\n…[large tool result compacted]";
              }
            }
          }
        }
        {
          // Always run the token-budget scan from the end backward — never emit the
          // whole array unbounded. The removed `if (messages.length <= tailStart)`
          // escape hatch emitted every message with no budget, which is exactly how
          // a bounded-usage session still produced "Input is too long" (out=512).
          // tailStart is only a floor: we won't cross below it (compartment coverage),
          // but the budget can cut the tail shorter.
          const floor = Math.max(0, Math.min(tailStart, messages.length));
          let tailTokens = 0;
          let startIdx = messages.length;
          for (let i = messages.length - 1; i >= floor; i--) {
            let msgTokens = 10;
            for (const part of (messages[i].parts ?? [])) {
              const text = partBillableText(part);
              if (text) msgTokens += countClaudeTokens(text);
            }
            if (tailTokens + msgTokens > tailBudgetTokens) break;
            tailTokens += msgTokens;
            startIdx = i;
          }

          if (lastTailStartIdx >= floor && lastTailStartIdx <= startIdx + 5 && lastTailStartIdx < messages.length) {
            startIdx = lastTailStartIdx;
          }
          lastTailStartIdx = startIdx;

          tail = messages.slice(startIdx);
          if (tail.length === 0) {
            tail = messages.slice(-1);
          }
        }

        const tailActualStart = messages.length - tail.length;
        let tagCounter = tailActualStart;
        let prevTimestamp = 0;
        const maxTag = tailActualStart + tail.length;
        const protectedFloor = maxTag - PROTECTED_TAGS_COUNT;
        const reasoningCutoff = maxTag - CLEAR_REASONING_AGE;

        const seenToolOutputs = new Map<string, number>();
        const toolFingerprints = new Map<string, number[]>();

        for (let i = 0; i < tail.length; i++) {
          const msg = tail[i];
          if (msg.info?.role === "tool" || ((msg.parts ?? []).some((p: any) => p.type === "tool_call"))) {
            const toolName = msg.info?.toolName ?? msg.info?.tool ?? (msg.parts ?? []).find((p: any) => p.type === "tool_call")?.name ?? "";
            const inputText = (msg.parts ?? []).map((p: any) => p.text ?? JSON.stringify(p.input ?? "")).join("").slice(0, 300);
            const fingerprint = `${toolName}:${inputText}`;
            const group = toolFingerprints.get(fingerprint) ?? [];
            group.push(i);
            toolFingerprints.set(fingerprint, group);
          }
        }

        const toolDropIndices = new Set<number>();
        for (const [, indices] of toolFingerprints) {
          if (indices.length <= 1) continue;
          for (let k = 0; k < indices.length - 1; k++) {
            const idx = indices[k];
            if (tailActualStart + idx <= protectedFloor) {
              toolDropIndices.add(idx);
            }
          }
        }

        const STRUCTURAL_NOISE_TYPES = new Set(["meta", "step-start", "step-finish"]);

        for (let i = 0; i < tail.length; i++) {
          const msg = tail[i];
          for (let pi = 0; pi < (msg.parts ?? []).length; pi++) {
            const part = msg.parts[pi];
            if (STRUCTURAL_NOISE_TYPES.has(part?.type)) {
              msg.parts[pi] = { type: "text", text: "" };
            }
          }
        }

        const cavemanEligibleCount = Math.max(0, tail.length - PROTECTED_TAGS_COUNT);
        for (let i = 0; i < cavemanEligibleCount; i++) {
          const msg = tail[i];
          if (msg.info?.role !== "user" && msg.info?.role !== "assistant") continue;
          const fraction = i / cavemanEligibleCount;
          let level: "lite" | "full" | "ultra" | null = null;
          if (fraction < 0.2) level = "ultra";
          else if (fraction < 0.4) level = "full";
          else if (fraction < 0.6) level = "lite";
          if (!level) continue;
          for (const part of (msg.parts ?? [])) {
            if (part.type === "text" && part.text && part.text.length > 200) {
              part.text = cavemanCompress(part.text, level);
            }
          }
        }

        // Truncate oversized tool outputs in the non-protected tail. opencode's wire
        // builder embeds part.state.output verbatim (a single tool result can be 2MB),
        // and mid-turn we don't recompress — so one big tool result mid-conversation
        // pushed the prompt past the model limit ("replied a bit, then Input too long").
        // Mirror magic-context's sentinel approach: overwrite state.output/content with
        // a bounded stub in the non-protected region.
        const TOOL_OUTPUT_MAX_CHARS = 4000;
        const toolTruncFloor = Math.max(0, tail.length - PROTECTED_TAGS_COUNT);
        for (let i = 0; i < toolTruncFloor; i++) {
          for (const part of (tail[i].parts ?? [])) {
            const st = (part as any).state;
            if (st && typeof st.output === "string" && st.output.length > TOOL_OUTPUT_MAX_CHARS) {
              st.output = st.output.slice(0, TOOL_OUTPUT_MAX_CHARS) + "\n…[tool output truncated for context]";
            }
            if (typeof (part as any).content === "string" && (part as any).content.length > TOOL_OUTPUT_MAX_CHARS) {
              (part as any).content = (part as any).content.slice(0, TOOL_OUTPUT_MAX_CHARS) + "\n…[tool output truncated for context]";
            }
          }
        }

        let prevRole = "";
        for (let i = 0; i < tail.length; i++) {
          const msg = tail[i];
          tagCounter++;

          if (droppedTags.has(tagCounter) || toolDropIndices.has(i)) {
            rendered.push({
              info: msg.info,
              parts: [{ type: "text", text: "" }],
            });
            prevRole = msg.info?.role ?? "";
            continue;
          }

          const isProtected = tagCounter > protectedFloor;
          const ts = msg.info?.time?.created ? msg.info.time.created * 1000 : 0;

          if (prevTimestamp > 0 && ts > 0 && msg.info?.role === "user") {
            const gap = ts - prevTimestamp;
            if (gap > 5 * 60 * 1000) {
              const minutes = Math.round(gap / 60000);
              let label: string;
              if (minutes < 60) label = `+${minutes}m`;
              else if (minutes < 1440) label = `+${Math.floor(minutes / 60)}h ${minutes % 60}m`;
              else label = `+${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
              for (const part of (msg.parts ?? [])) {
                if (part.type === "text" && part.text) {
                  part.text = `<!-- ${label} -->\n${part.text}`;
                  break;
                }
              }
            }
          }
          if (ts > 0) prevTimestamp = ts;

          if (!isProtected && msg.info?.role === "assistant") {
            if (tagCounter <= reasoningCutoff || tagCounter <= reasoningWatermark) {
              for (let pi = 0; pi < (msg.parts ?? []).length; pi++) {
                const part = msg.parts[pi];
                if (part.type === "reasoning" || part.type === "thinking") {
                  msg.parts[pi] = { type: "text", text: "" };
                }
              }
              for (const part of (msg.parts ?? [])) {
                if (part.type === "text" && part.text) {
                  part.text = part.text.replace(/<(?:thinking|think)>[\s\S]*?<\/(?:thinking|think)>\s*/g, "").trim();
                }
              }
            }

            const firstInRun = prevRole !== "assistant";
            if (!firstInRun) {
              for (let pi = 0; pi < (msg.parts ?? []).length; pi++) {
                const part = msg.parts[pi];
                if (part.type === "reasoning" || part.type === "thinking") {
                  msg.parts[pi] = { type: "text", text: "" };
                }
              }
            }
          }

          if (!isProtected && (msg.info?.role === "tool" || msg.info?.role === "assistant")) {
            for (let pi = 0; pi < (msg.parts ?? []).length; pi++) {
              const part = msg.parts[pi];
              if (part.type === "tool" && part.state?.status === "error" && typeof part.state.error === "string" && part.state.error.length > 100) {
                part.state.error = part.state.error.slice(0, 100) + "... [truncated]";
              }
              if (part.type === "tool_result") {
                const text = part.text ?? "";
                if (text.length > 300) {
                  const toolName = msg.info?.toolName ?? msg.info?.tool ?? "";
                  const dedupeKey = `${toolName}:${text.slice(0, 200)}`;
                  const prevIdx = seenToolOutputs.get(dedupeKey);
                  if (prevIdx !== undefined && prevIdx !== i) {
                    part.text = "";
                  } else {
                    seenToolOutputs.set(dedupeKey, i);
                    let compressed = text.slice(0, 600);
                    compressed = compressed.replace(/\n{3,}/g, "\n\n");
                    compressed = compressed.replace(/^[ \t]+/gm, "");
                    compressed = compressed.replace(/(.{1,80})\1{2,}/g, "$1 [×repeated]");
                    part.text = compressed + (text.length > 600 ? "\n...[truncated]..." : "");
                  }
                }
              }
              if (part.type === "tool_call" && part.name === "neural_reduce" && tagCounter <= protectedFloor - 5) {
                msg.parts[pi] = { type: "text", text: "" };
              }
            }
          }

          const KNOWN_PART_TYPES = new Set(["text", "tool_call", "tool_result", "tool", "reasoning", "thinking", "image", "file"]);
          msg.parts = (msg.parts ?? []).filter((p: any) => KNOWN_PART_TYPES.has(p.type));
          if (msg.parts.length === 0) continue;

          for (const part of msg.parts) {
            if (part.type === "text" && part.text !== undefined && part.text !== "" && !part.text.startsWith("§")) {
              part.text = `§${tagCounter}§ ${part.text}`;
              break;
            }
          }

          rendered.push(msg);
          prevRole = msg.info?.role ?? "";
        }

        if (schedulerDecision === "execute" && !isMidTurn) {
          const newWatermark = maxTag - CLEAR_REASONING_AGE;
          if (newWatermark > reasoningWatermark) {
            reasoningWatermark = newWatermark;
            try {
              rawStorage.getDb().prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES ('reasoning_watermark', ?)`).run(String(newWatermark));
            } catch {}
          }
        }

        if (rendered.length > 0) {
          const skippedCount = tailActualStart - tailStart;
          if (skippedCount > 20) {
            const skippedSummaries: string[] = [];
            for (let i = tailStart; i < tailActualStart; i++) {
              const m = messages[i];
              if (m.info?.role !== "user") continue;
              const text = (m.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => (p as { text?: string }).text ?? "").join(" ").trim();
              if (text.length < 5) continue;
              skippedSummaries.push(text.slice(0, 80));
              if (skippedSummaries.length >= 50) break;
            }
            if (skippedSummaries.length > 0) {
              const summaryMsg = {
                info: { role: "user" },
                parts: [{ type: "text", text: `<earlier-topics count="${skippedCount} messages not shown">\n${skippedSummaries.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n</earlier-topics>` }]
              };
              rendered.unshift(summaryMsg);
            }
          }

          // Orphan tool_result sweep (Pass A/B/C). Anthropic returns a pre-stream 400
          // ("tool_result block(s) provided when previous message does not contain
          // tool_use blocks") if a rendered user message carries a tool_result whose
          // matching assistant tool_use was dropped by tail-cut or dedup. That 400
          // arrives before any SSE frame, so opencode clears the input and renders
          // nothing — the "message vanishes, zero reaction" bug on reloaded old sessions.
          // Fix pairs by id, never by position. (Oracle-designed pass.)
          {
            // Pass A: collect every live tool_use id in the window. This build models
            // tool calls two ways in the same array: DB-shaped { type:"tool", callID }
            // and Anthropic-shaped { type:"tool_call", ... }. tool_result parts pair via
            // snake_case `tool_use_id`. Collect ALL of them or the sweep deletes valid
            // results. (part.id is the row id prt_xxx — NOT a tool_use id; do not use it.)
            const liveToolUseIds = new Set<string>();
            let toolCallPartCount = 0;
            for (const m of rendered) {
              if (m.info?.role !== "assistant" && m.info?.role !== "tool") continue;
              for (const p of (m.parts ?? []) as any[]) {
                if (p?.type === "tool") {
                  toolCallPartCount++;
                  if (typeof p.callID === "string") liveToolUseIds.add(p.callID);
                  else if (typeof p.tool_use_id === "string") liveToolUseIds.add(p.tool_use_id);
                  else if (typeof p.id === "string" && p.id.startsWith("toolu")) liveToolUseIds.add(p.id);
                } else if (p?.type === "tool_call") {
                  toolCallPartCount++;
                  if (typeof p.callID === "string") liveToolUseIds.add(p.callID);
                  else if (typeof p.tool_use_id === "string") liveToolUseIds.add(p.tool_use_id);
                  else if (typeof p.id === "string" && p.id.startsWith("toolu")) liveToolUseIds.add(p.id);
                }
              }
            }

            // Pass B: drop any tool_result whose tool_use_id is not in the live set.
            // Pair by id, never by position.
            for (const m of rendered) {
              if (m.info?.role !== "user") continue;
              m.parts = ((m.parts ?? []) as any[]).filter(
                (p) => p?.type !== "tool_result" || (typeof p.tool_use_id === "string" && liveToolUseIds.has(p.tool_use_id))
              );
            }

            // Pass C: remove user messages emptied by Pass B. Keep non-user messages
            // and any user message that still has parts. If everything collapsed, the
            // Pass D fixup below will re-inject a sentinel.
            for (let i = rendered.length - 1; i >= 0; i--) {
              const m = rendered[i];
              if (m.info?.role === "user" && (m.parts?.length ?? 0) === 0) rendered.splice(i, 1);
            }

            try {
              const orphanRemaining = rendered.length > 0
                ? ((rendered[0].parts ?? []) as any[]).some((p) => p?.type === "tool_result")
                : false;
              writeFileSync(`/tmp/neural-orphan-sweep-${openCodeSessionId}.log`,
                `${new Date().toISOString()} liveIds=${liveToolUseIds.size} toolCallParts=${toolCallPartCount} renderedAfter=${rendered.length} head0StillToolResult=${orphanRemaining}\n`,
                { flag: "a" as any });
            } catch {}
          }

          // Anthropic rejects a conversation that ends in an assistant-prefill position:
          // "must end with a user message". A trailing user turn whose ONLY parts are
          // tool_result blocks (a tool answered, awaiting the assistant) IS such a state,
          // as is a trailing assistant turn or one of our emptied dedup stubs. Normalize
          // the boundary in place before splicing back. (Oracle-designed Pass D.)
          {
            const SENTINEL = () => ({ type: "text", text: "Please continue." });
            const isToolResult = (p: any) => p?.type === "tool_result";
            const isPureEmptyStub = (m: any) =>
              (m.parts ?? []).length > 0 &&
              (m.parts ?? []).every((p: any) => p?.type === "text" && ((p.text ?? "").trim() === ""));
            const containsToolResult = (m: any) => (m.parts ?? []).some(isToolResult);
            const allPartsAreToolResult = (parts: any[]) =>
              (parts ?? []).length > 0 && (parts ?? []).every(isToolResult);

            // 1. Pop trailing pure-empty stubs (our own dedup artifacts), but never pop a
            //    message carrying a tool_result — that would orphan its assistant tool_use.
            while (rendered.length > 1) {
              const last = rendered[rendered.length - 1];
              if (isPureEmptyStub(last) && !containsToolResult(last)) rendered.pop();
              else break;
            }

            if (rendered.length === 0) {
              rendered.push({ info: { role: "user" }, parts: [SENTINEL()] });
            } else {
              const last: any = rendered[rendered.length - 1];
              const role = last.info?.role;
              if (role === "assistant") {
                rendered.push({ info: { role: "user" }, parts: [SENTINEL()] });
              } else if (role === "user" && allPartsAreToolResult(last.parts)) {
                last.parts.push(SENTINEL());
              } else if (role === "user" && isPureEmptyStub(last)) {
                last.parts = [SENTINEL()];
              }
            }
          }

          messages.splice(0, messages.length, ...rendered);

          const lastUserMsg = rendered.findLast((m: any) => m.info?.role === "user");
          if (lastUserMsg) {
            const userText = (lastUserMsg.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => (p as { text?: string }).text ?? "").join(" ");
            const triggers = ["问一下大模型", "问大模型", "ask the server", "ask server model", "consult server"];
            if (triggers.some(t => userText.includes(t))) {
              messages.push({
                info: { role: "user" },
                parts: [{ type: "text", text: "[System hint: The user wants to consult the server LLM. Call neural_ask_server with the current problem extracted from context.]" }],
              });
            }

            if (localLlmMode === "student") {
              const dissatisfactionSignals = ["不对", "错了", "wrong", "no that's not", "重做", "再试", "try again", "不是这样", "搞错了"];
              if (dissatisfactionSignals.some(s => userText.toLowerCase().includes(s))) {
                dissatisfactionCount++;
                if (dissatisfactionCount >= autoEscalateAfter) {
                  messages.push({
                    info: { role: "user" },
                    parts: [{ type: "text", text: `[System hint: The user has expressed dissatisfaction ${dissatisfactionCount} times. Your confidence should be LOW. Consider calling neural_ask_server for the current problem.]` }],
                  });
                }
              } else if (userText.length > 10) {
                dissatisfactionCount = Math.max(0, dissatisfactionCount - 1);
              }
            }
          }
          try {
            const toolPartSample = (() => {
              for (const m of messages) {
                for (const p of (m.parts ?? [])) {
                  if ((p as any).type === "tool" || (p as any).type === "tool_result" || (p as any).type === "tool_call") {
                    return { keys: Object.keys(p as any), billableLen: partBillableText(p).length, raw: JSON.stringify(p).slice(0, 300) };
                  }
                }
              }
              return null;
            })();
            let tailEstTokens = 0;
            for (const m of messages) {
              for (const p of (m.parts ?? [])) {
                const t = partBillableText(p);
                if (t) { tailEstTokens += countClaudeTokens(t); }
              }
            }
            writeFileSync(`/tmp/neural-rendered-${openCodeSessionId}.json`, JSON.stringify({
              ts: Date.now(),
              renderedCount: rendered.length,
              inputMsgCount: messages.length,
              tailEstTokens,
              tailBudgetTokens,
              contextLimit,
              toolPartSample,
              msgIdSample: messages.slice(0, 3).map((m: any) => m.info?.id ?? null),
              msgIdCoverage: messages.filter((m: any) => m.info?.id).length + "/" + messages.length,
              firstMsg: rendered[0] ? { role: rendered[0].info?.role, partsCount: rendered[0].parts?.length, partTypes: (rendered[0].parts ?? []).map((p: any) => p.type) } : null,
              lastMsg: rendered[rendered.length - 1] ? { role: rendered[rendered.length - 1].info?.role, partsCount: rendered[rendered.length - 1].parts?.length, partTypes: (rendered[rendered.length - 1].parts ?? []).map((p: any) => p.type) } : null,
            }, null, 2));
          } catch {}
        }

        historianTurnCount++;
        const tailCount = Math.max(0, tail.length - PROTECTED_TAGS_COUNT);
        const tailTokensEstimate = tailCount * 500;

        const hasUncoveredNewMessages = (() => {
          if (lastCompressTime === 0) return false;
          for (let i = tailStart; i < messages.length; i++) {
            const msgTime = messages[i].info?.time?.created ? messages[i].info.time.created * 1000 : 0;
            if (msgTime > lastCompressTime) return true;
          }
          return false;
        })();

        const shouldFireHistorian = (() => {
          if (!historian) return false;
          if (hasUncoveredNewMessages && tailCount > 6) return true;
          if (usagePct >= FORCE_COMPARTMENT_PCT) return true;
          if (tailTokensEstimate >= triggerBudget * TRIGGER_MULTIPLIER) return true;
          if (usagePct >= EXECUTE_THRESHOLD - 2 && tailCount > 6) return true;
          return false;
        })();

        const lastEndOrd = compartments.length > 0 ? compartments[compartments.length - 1].endOrd : 0;
        const dbListFull = getSessionMessageList(openCodeSessionId);
        if (shouldFireHistorian && dbListFull.length - lastEndOrd > PROTECTED_TAGS_COUNT + 1) {
          const historianChunkTokens = Math.max(8000, Math.min(50000, Math.round(contextLimit * 0.25)));
          const chunkSize = Math.round(historianChunkTokens / 500);
          // Build the compression window straight from the DB (stable ordinals + ids),
          // not from the mutated transform array. The array was already spliced/tagged
          // and dropping id-unmatched entries left compartments covering almost nothing.
          const windowMsgs = getSessionMessagePartsForOrds(
            openCodeSessionId,
            lastEndOrd + 1,
            lastEndOrd + chunkSize
          );

          if (usagePct >= FORCE_COMPARTMENT_PCT && !isMidTurn) {
            writeFileSync("/tmp/neural-compress-notify.txt", `⏳ Context at ${Math.round(usagePct)}% — compressing history (background)...`);
            if (!compressInFlight.has(openCodeSessionId)) {
              compressInFlight.add(openCodeSessionId);
              (async () => {
                try {
                  const compressPromise = (historian as any).compress(openCodeSessionId, windowMsgs);
                  const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 60000));
                  const result = await Promise.race([compressPromise, timeoutPromise]).catch(() => null) as any;
                  if (result) {
                    compartmentStore.save(result);
                    lastCompressTime = Date.now();
                    try { rawStorage.getDb().prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES ('last_compress_time', ?)`).run(String(lastCompressTime)); } catch {}
                  }
                } catch (compressErr: any) {
                  try { writeFileSync("/tmp/neural-compress-error.log", `${Date.now()} [force] ${compressErr?.message ?? compressErr}\n${compressErr?.stack ?? ""}\n`, { flag: "a" }); } catch {}
                } finally { compressInFlight.delete(openCodeSessionId); }
              })();
            }
          } else if (usagePct >= ABORT_PCT) {
            if (!compressInFlight.has(openCodeSessionId)) {
              compressInFlight.add(openCodeSessionId);
              (async () => {
                try {
                  const compressPromise = (historian as any).compress(openCodeSessionId, windowMsgs);
                  const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 60000));
                  const result = await Promise.race([compressPromise, timeoutPromise]).catch(() => null) as any;
                  if (result) {
                    compartmentStore.save(result);
                    lastCompressTime = Date.now();
                    try { rawStorage.getDb().prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES ('last_compress_time', ?)`).run(String(lastCompressTime)); } catch {}
                  }
                } catch (compressErr: any) {
                  try { writeFileSync("/tmp/neural-compress-error.log", `${Date.now()} [abort] ${compressErr?.message ?? compressErr}\n${compressErr?.stack ?? ""}\n`, { flag: "a" }); } catch {}
                } finally { compressInFlight.delete(openCodeSessionId); }
              })();
            }
          } else {
            if (compressInFlight.has(openCodeSessionId)) {
              // one background historian is already running for this session — don't spawn another;
              // magic-context serializes historian to one at a time via compartmentInProgress flag.
              // extra concurrent historians pile up in opencode's single event loop, delaying user turns.
            } else {
              compressInFlight.add(openCodeSessionId);
              (async () => {
              try {
                // Use opencode's built-in historian agent to keep sub-session light.
                // Without body.agent="historian" opencode inherits parent's full-weight agent
                // (Sisyphus - Ultraworker) which does long reasoning + tool loops, taking 3-5 min
                // per historian pass and blocking the parent's next transform.
                const childSession = await client.session.create({
                  body: { title: "neural-compartment" },
                } as any);
                if (!childSession.data) return;
                const childId = childSession.data.id;

                const historianPrompt = `You compress conversation history into three fidelity tiers.
Output STRICT JSON: { "p1": "...", "p2": "...", "p3": "..." }

p1: One paragraph (≤150 tokens). Capture: user goals, decisions made, files/symbols touched, errors hit, current state. Past tense. No filler.
p2: One sentence (≤25 tokens). The single most important thing that happened.
p3: A title (≤8 tokens). Like a git commit subject.

IMPORTANT: Write p1, p2, p3 in the SAME LANGUAGE the user uses in the conversation. If user writes Chinese, output Chinese. If English, output English.
Preserve concrete identifiers verbatim: file paths, function names, error strings. Drop pleasantries and tool boilerplate.

CONVERSATION:
${windowMsgs.map(m => `[${m.role}]: ${m.content}`).join("\n\n")}

JSON:`;

                await client.session.promptAsync({
                  path: { id: childId },
                  body: { agent: "neural-historian", parts: [{ type: "text", text: historianPrompt }] },
                } as any);

                await new Promise(r => setTimeout(r, 15000));

                const childMsgs = await client.session.messages({ path: { id: childId }, query: { limit: 5 } });
                if (childMsgs.data) {
                  for (const msg of childMsgs.data) {
                    if (msg.info.role !== "assistant") continue;
                    for (const part of msg.parts) {
                      if (part.type !== "text") continue;
                      const text = (part as { text?: string }).text ?? "";
                      const jsonMatch = text.match(/\{[\s\S]*\}/);
                      if (!jsonMatch) continue;
                      try {
                        const parsed = JSON.parse(jsonMatch[0]);
                        if (parsed.p1 && parsed.p2 && parsed.p3) {
                          compartmentStore.save({
                            sessionId: openCodeSessionId,
                            startOrd: windowMsgs[0].ord,
                            endOrd: windowMsgs[windowMsgs.length - 1].ord,
                            startMessageId: windowMsgs[0].id ?? "",
                            endMessageId: windowMsgs[windowMsgs.length - 1].id ?? "",
                            p1: String(parsed.p1),
                            p2: String(parsed.p2),
                            p3: String(parsed.p3),
                            tokenCount: Math.round(windowMsgs.reduce((s, m) => s + m.content.length, 0) / 4),
                            createdAt: Date.now(),
                          });
                          historianFailureCount = 0;
                          lastCompressTime = Date.now();
                          try { rawStorage.getDb().prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES ('last_compress_time', ?)`).run(String(lastCompressTime)); } catch {}

                          try {
                            await engine.remember(
                              `[${parsed.p3}] ${parsed.p1}`,
                              "episode",
                              { importance: 0.6, metadata: { sourceSession: sessionId, startOrd: windowMsgs[0].ord, endOrd: windowMsgs[windowMsgs.length - 1].ord } }
                            );
                          } catch {}
                        }
                      } catch {
                        historianFailureCount++;
                      }
                    }
                  }
                }

                try { await client.session.delete({ path: { id: childId } }); } catch {}
              } catch {
                historianFailureCount++;
              } finally { compressInFlight.delete(openCodeSessionId); }
            })();
            }
          }
        }

        setTimeout(async () => {
          try {
            const linker = new LightweightLinker(rawStorage);
            const lastMsgs = messages.slice(-2);
            for (const msg of lastMsgs) {
              const role = msg.info?.role;
              if (role !== "user" && role !== "assistant") continue;
              const textParts = (msg.parts ?? []).filter((p: any) => p.type === "text");
              const content = textParts.map((p: any) => p.text ?? "").join("\n").trim();
              if (content.length < 10 || content.length > 3000) continue;
              turnCounter++;
              const node = {
                id: crypto.randomUUID(),
                type: "episode" as const,
                content: content.slice(0, 2000),
                importance: role === "user" ? 0.6 : 0.5,
                strength: 0.5,
                accessCount: 0,
                lastAccessed: Date.now(),
                createdAt: Date.now(),
                sourceSession: sessionId,
              };
              const stored = await safePutNode(node);
              if (!stored) continue;
              await linker.linkToExisting(node);
            }
          } catch {}
          try { await (globalThis as any).__neuralMaybeRunDreamer?.(); } catch {}
        }, 500);

        const afterPct = realUsage.percentage > 0
          ? Math.round(realUsage.percentage * (rendered.length / Math.max(messages.length, 1)))
          : Math.round((rendered.length * 500 / contextLimit) * 100);
        writeFileSync("/tmp/neural-compartment-status.json", JSON.stringify({
          ts: Date.now(),
          beforePct: Math.round(usagePct || (messages.length * 500 / contextLimit) * 100),
          afterPct,
          compartments: compartments.length,
          scheduler: schedulerDecision,
          historianFailures: historianFailureCount,
          openCodeSessionId,
          realUsagePct: realUsage.percentage,
          msgCount: messages.length,
          renderedCount: rendered.length,
          msgSizes: messages.slice(0, 5).map((m: any) => JSON.stringify(m.parts ?? []).length),
        }));
      } catch (transformErr: any) {
        try { writeFileSync("/tmp/neural-transform-error.log", `${Date.now()} ${transformErr?.message ?? transformErr}\n${transformErr?.stack ?? ""}\n`, { flag: "a" }); } catch {}
      }
      if (output.messages) {
        const hasContent = output.messages.some((m: any) =>
          (m.parts ?? []).some((p: any) => p.type === "text" && p.text && p.text.trim().length > 0)
        );
        if (!hasContent) {
          // Never emit a bare "." (the "I see just a period" bug). An empty render means
          // our filter over-pruned — hand back the caller's original messages untouched.
          output.messages.length = 0;
          for (const m of originalMessagesSnapshot) output.messages.push(m);
        }
        try {
          Object.defineProperty(output.messages, RENDERED_SENTINEL, { value: true, enumerable: false, configurable: true });
        } catch {}
        try {
          const roleSeq = output.messages.slice(-6).map((m: any) => m.info?.role ?? "?").join(",");
          const lastMsg = output.messages[output.messages.length - 1];
          const lastText = (lastMsg?.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text ?? "").join("").slice(0, 60);
          writeFileSync("/tmp/neural-echo-diag.log",
            `${new Date().toISOString()} out=${output.messages.length} tailRoles=[${roleSeq}] lastRole=${lastMsg?.info?.role} hadContent=${hasContent} lastText=${JSON.stringify(lastText)}\n`,
            { flag: "a" });
        } catch {}
      }
    },

    "experimental.chat.system.transform": async (_input, output) => {
      try {
        writeFileSync("/tmp/neural-system-transform.log", `${Date.now()} start\n`);
        const facts = await storage.queryNodes({ type: "fact" });
        writeFileSync("/tmp/neural-system-transform.log", `${Date.now()} facts=${facts.length}\n`);
        const relevantFacts = facts.filter((f) => {
          const fd = f.metadata?.factData as Record<string, unknown> | undefined;
          if (!fd) return false;
          if (fd.scope === "session") return f.sourceSession === sessionId;
          return true;
        });

        const blocks: string[] = [];

        if (!magicContextPresent && currentOpenCodeSessionId) {
          const sysSessionId = currentOpenCodeSessionId;
          const compartments = compartmentStore.getForSession(sysSessionId);
          if (compartments.length > 0) {
            blocks.push("<session-history>");
            for (const c of compartments) {
              blocks.push(`<compartment start="${c.startOrd}" end="${c.endOrd}" title="${c.p3}">`);
              blocks.push(c.p1);
              blocks.push("</compartment>");
            }
            blocks.push("</session-history>");
          }
        }

        if (relevantFacts.length > 0) {
          blocks.push("");
          blocks.push("<project-memory>");
          for (const f of relevantFacts) {
            const fd = f.metadata?.factData as Record<string, unknown> | undefined;
            blocks.push(`  <memory id="${f.id.slice(0, 8)}" category="${fd?.scope ?? "global"}">${f.content}</memory>`);
          }
          blocks.push("</project-memory>");
        }

        const charNodes = [
          ...(await storage.queryNodes({ type: "value" })),
          ...(await storage.queryNodes({ type: "culture" })),
        ];
        if (charNodes.length > 0) {
          const nowChar = Date.now();
          // Trust gate: value nodes surface once observed; culture (group-patterned) needs
          // corroboration (>=3 observations) before it influences behavior, to avoid
          // acting on a one-off remark as if it were a stable trait.
          const eligible = charNodes.filter((n) => {
            const cd = (n.metadata as any)?.characterData ?? {};
            if (cd.reviewStatus === "pending") return false;
            if (cd.source === "curated") return true;
            const { observationCount } = characterMeta(n);
            return n.type === "culture" ? observationCount >= 3 : observationCount >= 1;
          });
          // Per-layer caps: deeper layers get more slots (they define who the agent is);
          // surface prefs are capped tight so they don't crowd out worldview.
          const LAYER_CAP: Record<string, number> = {
            worldview: 5,
            cultural_norm: 4,
            interpersonal_style: 3,
            work_habit: 3,
            surface_pref: 2,
          };
          const perLayer: Record<string, number> = {};
          const ranked = eligible
            .slice()
            .sort((a, b) => injectionScore(b, nowChar) - injectionScore(a, nowChar))
            .filter((n) => {
              const { layer } = characterMeta(n);
              const used = perLayer[layer] ?? 0;
              if (used >= (LAYER_CAP[layer] ?? 2)) return false;
              perLayer[layer] = used + 1;
              return true;
            })
            .slice(0, 14);
          if (ranked.length > 0) {
            blocks.push("");
            blocks.push("<user-character>");
            blocks.push("Values, attitudes, and behavioral patterns the user has revealed over time. Act consistently with these; they define who this agent is working for and how. Deeper layers (worldview, cultural_norm) outrank surface preferences when they conflict.");
            for (const n of ranked) {
              const { layer } = characterMeta(n);
              const tag = n.type === "culture" ? "pattern" : "value";
              blocks.push(`  <${tag} id="${n.id.slice(0, 8)}" layer="${layer}">${n.content}</${tag}>`);
            }
            blocks.push("</user-character>");
          }
        }

        const experiences = await storage.queryNodes({ type: "experience" as any });
        if (experiences.length > 0) {
          blocks.push("");
          blocks.push("<learned-experiences>");
          blocks.push("These are solutions learned from consulting a more powerful server LLM. Use them when facing similar problems:");
          for (const exp of experiences.slice(-10)) {
            blocks.push(`  <experience id="${exp.id.slice(0, 8)}" time="${new Date(exp.createdAt).toISOString().slice(0, 10)}">${exp.content.slice(0, 500)}</experience>`);
          }
          blocks.push("</learned-experiences>");
        }

        if (blocks.length > 0) {
          const blockText = blocks.join("\n");
          const blockHash = createHash("md5").update(blockText).digest("hex");
          if (blockHash !== lastSystemHash) {
            lastSystemHash = blockHash;
          }
          output.system.unshift(blockText);
        }

        if (localLlmMode === "student") {
          output.system.push(`<local-agent-mode>
You are a LOCAL AI agent in STUDENT mode. You have access to a powerful server LLM via the neural_ask_server tool.

CONFIDENCE ASSESSMENT:
Before answering any non-trivial question, internally assess your confidence (0.0-1.0).
- If confidence < ${confidenceThreshold}: Call neural_ask_server immediately with the problem.
- If you're unsure about tool usage, complex reasoning, or unfamiliar topics: Call neural_ask_server.
- If the user has corrected you ${autoEscalateAfter}+ times recently: Call neural_ask_server for subsequent questions.

When calling neural_ask_server, learn from the response and incorporate the reasoning into your answer.
Always try to answer yourself first for simple/familiar problems where you have relevant <learned-experiences>.
</local-agent-mode>`);
        } else if (localLlmMode === "primary") {
          output.system.push(`<local-agent-mode>
You are a LOCAL AI agent in PRIMARY mode. You are fully autonomous.
Only call neural_ask_server when the user explicitly says "问大模型", "问一下大模型", "ask the server model", or similar.
For all other requests, answer independently using your own knowledge and any <learned-experiences> above.
</local-agent-mode>`);
        } else if (process.env.NEURAL_REPLAY_ORIG_SESSION_ID || (localLlmMode === "observer" && cotStrategy === "thinking-tag")) {
          output.system.push(`<cot-capture>
Before every tool call and before your final response, write step-by-step reasoning inside <thinking>...</thinking> tags. This is REQUIRED for training data harvest.

Structure every non-trivial reply as:
<thinking>
Step-by-step reasoning: what the user is asking, what you notice, hypotheses, why you rule some out, how you narrow down to the next action or answer.
</thinking>
<your tool call or final answer>

Skip the thinking block ONLY for pure greetings or one-word replies. For any real task, ALWAYS include reasoning first.
</cot-capture>`);
        }
      } catch {}
    },

    "command.execute.before": async (input: any, output: any) => {
      try {
        const command = input?.command;
        if (command === "ctx-status" || command === "neural-status") {
          const usage = getContextUsage(sessionId);
          const compartments = compartmentStore.getForSession(sessionId);
          const stats = await engine.getStats();
          output.response = [
            `## Neural Context Status`,
            `Context: ${usage.percentage.toFixed(1)}% (${usage.inputTokens} tokens)`,
            `Nodes: ${stats.nodeCount} | Edges: ${stats.edgeCount}`,
            `Compartments: ${compartments.length}`,
            `Historian failures: ${historianFailureCount}`,
            `Reasoning watermark: ${reasoningWatermark}`,
            `Model: ${lastModelKey || "unknown"}`,
          ].join("\n");
          output.handled = true;
        } else if (command === "ctx-recomp" || command === "neural-recomp") {
          if (historian) {
            const comps = compartmentStore.getForSession(sessionId);
            const lastEndOrd = comps.length > 0 ? comps[comps.length - 1].endOrd : 0;
            const windowMsgs = getSessionMessagePartsForOrds(sessionId, lastEndOrd + 1, lastEndOrd + 12);
            if (windowMsgs.length >= 6) {
              const result = await (historian as any).compress(sessionId, windowMsgs);
              if (result) {
                compartmentStore.save(result);
                output.response = `Recompacted: created compartment covering ordinals ${result.startOrd}-${result.endOrd}`;
              } else {
                output.response = "Recompaction failed — historian returned null.";
              }
            } else {
              output.response = "Not enough uncovered messages to recompact (need >= 6).";
            }
          } else {
            output.response = "Historian not available (no LLM configured).";
          }
          output.handled = true;
        }
      } catch {}
    },

    event: async (input: any) => {
      try {
        const eventType = input?.event?.type ?? "unknown";
        if (eventType !== "session.status") return;
        const props = input.event.properties;
        if (props?.status?.type !== "idle") return;
        const sid = props?.sessionID;
        if (!sid) return;
        if (!sid) return;

        const transcriptDir = join(homedir(), ".local", "share", "ai-agent-local-memory", "transcripts");
        const { mkdirSync } = await import("node:fs");
        mkdirSync(transcriptDir, { recursive: true });
        const transcriptPath = join(transcriptDir, `${sid}.md`);

        const existingLines = existsSync(transcriptPath) ? readFileSync(transcriptPath, "utf-8").split("\n").length : 0;

        const msgsResult = await client.session.messages({ path: { id: sid }, query: {} });
        if (!msgsResult.data) return;

        const allMessages: string[] = [];
        for (const msg of msgsResult.data) {
          const role = msg.info.role;
          const textParts = (msg.parts ?? []).filter((p: any) => p.type === "text");
          const content = textParts.map((p: any) => (p as { text?: string }).text ?? "").join("\n").trim();
          if (!content) continue;
          allMessages.push(`[${role}] ${content}\n\n---\n`);
        }

        const fullContent = allMessages.join("\n");
        const newLineCount = fullContent.split("\n").length;

        if (newLineCount > existingLines) {
          writeFileSync(transcriptPath, fullContent);
        }

        // Session export: opencode.db → JSONL for cross-device replay.
        // Read-only from opencode.db (WAL-safe with the writing main process),
        // append-only JSONL, git push piggy-backs on the existing sync timer.
        try {
          const sessionExportDir = join(syncDir, "opencode-sessions");
          const { mkdirSync: mkExpDir } = await import("node:fs");
          mkExpDir(sessionExportDir, { recursive: true });
          const jsonlPath = join(sessionExportDir, `${sid}.jsonl`);
          const metaPath = join(sessionExportDir, `${sid}.session.json`);
          const statePath = join(sessionExportDir, ".exporter-state.json");

          let stateAll: Record<string, string> = {};
          try {
            if (existsSync(statePath)) stateAll = JSON.parse(readFileSync(statePath, "utf-8"));
          } catch {}
          const lastMsgId = stateAll[sid] ?? "";

          const openCodeDbPath = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "opencode.db");
          if (existsSync(openCodeDbPath)) {
            let Db: any = null;
            try { Db = require("bun:sqlite").Database; } catch {
              try { Db = require("better-sqlite3"); } catch {}
            }
            if (Db) {
              const db = new Db(openCodeDbPath, { readonly: true });
              try {
                if (!existsSync(metaPath)) {
                  const sessRow = db.prepare("SELECT * FROM session WHERE id = ?").get(sid);
                  if (sessRow) writeFileSync(metaPath, JSON.stringify(sessRow, null, 2));
                }

                const newMsgs = lastMsgId
                  ? db.prepare("SELECT * FROM message WHERE session_id = ? AND id > ? ORDER BY time_created, id").all(sid, lastMsgId)
                  : db.prepare("SELECT * FROM message WHERE session_id = ? ORDER BY time_created, id LIMIT 500").all(sid);

                if (newMsgs.length > 0) {
                  const lines: string[] = [];
                  const partStmt = db.prepare("SELECT * FROM part WHERE message_id = ? ORDER BY time_created, id");
                  for (const m of newMsgs) {
                    const parts = partStmt.all(m.id);
                    lines.push(JSON.stringify({ msg: m, parts }));
                  }
                  appendFileSync(jsonlPath, lines.join("\n") + "\n");
                  stateAll[sid] = newMsgs[newMsgs.length - 1].id;
                  writeFileSync(statePath, JSON.stringify(stateAll, null, 2));
                }
              } finally {
                db.close();
              }
            }
          }
        } catch {}

        try {
          const cfg = pluginConfig.idleReadingPrompt;
          if (cfg?.enabled !== false) {
            const minInterval = cfg?.minIntervalMs ?? 60 * 60 * 1000;
            const maxPerDay = cfg?.maxPerDay ?? 3;
            const stateFile = join(dataBase, "ai-agent-local-memory", ".idle-reading-state.json");
            let state: Record<string, { last: number; day: string; count: number; snoozeUntil?: number; disabled?: boolean }> = {};
            try { if (existsSync(stateFile)) state = JSON.parse(readFileSync(stateFile, "utf-8")); } catch {}

            const now = Date.now();
            const today = new Date().toISOString().slice(0, 10);
            const s = state[sid] ?? { last: 0, day: today, count: 0 };
            if (s.day !== today) { s.day = today; s.count = 0; }

            let lastUserText = "";
            for (let i = (msgsResult.data ?? []).length - 1; i >= 0; i--) {
              const m = msgsResult.data![i];
              if (m.info.role !== "user") continue;
              lastUserText = ((m.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => (p as { text?: string }).text ?? "").join(" ")).trim();
              break;
            }
            if (/永久关闭读书|以后别再问|不要再问我读书|permanently stop asking/i.test(lastUserText)) {
              s.disabled = true;
            } else if (/今天别再问|24小时内不要问|暂停读书|snooze reading/i.test(lastUserText)) {
              s.snoozeUntil = now + 24 * 60 * 60 * 1000;
            }

            const snoozed = s.snoozeUntil !== undefined && now < s.snoozeUntil;
            const readInFlight = (globalThis as any).__neuralReadInFlight === true;
            let unfinished: { material: string; origin: string } | null = null;
            if (!readInFlight) {
              try {
                const rs = JSON.parse(readFileSync(readingStatePath(), "utf-8"));
                if (rs?.lastOutcome === "interrupted" && typeof rs.material === "string" && rs.material.length >= 20) {
                  unfinished = { material: rs.material, origin: typeof rs.origin === "string" ? rs.origin : "inline-text" };
                }
              } catch {}
            }

            const graceMs = 30 * 1000;
            const scheduledMsgCount = (msgsResult.data ?? []).length;

            if (!readInFlight && unfinished && !s.disabled && !snoozed) {
              const book = unfinished;
              setTimeout(async () => {
                try {
                  const check = await client.session.messages({ path: { id: sid } });
                  if ((check.data ?? []).length !== scheduledMsgCount) return;
                } catch { return; }
                if ((globalThis as any).__neuralReadInFlight === true) return;
                runNeuralReadServer(book.material, book.origin);
              }, graceMs);
              state[sid] = s;
              mkdirSync(join(dataBase, "ai-agent-local-memory"), { recursive: true });
              try { writeFileSync(stateFile, JSON.stringify(state)); } catch {}
              return;
            }

            const throttled = readInFlight || unfinished !== null || s.disabled || snoozed || now - s.last < minInterval || s.count >= maxPerDay;
            if (!throttled) {
              const askText =
                "我想多学点东西来更好地帮你。你有没有想让我读的材料——文章链接、一段文字、你的工作准则或经验之谈？发给我，我用 neural_read 把它内化成我的价值观和做事方式。\n（不想被打扰？回复「今天别再问」静默 24 小时，或回复「永久关闭读书」彻底关掉。）";

              // Only fire after a quiet grace period, and re-confirm the session is
              // still idle at fire time. If opencode resumed work (new messages
              // arrived, i.e. thinking / tool calls / replying) since we scheduled
              // this timer, skip — never interrupt active work.
              const graceMs = 30 * 1000;
              const scheduledMsgCount = (msgsResult.data ?? []).length;
              setTimeout(async () => {
                try {
                  // Re-check: has the session produced new messages since scheduling?
                  const check = await client.session.messages({ path: { id: sid } });
                  const currentCount = (check.data ?? []).length;
                  if (currentCount !== scheduledMsgCount) return; // session became busy again
                } catch { return; }

                if (Math.random() < 0.5) {
                  try { await (client as any).tui?.showToast?.({ body: { message: askText, variant: "info" } }); } catch {}
                } else {
                  try {
                    await client.session.promptAsync({
                      path: { id: sid },
                      body: { parts: [{ type: "text", text: `[system] ${askText}` }] },
                    });
                  } catch {}
                }
              }, graceMs);

              s.last = now;
              s.count += 1;
            }
            state[sid] = s;
            mkdirSync(join(dataBase, "ai-agent-local-memory"), { recursive: true });
            try { writeFileSync(stateFile, JSON.stringify(state)); } catch {}
          }
        } catch {}

        if (localLlmMode === "observer" && localLlmProvider) {
          mkdirSync(localTrainingDir, { recursive: true });
          const msgs = msgsResult.data;
          const recentPairs: Array<{ instruction: string; input: string; output: string; localOutput?: string; divergence?: number }> = [];

          for (let i = msgs.length - 1; i >= 1; i--) {
            if (msgs[i].info.role === "assistant" && msgs[i - 1].info.role === "user") {
              const userParts = (msgs[i - 1].parts ?? []).filter((p: any) => p.type === "text");
              const userText = userParts.map((p: any) => (p as { text?: string }).text ?? "").join("\n").trim();
              const assistParts = (msgs[i].parts ?? []).filter((p: any) => p.type === "text");
              const assistText = assistParts.map((p: any) => (p as { text?: string }).text ?? "").join("\n").trim();

              if (userText.length < 5 || assistText.length < 20) break;
              if (userText.length > 8000 || assistText.length > 16000) break;

              let localOutput: string | undefined;
              let divergence: number | undefined;
              try {
                const localAnswer = await Promise.race([
                  localLlmProvider.complete(
                    `You are a helpful AI assistant. Answer the user's question thoroughly.\n\nUser: ${userText.slice(0, 2000)}\n\nAssistant:`,
                    { maxTokens: 2000 }
                  ),
                  new Promise<string>((_, rej) => setTimeout(() => rej(new Error("local llm timeout")), 60000)),
                ]);
                if (localAnswer && localAnswer.length > 10) {
                  localOutput = localAnswer.slice(0, 8000);
                  // Jaccard word-overlap: 1 - |A ∩ B| / |A ∪ B|
                  const aWords = new Set(assistText.toLowerCase().match(/\b\w+\b/g) ?? []);
                  const bWords = new Set(localOutput.toLowerCase().match(/\b\w+\b/g) ?? []);
                  const inter = [...aWords].filter(w => bWords.has(w)).length;
                  const union = new Set([...aWords, ...bWords]).size;
                  divergence = union === 0 ? 0 : 1 - inter / union;
                }
              } catch {}

              let outputForTraining = assistText.slice(0, 8000);

              if (cotStrategy === "post-rewrite") {
                try {
                  const child = await client.session.create({});
                  if (child.data) {
                    const rewritePrompt = `Rewrite the assistant reply below in structured [Reasoning] + [Answer] format so a local model can learn the reasoning process.

USER QUESTION:
${userText.slice(0, 2000)}

ORIGINAL ASSISTANT REPLY:
${assistText.slice(0, 6000)}

Return ONLY the rewritten version, no preamble. Format:
[Reasoning]
<step-by-step thinking that led to this answer>

[Answer]
<the same final answer, reformatted>`;

                    await client.session.promptAsync({
                      path: { id: child.data.id },
                      body: { parts: [{ type: "text", text: rewritePrompt }] },
                    });

                    await new Promise(r => setTimeout(r, 20000));

                    const childMsgs = await client.session.messages({ path: { id: child.data.id }, query: { limit: 3 } });
                    if (childMsgs.data) {
                      for (const m of childMsgs.data) {
                        if (m.info.role !== "assistant") continue;
                        const t = (m.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => (p as { text?: string }).text ?? "").join("\n").trim();
                        if (t.includes("[Reasoning]") && t.includes("[Answer]")) {
                          outputForTraining = t.slice(0, 12000);
                          break;
                        }
                      }
                    }
                  }
                } catch {}
              }

              recentPairs.push({
                instruction: "You are a helpful AI assistant. Answer the user's question thoroughly.",
                input: userText.slice(0, 4000),
                output: outputForTraining,
                ...(localOutput ? { localOutput, divergence } : {}),
              });
              break;
            }
          }

          // Also harvest training pairs from every sub-session (Oracle, Explore, Librarian, Metis, Momus, Sisyphus-Junior, etc.)
          // spawned by this session. Each sub-session is a full LLM conversation whose reasoning we'd otherwise miss.
          try {
            const openCodeDbPath = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "opencode.db");
            if (existsSync(openCodeDbPath)) {
              let Db: any = null;
              try { Db = require("bun:sqlite").Database; } catch {
                try { Db = require("better-sqlite3"); } catch {}
              }
              if (Db) {
                const db = new Db(openCodeDbPath, { readonly: true });
                try {
                  const collected: string[] = [];
                  const queue: string[] = [sid];
                  while (queue.length > 0 && collected.length < 50) {
                    const parent = queue.shift()!;
                    const children = db.prepare("SELECT id FROM session WHERE parent_id = ?").all(parent) as Array<{ id: string }>;
                    for (const c of children) {
                      collected.push(c.id);
                      queue.push(c.id);
                    }
                  }
                  for (const subSid of collected) {
                    try {
                      const subMsgs = await client.session.messages({ path: { id: subSid }, query: {} });
                      if (!subMsgs.data) continue;
                      const arr = subMsgs.data;
                      for (let i = arr.length - 1; i >= 1; i--) {
                        if (arr[i].info.role === "assistant" && arr[i - 1].info.role === "user") {
                          const uParts = (arr[i - 1].parts ?? []).filter((p: any) => p.type === "text");
                          const uText = uParts.map((p: any) => (p as { text?: string }).text ?? "").join("\n").trim();
                          const aParts = (arr[i].parts ?? []).filter((p: any) => p.type === "text");
                          const aText = aParts.map((p: any) => (p as { text?: string }).text ?? "").join("\n").trim();
                          if (uText.length < 20 || aText.length < 40) break;
                          if (uText.length > 12000 || aText.length > 20000) break;
                          recentPairs.push({
                            instruction: "You are an expert sub-agent (Oracle / Explore / Librarian / Metis / Momus / Sisyphus-Junior style). Reason step by step from the request and produce a concrete, evidence-cited response.",
                            input: uText.slice(0, 6000),
                            output: aText.slice(0, 12000),
                          });
                          break;
                        }
                      }
                    } catch {}
                  }
                } finally {
                  db.close();
                }
              }
            }
          } catch {}

          if (recentPairs.length > 0) {
            const pairsFile = join(localTrainingDir, "pairs.jsonl");
            const { appendFileSync } = await import("node:fs");
            for (const pair of recentPairs) {
              appendFileSync(pairsFile, JSON.stringify(pair) + "\n");
            }

            const lineCount = existsSync(pairsFile) ? readFileSync(pairsFile, "utf-8").split("\n").filter(l => l.trim()).length : 0;
            if (lineCount >= trainingTriggerCount) {
              const stateFile = join(homedir(), ".local", "share", "ai-agent-local-memory", ".auto-train-state");
              const lastTrained = existsSync(stateFile) ? parseInt(readFileSync(stateFile, "utf-8")) || 0 : 0;
              if (lineCount - lastTrained >= trainingTriggerCount) {
                const pipelineScript = join(homedir(), "Desktop", "ju", "projects", "AIAgentLocalMemory", "packages", "lora-pipeline", "auto-train.sh");
                if (existsSync(pipelineScript)) {
                  const flagFile = join(homedir(), ".local", "share", "ai-agent-local-memory", ".training-in-progress");
                  writeFileSync(flagFile, String(Date.now()));
                  try {
                    const { exec: execAsync } = await import("node:child_process");
                    execAsync(`nice -n 19 bash "${pipelineScript}"`, { env: { ...process.env, TRAINING_DATA: pairsFile } }, () => {
                      try { const { unlinkSync } = require("node:fs"); unlinkSync(flagFile); } catch {}
                      writeFileSync(stateFile, String(lineCount));
                    });
                  } catch {}
                }
              }
            }
          }
        }
      } catch {}
    },
  };
};

export default {
  id: "ai-agent-local-memory",
  server: AIAgentLocalMemoryPlugin,
};
