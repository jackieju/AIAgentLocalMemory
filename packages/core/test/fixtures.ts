// fixtures.ts — regression-test scaffolding for runCompartmentTransform.
//
// The pure collaborator helpers below are COPIED VERBATIM from the adapter source so the
// golden snapshots reflect the REAL production algorithm (token counts, tool stubs, tiers,
// context windows, epoch normalization, memoized per-message token sums). Each block cites
// the exact source line range it was lifted from. Source:
//   packages/adapter-opencode/src/index.ts   (read 2026-09-26)
//
// Behavior-freezing rule: do NOT "improve" these copies. If the adapter changes, re-copy.

// ai-tokenizer is installed only under packages/adapter-opencode/node_modules (not hoisted
// to root and NOT a dependency of packages/core). We must not add it to core's package.json
// (test-only change), so we reach the real package's dist files directly by relative path.
// This keeps snapshots faithful to the production BPE tokenizer instead of an approximation.
import { Tokenizer } from "../../adapter-opencode/node_modules/ai-tokenizer/dist/index.js";
import * as claudeEncoding from "../../adapter-opencode/node_modules/ai-tokenizer/dist/encoding/claude.js";

// ── adapter L18: real Claude BPE tokenizer instance ────────────────────────────
const claudeTokenizer = new Tokenizer(claudeEncoding as any);

// ── adapter L26-30: active-tokenizer multiplier (module state shared with countClaudeTokens)
let newTokenizerMultiplier = 1.0;
const NEW_TOKENIZER_PATTERN = /(opus-4[.-](?:[7-9]|1[0-9])|claude-4[.-](?:[7-9]|1[0-9])-opus|sonnet-5|haiku-5|claude-fable|claude-mythos|fable-5|mythos-5)/i;
export function setActiveTokenizerModel(modelKey: string | undefined | null): void {
  newTokenizerMultiplier = modelKey && NEW_TOKENIZER_PATTERN.test(modelKey) ? 1.3 : 1.0;
}

// ── adapter L35-52: context-window resolution ──────────────────────────────────
const CONTEXT_WINDOW_RULES: Array<{ re: RegExp; window: number }> = [
  { re: /gpt-(5[.-]|6[.-]|5$|6$|6-)/i, window: 400000 },
  { re: /kimi-k[23]/i, window: 256000 },
  { re: /deepseek-v[34]/i, window: 128000 },
  { re: /(opus|sonnet|haiku|fable|mythos)/i, window: 200000 },
];
export function resolveContextWindow(modelKey: string | undefined | null): number {
  if (modelKey) {
    for (const rule of CONTEXT_WINDOW_RULES) {
      if (rule.re.test(modelKey)) return rule.window;
    }
  }
  return 128000;
}

// ── adapter L53-57: real BPE token count (honors newTokenizerMultiplier) ────────
export function countClaudeTokens(text: string): number {
  if (!text) return 0;
  try { return Math.ceil(claudeTokenizer.encode(text, [], "all").length * newTokenizerMultiplier); }
  catch { return Math.ceil((text.length / 4) * newTokenizerMultiplier); }
}

// ── adapter L62-71: tool-value tiers ───────────────────────────────────────────
const TOOL_T1 = new Set(["read", "todowrite", "task", "aft_outline", "aft_zoom", "list", "glob"]);
const TOOL_T2 = new Set(["edit", "write", "apply_patch", "grep", "bash", "aft_search", "webfetch"]);
export function resolveToolTier(toolName: string | undefined | null): 1 | 2 | 3 {
  if (!toolName) return 3;
  let name = toolName.toLowerCase();
  if (name.startsWith("mcp_")) name = name.slice(4);
  if (TOOL_T1.has(name)) return 1;
  if (TOOL_T2.has(name)) return 2;
  return 3;
}

// ── adapter L77-101: retrievable tool-output stub ───────────────────────────────
function toolArgSummary(input: any): string {
  if (input === undefined || input === null) return "";
  try {
    if (typeof input === "string") return input.slice(0, 160);
    const s = JSON.stringify(input);
    return s.length > 160 ? s.slice(0, 160) + "…" : s;
  } catch { return ""; }
}
export function buildToolStub(
  toolName: string | undefined | null,
  input: any,
  sid: string,
  keptChars: number,
  origChars: number,
): string {
  const name = toolName ?? "unknown";
  const args = toolArgSummary(input);
  const argLine = args ? ` args=${args}` : "";
  return (
    `\n\n…[tool output compacted — kept first ${keptChars} of ${origChars} chars]\n` +
    `[retrieve verbatim: grep the tool block name="${name}"${argLine} in ` +
    `~/.local/share/ai-agent-local-memory/transcripts/${sid}.md; if absent, re-run ${name} with the same args]`
  );
}

