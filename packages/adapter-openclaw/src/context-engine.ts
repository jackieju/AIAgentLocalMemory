/**
 * OpenClaw ContextEngine adapter.
 *
 * ARCHITECTURE RED LINE (do not violate):
 *   Everything OpenClaw-specific lives in THIS adapter layer. The core package
 *   (@ai-agent-local-memory/core) stays host-agnostic and only ever sees our
 *   neutral "opencode-shaped" messages. Never push the OpenClaw AgentMessage
 *   shape, the ContextEngine interface, or usage/token conventions down into
 *   core. This file is the ONLY place that knows OpenClaw exists.
 *
 * It does two OpenClaw-specific jobs:
 *   1. Message conversion: OpenClaw AgentMessage <-> core's neutral opencode shape.
 *   2. ContextEngine implementation: assemble / compact / ingest / info, wired
 *      to core's host-agnostic runCompartmentTransform + Historian.
 *
 * usagePct estimation uses the "乙" strategy: mirror OpenClaw's own
 * estimateContextTokens algorithm (trust the provider-reported usage on the
 * last assistant message, char-estimate the trailing messages) rather than a
 * plain char count, so the compression trigger matches the host's accounting.
 */

import {
  runCompartmentTransform,
  Historian,
  countClaudeTokens,
  makeMsgTokensMemo,
  setActiveTokenizerModel,
  resolveContextWindow,
  resolveToolTier,
  buildToolStub,
  toEpochMs,
  type TransformDeps,
} from "@ai-agent-local-memory/core";
import { CompartmentStore } from "@ai-agent-local-memory/storage-sqlite";

// OpenClaw message shapes (structural, kept local to the adapter — we do NOT
// import openclaw as a value dependency; it is a runtime peer).
type OpenClawContentBlock = {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  toolCallId?: string;
  content?: unknown;
  isError?: boolean;
};

type OpenClawUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  contextUsage?: { state?: string; totalTokens?: number };
};

type OpenClawMessage = {
  role: string;
  id?: string;
  content?: string | OpenClawContentBlock[];
  usage?: OpenClawUsage;
  stopReason?: string;
  timestamp?: string | number;
  model?: string;
};

// Neutral opencode-shaped message that core understands. core reads:
//   msg.info.{role,id,sessionID,providerID,modelID,time.created,toolName}
//   msg.parts[].{type,text,name,input,content,state.{input,output,status,error}}
// This shape is the contract between adapter and core — it is host-agnostic.
type OcPart = {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  state?: { input?: unknown; output?: unknown; status?: string; error?: string };
};

type OcMessage = {
  info: {
    role: string;
    id: string;
    sessionID: string;
    providerID?: string;
    modelID?: string;
    time?: { created: number };
    toolName?: string;
  };
  parts: OcPart[];
  // carry-through so we can rebuild the original OpenClaw message on the way out
  __ocw?: OpenClawMessage;
};

// Conversion: OpenClaw AgentMessage -> neutral opencode shape (for core).
function toOpencode(msg: OpenClawMessage, sessionId: string, idx: number): OcMessage {
  const id = msg.id ?? `ocw-${idx}`;
  const created =
    typeof msg.timestamp === "number"
      ? msg.timestamp
      : typeof msg.timestamp === "string"
      ? Date.parse(msg.timestamp) || Date.now()
      : Date.now();

  const parts: OcPart[] = [];
  let toolName: string | undefined;

  if (typeof msg.content === "string") {
    parts.push({ type: "text", text: msg.content });
  } else if (Array.isArray(msg.content)) {
    for (const b of msg.content) {
      switch (b.type) {
        case "text":
          parts.push({ type: "text", text: b.text ?? "" });
          break;
        case "thinking":
          parts.push({ type: "reasoning", text: b.thinking ?? b.text ?? "" });
          break;
        case "toolCall":
          toolName = b.name ?? toolName;
          // keep both the call name/input AND mirror into state so core's
          // partBillableText can bill the real command payload.
          parts.push({
            type: "tool",
            name: b.name,
            input: b.input,
            state: { input: b.input },
          });
          break;
        case "toolResult": {
          const out =
            typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
          parts.push({
            type: "tool",
            name: b.name,
            content: b.content,
            state: {
              output: out,
              status: b.isError ? "error" : undefined,
              error: b.isError ? out : undefined,
            },
          });
          break;
        }
        case "image":
          parts.push({ type: "text", text: "[image]" });
          break;
        default:
          if (typeof b.text === "string") parts.push({ type: "text", text: b.text });
          break;
      }
    }
  }

  return {
    info: {
      role: msg.role,
      id,
      sessionID: sessionId,
      modelID: msg.model,
      time: { created },
      toolName,
    },
    parts,
    __ocw: msg,
  };
}

