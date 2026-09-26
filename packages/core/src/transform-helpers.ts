// Host-agnostic helpers for context compression. Extracted verbatim from the OpenCode
// adapter so any host (OpenCode, nvp-server, ...) can supply the runCompartmentTransform
// deps contract without duplicating logic. Bodies are byte-identical to the original
// adapter definitions — do not "improve" them; several carry incident history.
import { Tokenizer } from "ai-tokenizer";
import * as claudeEncoding from "ai-tokenizer/encoding/claude";

const claudeTokenizer = new Tokenizer(claudeEncoding as any);

// ai-tokenizer's `claude` encoding is the OLD Claude tokenizer. Opus 4.7+, Sonnet 5,
// Fable/Mythos 5 switched to a NEW tokenizer that produces ~30% more tokens for the same
// text (per Anthropic's pricing docs). Upstream ai-tokenizer (1.0.6, latest) ships no
// separate encoding for it, so we compensate: multiply the old-encoding count by ~1.3 when
// the active model uses the new tokenizer. Without this the tail budget under-counts ~30%
// on 4.8 and overflows the context ("Input is too long"). Updated via setActiveTokenizerModel().
let newTokenizerMultiplier = 1.0;
const NEW_TOKENIZER_PATTERN = /(opus-4[.-](?:[7-9]|1[0-9])|claude-4[.-](?:[7-9]|1[0-9])-opus|sonnet-5|haiku-5|claude-fable|claude-mythos|fable-5|mythos-5)/i;
export function setActiveTokenizerModel(modelKey: string | undefined | null): void {
  newTokenizerMultiplier = modelKey && NEW_TOKENIZER_PATTERN.test(modelKey) ? 1.3 : 1.0;
}

// Denominator for usage %. Config `contextWindowTokens` overrides at call sites.
// modelKey is "providerID/modelID" or bare modelID; hai proxy may use double-dash
// (anthropic--claude-4.8-opus), so rules match on substrings not exact ids.
const CONTEXT_WINDOW_RULES: Array<{ re: RegExp; window: number }> = [
  // GPT-5.x / GPT-6 family: 400K
  { re: /gpt-(5[.-]|6[.-]|5$|6$|6-)/i, window: 400000 },
  // Kimi K3/K2 (Moonshot): 256K
  { re: /kimi-k[23]/i, window: 256000 },
  // DeepSeek V4/V3: 128K
  { re: /deepseek-v[34]/i, window: 128000 },
  // Claude Opus / Sonnet / Haiku / Fable / Mythos (4.x, 5.x): 200K
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
export function countClaudeTokens(text: string): number {
  if (!text) return 0;
  try { return Math.ceil(claudeTokenizer.encode(text, [], "all").length * newTokenizerMultiplier); }
  catch { return Math.ceil((text.length / 4) * newTokenizerMultiplier); }
}

// Tool-value tiers (mirrors magic-context emergency-drop). Lower tier = higher value =
// kept longer / dropped last. T1 = read-only probes (low context value once acted on),
// T2 = mutations/searches (medium), T3 = everything else / unknown (dropped first).
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

// Retrievable stub: when a tool output is truncated/dropped, leave a breadcrumb telling
// the LLM exactly where to fetch the verbatim original (the transcript MD mirrors every
// tool block byte-for-byte). Includes tool name + a short arg summary so the model can
// grep the MD, and — as a last resort if the MD is gone — knows what to re-run.
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
  // sid may be a real ses_xxx (transcript filename) — point the model there.
  return (
    `\n\n…[tool output compacted — kept first ${keptChars} of ${origChars} chars]\n` +
    `[retrieve verbatim: grep the tool block name="${name}"${argLine} in ` +
    `~/.local/share/ai-agent-local-memory/transcripts/${sid}.md; if absent, re-run ${name} with the same args]`
  );
}

// time.created is already ms; blindly *1000 double-scaled it and rendered a 30min gap as "+319d". Threshold 1e12 = year 2001, separates s from ms.
export function toEpochMs(created: number | undefined | null): number {
  if (!created || created <= 0) return 0;
  return created >= 1e12 ? created : created * 1000;
}

// Structural hash of a message's parts — cheap change-detector for the token memo cache.
export function msgContentHash(msg: any): string {
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
}

// Memoized per-message token sum used by the budget scan. The cache is host-owned (each
// host passes its own Map + max), so this is a factory returning the 3-arg memo function —
// call sites (adapter + core transform) stay unchanged.
export function makeMsgTokensMemo(
  msgTokenCache: Map<string, { hash: string; tokens: number }>,
  TOKEN_CACHE_MAX: number,
) {
  return (
    msg: any,
    billable: (part: any) => string,
    countFn: (text: string) => number,
  ): number => {
    const id: string | undefined = msg?.info?.id ?? msg?.id;
    const hash = msgContentHash(msg);
    if (id) {
      const hit = msgTokenCache.get(id);
      if (hit && hit.hash === hash) {
        // LRU touch: re-insert to move to the end of iteration order.
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
        // Evict oldest (Map preserves insertion order; first key is least-recently-set/touched).
        const oldest = msgTokenCache.keys().next().value;
        if (oldest !== undefined) msgTokenCache.delete(oldest);
      }
    }
    return tokens;
  };
}