// ── adapter L104-107: seconds/ms epoch normalization ────────────────────────────
export function toEpochMs(created: number | undefined | null): number {
  if (!created || created <= 0) return 0;
  return created >= 1e12 ? created : created * 1000;
}

// ── adapter L1374-1425: memoized per-message token sum ──────────────────────────
// TOKEN_CACHE_MAX + msgContentHash are stateless → module scope. msgTokenCache is
// per-instance (the adapter creates one per plugin instance); createTokenMemo() mirrors
// that by returning a fresh cache + a memo fn closing over it, so each test's deps gets an
// isolated cache. The transform ALSO receives this SAME cache as deps.msgTokenCache
// (it calls msgTokenCache.delete(mid) after microcompact) — they must be identical, exactly
// as they are in the adapter closure.
const TOKEN_CACHE_MAX = 10000;
const msgContentHash = (msg: any): string => {
  const parts = msg?.parts ?? [];
  let h = parts.length + "|";
  for (const p of parts) {
    const t = (p?.type ?? "?").charAt(0);
    const st = p?.state;
    const len =
      (st && typeof st.output === "string" ? st.output.length : 0) +
      (typeof p?.content === "string" ? p.content.length : 0) +
      (typeof p?.text === "string" ? p.text.length : 0) +
      (typeof p?.input === "string" ? p.input.length : 0);
    h += t + len + ",";
  }
  return h;
};
export function createTokenMemo(): {
  msgTokenCache: Map<string, { hash: string; tokens: number }>;
  msgTokensMemo: (msg: any, billable: (p: any) => string, countFn: (t: string) => number) => number;
} {
  const msgTokenCache = new Map<string, { hash: string; tokens: number }>();
  const msgTokensMemo = (
    msg: any,
    billable: (part: any) => string,
    countFn: (text: string) => number,
  ): number => {
    const id: string | undefined = msg?.info?.id ?? msg?.id;
    const hash = msgContentHash(msg);
    if (id) {
      const hit = msgTokenCache.get(id);
      if (hit && hit.hash === hash) {
        msgTokenCache.delete(id);
        msgTokenCache.set(id, hit);
        return hit.tokens;
      }
    }
    let tokens = 10;
    for (const part of msg?.parts ?? []) {
      const text = billable(part);
      if (text) tokens += countFn(text);
    }
    if (id) {
      msgTokenCache.set(id, { hash, tokens });
      if (msgTokenCache.size > TOKEN_CACHE_MAX) {
        const oldest = msgTokenCache.keys().next().value;
        if (oldest !== undefined) msgTokenCache.delete(oldest);
      }
    }
    return tokens;
  };
  return { msgTokenCache, msgTokensMemo };
}

// ── test-only helpers ───────────────────────────────────────────────────────────

// Fixed epoch base so time-derived fields (gap labels) are deterministic across runs.
// NEVER use Date.now() as a default here — that would leak wall-clock time into snapshots.
export const BASE_TIME = 1_700_000_000_000;

export type Part = Record<string, any>;
export interface Msg {
  info: { id: string; role: string; sessionID: string; time: { created: number }; [k: string]: any };
  parts: Part[];
}

/** Build one host (opencode-shaped) message. `textOrParts` is either a text string
 *  (wrapped as a single text part) or an explicit parts array. */
export function makeMsg(
  role: "user" | "assistant" | "tool",
  id: string,
  textOrParts: string | Part[],
  sessionID = "test-session",
  createdMs = BASE_TIME,
): Msg {
  const parts = typeof textOrParts === "string"
    ? [{ type: "text", text: textOrParts }]
    : textOrParts;
  return { info: { id, role, sessionID, time: { created: createdMs } }, parts };
}

export interface DiagEvent { file: string; text: string; append?: boolean }