// Conversion back: neutral opencode shape -> OpenClaw AgentMessage.
// core mutates parts in place (truncates text, injects §N§ tags, stubs tool
// output). We fold those edits back onto the original OpenClaw message so the
// host receives valid AgentMessages with the compressed content.
function toOpenClaw(oc: OcMessage): OpenClawMessage {
  const original = oc.__ocw;
  // If the original had string content and core produced a single text part,
  // keep it as a string (minimal, matches typical user messages).
  if (original && typeof original.content === "string") {
    const text = oc.parts
      .filter((p) => p.type === "text" || p.type === "reasoning")
      .map((p) => p.text ?? "")
      .join("");
    return { ...original, content: text };
  }

  const blocks: OpenClawContentBlock[] = [];
  for (const p of oc.parts) {
    switch (p.type) {
      case "text":
        blocks.push({ type: "text", text: p.text ?? "" });
        break;
      case "reasoning":
        blocks.push({ type: "thinking", thinking: p.text ?? "" });
        break;
      case "tool":
        if (p.state?.output !== undefined || p.content !== undefined) {
          blocks.push({
            type: "toolResult",
            name: p.name,
            content: p.state?.output ?? p.content ?? "",
            isError: p.state?.status === "error",
          });
        } else {
          blocks.push({ type: "toolCall", name: p.name, input: p.input });
        }
        break;
      default:
        if (typeof p.text === "string") blocks.push({ type: "text", text: p.text });
        break;
    }
  }

  return {
    role: original?.role ?? oc.info.role,
    id: original?.id ?? oc.info.id,
    content: blocks,
    usage: original?.usage,
    stopReason: original?.stopReason,
    timestamp: original?.timestamp,
    model: original?.model,
  };
}

// usagePct estimation — "乙": mirror OpenClaw's estimateContextTokens.
//   - find the last assistant message with usable provider usage
//   - use its reported total as the base, char-estimate everything after it
//   - no usage anywhere -> char-estimate the whole thing
// We reuse core's countClaudeTokens for the char-estimate side so we stay on
// one tokenizer, but the provider-usage-first logic matches the host.
function billableText(msg: OpenClawMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return "";
  const out: string[] = [];
  for (const b of msg.content) {
    if (b.text) out.push(b.text);
    if (b.thinking) out.push(b.thinking);
    if (b.name) out.push(b.name);
    if (b.input !== undefined) out.push(typeof b.input === "string" ? b.input : JSON.stringify(b.input));
    if (b.content !== undefined) out.push(typeof b.content === "string" ? b.content : JSON.stringify(b.content));
  }
  return out.join("\n");
}

function usageTotal(u: OpenClawUsage | undefined): number | undefined {
  if (!u) return undefined;
  if (u.contextUsage?.state === "available" && typeof u.contextUsage.totalTokens === "number") {
    return u.contextUsage.totalTokens;
  }
  if (typeof u.total === "number") return u.total;
  const sum = (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  return sum > 0 ? sum : undefined;
}

function estimateContextTokens(messages: OpenClawMessage[]): number {
  let lastUsageIdx = -1;
  let lastUsageTokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    if (m.stopReason === "aborted" || m.stopReason === "error") continue;
    const t = usageTotal(m.usage);
    if (t !== undefined) {
      lastUsageIdx = i;
      lastUsageTokens = t;
      break;
    }
  }

  if (lastUsageIdx < 0) {
    let est = 0;
    for (const m of messages) est += countClaudeTokens(billableText(m));
    return est;
  }

  let trailing = 0;
  for (let i = lastUsageIdx + 1; i < messages.length; i++) {
    trailing += countClaudeTokens(billableText(messages[i]));
  }
  return lastUsageTokens + trailing;
}

// Deps for runCompartmentTransform. Per-session state must persist across
// assemble calls so core's self-adaptive watermarks don't reset each turn.
type EngineCtx = {
  storage: any;
  compartmentStore: CompartmentStore;
  historian: Historian | null;
  config: Record<string, unknown>;
  logger?: { info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void };
};

const stateBySession = new Map<string, Record<string, any>>();
const msgTokenCache = new Map<string, { hash: string; tokens: number }>();

function getState(sessionId: string): Record<string, any> {
  let s = stateBySession.get(sessionId);
  if (!s) {
    s = {
      lastModelKey: "",
      lastContextPercentage: 0,
      reasoningWatermark: 0,
      lastTailStartIdx: 0,
      historianFailureCount: 0,
      dissatisfactionCount: 0,
      currentOpenCodeSessionId: sessionId,
      historianTurnCount: 0,
      lastCompressTime: 0,
    };
    stateBySession.set(sessionId, s);
  }
  return s;
}

function buildDeps(ctx: EngineCtx, sessionId: string, usagePct: number): TransformDeps {
  return {
    getContextUsage: () => ({ percentage: usagePct, inputTokens: 0 }),
    hasNativeUsage: usagePct > 0,
    getIsMidTurn: () => false,
    getLastUserMessageId: () => undefined,
    getPreviousOverflow: () => undefined,
    storage: ctx.storage,
    rawStorage: ctx.storage,
    compartmentStore: ctx.compartmentStore,
    historian: ctx.historian,
    pendingIdleWork: new Map(),
    countClaudeTokens,
    msgTokensMemo: makeMsgTokensMemo(msgTokenCache, 10000),
    msgTokenCache,
    setActiveTokenizerModel,
    resolveContextWindow,
    buildToolStub,
    resolveToolTier,
    toEpochMs,
    pinnedTags: new Set<number>(),
    droppedTags: new Set<number>(),
    pluginConfig: ctx.config,
    sessionId,
    localLlmMode: undefined,
    autoEscalateAfter: undefined,
    state: getState(sessionId),
  } as unknown as TransformDeps;
}

// ContextEngine factory. Returned object is handed to api.registerContextEngine.
export function createContextEngine(ctx: EngineCtx) {
  async function runTransform(
    sessionId: string,
    messages: OpenClawMessage[],
    model: string | undefined,
    budget: number | undefined
  ): Promise<{ messages: OpenClawMessage[]; estimatedTokens: number }> {
    const tokens = estimateContextTokens(messages);
    const limit =
      budget ?? (model ? resolveContextWindow(model) : undefined) ?? 128000;
    const usagePct = limit > 0 ? Math.round((tokens / limit) * 100) : 0;

    if (model) {
      try {
        setActiveTokenizerModel(model);
      } catch {
        /* unknown model key -> default tokenizer; non-fatal */
      }
    }

    const oc = messages.map((m, i) => toOpencode(m, sessionId, i));
    const output: { messages: OcMessage[] } = { messages: oc };
    await runCompartmentTransform({ messages: oc }, output, buildDeps(ctx, sessionId, usagePct));

    const rebuilt = output.messages.map((m) => toOpenClaw(m));
    return { messages: rebuilt, estimatedTokens: tokens };
  }

  return {
    info: {
      id: "neural-context",
      name: "Neural Context Engine",
      ownsCompaction: true,
    },

    async assemble(params: {
      sessionId: string;
      messages: OpenClawMessage[];
      tokenBudget?: number;
      model?: string;
      runtimeSettings?: { limits?: { promptTokenBudget?: number | null } };
    }) {
      try {
        const budget =
          params.tokenBudget ??
          params.runtimeSettings?.limits?.promptTokenBudget ??
          undefined;
        const { messages, estimatedTokens } = await runTransform(
          params.sessionId,
          params.messages ?? [],
          params.model,
          budget ?? undefined
        );
        return {
          messages,
          estimatedTokens,
          // our rendered view can hide underlying overflow; let host precheck
          // take the larger of pre/post estimates.
          promptAuthority: "preassembly_may_overflow" as const,
        };
      } catch (err) {
        ctx.logger?.error?.("neural-context: assemble failed, passing through", err);
        // never break the turn — fall back to untouched messages
        return {
          messages: params.messages ?? [],
          estimatedTokens: estimateContextTokens(params.messages ?? []),
        };
      }
    },

    async compact(params: {
      sessionId: string;
      messages?: OpenClawMessage[];
      tokenBudget?: number;
      currentTokenCount?: number;
    }) {
      // Compaction is realized inside assemble (compartment transform). Report
      // the before/after estimate so the host sees the reduction.
      try {
        const before =
          params.currentTokenCount ?? estimateContextTokens(params.messages ?? []);
        if (!params.messages || params.messages.length === 0) {
          return { ok: true, compacted: false, reason: "no messages to compact" };
        }
        const { messages, estimatedTokens } = await runTransform(
          params.sessionId,
          params.messages,
          undefined,
          params.tokenBudget ?? undefined
        );
        return {
          ok: true,
          compacted: estimatedTokens < before,
          result: {
            tokensBefore: before,
            tokensAfter: estimatedTokens,
          },
          messages,
        };
      } catch (err) {
        ctx.logger?.error?.("neural-context: compact failed", err);
        return { ok: false, compacted: false, reason: String(err) };
      }
    },

    async ingest(params: { sessionId: string; messages?: OpenClawMessage[] }) {
      // Memory ingestion is handled by the agent_end capture hook + tools.
      // ContextEngine.ingest is a no-op here to avoid double-writing the graph.
      return { ingested: 0 };
    },
  };
}