export interface BuiltDeps {
  deps: any;
  diagCalls: DiagEvent[];
  pendingIdleWork: Map<string, any>;
  state: any;
  msgTokenCache: Map<string, { hash: string; tokens: number }>;
}

/** Assemble a minimal-but-faithful deps object. `contextUsagePct` drives the scheduler;
 *  `compartments` seeds compartmentStore.getForSession. */
export function buildDeps(opts: {
  contextUsagePct?: number;
  compartments?: any[];
  sessionId?: string;
} = {}): BuiltDeps {
  const { contextUsagePct = 0, compartments = [], sessionId = "test-session" } = opts;
  const diagCalls: DiagEvent[] = [];
  const pendingIdleWork = new Map<string, any>();
  const { msgTokenCache, msgTokensMemo } = createTokenMemo();

  const state = {
    lastModelKey: "",
    lastContextPercentage: 0,
    reasoningWatermark: 0,
    lastTailStartIdx: 0,
    historianFailureCount: 0,
    dissatisfactionCount: 0,
    currentOpenCodeSessionId: "",
    historianTurnCount: 0,
    lastCompressTime: 0,
  };

  // openCodeDb: prepare() → statement whose all/get/run are empty-safe (message-list /
  // ordinal / finish-reason lookups all no-op → forces the array-based fallbacks).
  const openCodeDb = {
    prepare: (_sql: string) => ({
      all: (..._args: any[]) => [] as any[],
      get: (..._args: any[]) => undefined,
      run: (..._args: any[]) => undefined,
    }),
  };

  // rawStorage.getDb().prepare().run(): no-op KV write (reasoning_watermark persist).
  const rawStorage = {
    getDb: () => ({ prepare: (_sql: string) => ({ run: (..._args: any[]) => {} }) }),
  };

  const deps = {
    getContextUsage: (_sid: string) => ({ percentage: contextUsagePct }),
    compartmentStore: { getForSession: (_sid: string) => compartments },
    openCodeDb,
    historian: null, // only referenced as `if (!historian)` in this fn → gates historian firing off
    pendingIdleWork,
    pluginConfig: { systemToolsReservePct: 0.18, protectedTags: 20 },
    rawStorage,
    storage: {}, // destructured only, never called in this fn
    msgTokensMemo,
    msgTokenCache,
    countClaudeTokens,
    buildToolStub,
    resolveToolTier,
    setActiveTokenizerModel,
    resolveContextWindow,
    toEpochMs,
    pinnedTags: new Set<number>(),
    droppedTags: new Set<number>(),
    sessionId,
    dataBase: "/tmp", // destructured only
    client: {},       // destructured only
    localLlmMode: "off",
    autoEscalateAfter: 3,
    directory: "/tmp", // destructured only
    state,
    log: (e: DiagEvent) => { diagCalls.push(e); },
  };

  return { deps, diagCalls, pendingIdleWork, state, msgTokenCache };
}

// ── snapshot summarizers (STRUCTURAL only — never full text bodies, never timestamps) ──

/** Total text-part char length for a message (post-transform, includes §N§ tag prefix). */
export function textLen(m: any): number {
  return (m.parts ?? [])
    .filter((p: any) => p.type === "text")
    .reduce((n: number, p: any) => n + (p.text?.length ?? 0), 0);
}

/** Lengths of every tool state.output on a message (captures truncation). */
export function toolOutLens(m: any): number[] {
  return (m.parts ?? [])
    .filter((p: any) => p?.state && typeof p.state.output === "string")
    .map((p: any) => p.state.output.length);
}

/** Compact structural summary of a message array for golden snapshots. */
export function summarize(messages: any[]): {
  count: number;
  roles: string[];
  ids: (string | null)[];
  textLens: number[];
  partTypes: string[][];
} {
  return {
    count: messages.length,
    roles: messages.map((m) => m.info?.role ?? "?"),
    ids: messages.map((m) => m.info?.id ?? null),
    textLens: messages.map(textLen),
    partTypes: messages.map((m) => (m.parts ?? []).map((p: any) => p.type)),
  };
}

/** Sorted unique diagnostic file sinks (NOT their text — text carries Date.now()). */
export function diagFiles(diagCalls: DiagEvent[]): string[] {
  return [...new Set(diagCalls.map((d) => d.file))].sort();
}
