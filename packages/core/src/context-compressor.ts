// context-compressor.ts
//
// Host-agnostic messages.transform compaction logic, extracted verbatim from the
// adapter-opencode plugin (`runCompartmentTransform`). This is a behavior-zero-change
// physical lift: it accepts the host's message shape via `input`/`output` and all its
// collaborators via dependency injection on `deps` (route B — core accepts host message
// shape). No compression / budget / protectLine / tail / caveman / orphan-sweep logic was
// altered; the only difference from the adapter original is that the 8 diagnostic
// `writeFileSync(...)` sinks are routed through an injected `deps.log` (`emitDiag`).
//
// WARNING — INCIDENT HISTORY: this block has caused catastrophic bugs and must be edited
// with extreme care. Known incidents: build #277 "protectLine blowup" (naive pull-back
// dragged the tail start toward index 0 and produced a 3,877,621-token prompt),
// non-idempotency collapse (double-render emitting thousands of un-compressed messages),
// and orphan tool_result 400s (Anthropic pre-stream rejection). Do NOT "improve" anything
// here. Byte-identical relocation only.
//
// Module-scope constants: NONE. Every constant the body uses (EXECUTE_THRESHOLD,
// PROTECTED_TAGS_COUNT, CLEAR_REASONING_AGE, TRIGGER_MULTIPLIER, FORCE_COMPARTMENT_PCT,
// TARGET_USAGE_PCT, ABORT_PCT, triggerBudget, ...) is declared LOCALLY inside the function
// body — verified by grep against the adapter source — so nothing is hoisted to module scope.

/**
 * Host contract for `runCompartmentTransform`. Any agent host (OpenCode, nvp-server, ...)
 * must supply these collaborators. OpenCode-specific handles are marked optional so a
 * non-OpenCode host can omit them (the body already guards for their absence).
 *
 * This interface documents the DI contract on the PUBLIC signature only. The 950-line
 * function body below is a byte-identical verbatim lift with a catastrophic-bug history
 * (see WARNING above), so the body destructures via `deps as any` to stay type-frozen —
 * the typed contract lives here, on the boundary, without re-type-checking the frozen body.
 */
export interface TransformDeps {
  /** Host-native usage lookup. Returns 0% when the host cannot measure (then self-count applies). */
  getContextUsage: (sid: string) => { percentage: number; inputTokens: number };
  /** True when the host has a real usage source (OpenCode = queries its DB). False/omitted → core self-counts. */
  hasNativeUsage?: boolean;

  storage: any;
  rawStorage: any;
  compartmentStore: any;

  historian: any;
  pendingIdleWork: any;

  countClaudeTokens: (text: string) => number;
  msgTokensMemo: any;
  msgTokenCache: any;
  setActiveTokenizerModel: any;
  resolveContextWindow: any;

  buildToolStub: any;
  resolveToolTier: any;
  toEpochMs: any;
  pinnedTags: any;
  droppedTags: any;

  pluginConfig: any;
  sessionId: any;
  localLlmMode: any;
  autoEscalateAfter: any;

  openCodeDb?: any;
  client?: any;
  dataBase?: any;
  directory?: any;

  state: any;

  log?: (e: { file: string; text: string; append?: boolean }) => void;
}

export async function runCompartmentTransform(input: any, output: any, deps: TransformDeps): Promise<void> {
    // Phase-1 dependency injection (form 2): non-mutable deps destructured to same-name locals
    // (body stays byte-identical), the 9 cross-call mutable states live on deps.state so writes
    // propagate back to the plugin closure (currentOpenCodeSessionId is also read by system.transform).
    // Boundary cast to `any`: the typed TransformDeps contract lives on the signature above; the
    // frozen incident-history body must NOT be re-type-checked, so locals stay effectively `any`.
    const { getContextUsage, compartmentStore, openCodeDb, historian, pendingIdleWork, pluginConfig, rawStorage, storage, msgTokensMemo, msgTokenCache, countClaudeTokens, buildToolStub, resolveToolTier, setActiveTokenizerModel, resolveContextWindow, toEpochMs, pinnedTags, droppedTags, sessionId, dataBase, client, localLlmMode, autoEscalateAfter, directory } = deps as any;
    const state = deps.state;
    const emitDiag = (deps.log as ((e: { file: string; text: string; append?: boolean }) => void) | undefined) ?? (() => {});
      try { emitDiag({ file: "/tmp/neural-transform-heartbeat.log", text: `${new Date().toISOString()} msgs=${output.messages?.length ?? 0}\n`, append: true }); } catch {}
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
            emitDiag({ file: "/tmp/neural-echo-diag.log",
              text: `${new Date().toISOString()} out=${messages.length} IDEMPOTENT-NOOP (already rendered)\n`,
              append: true });
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
        state.currentOpenCodeSessionId = openCodeSessionId;

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

        const lastAssistantModel = (() => {
          for (let i = messages.length - 1; i >= 0; i--) {
            const info = messages[i].info;
            if (info?.role === "assistant" && info.providerID && info.modelID) {
              return { providerID: info.providerID, modelID: info.modelID };
            }
          }
          return null;
        })();

        if (lastAssistantModel && state.lastModelKey) {
          const newKey = `${lastAssistantModel.providerID}/${lastAssistantModel.modelID}`;
          if (state.lastModelKey !== newKey) {
            state.lastModelKey = newKey;
            state.lastContextPercentage = 0;
            state.reasoningWatermark = 0;
          }
        } else if (lastAssistantModel) {
          state.lastModelKey = `${lastAssistantModel.providerID}/${lastAssistantModel.modelID}`;
        }

        setActiveTokenizerModel(lastAssistantModel?.modelID ?? state.lastModelKey);

        const contextLimit = pluginConfig.contextWindowTokens ?? resolveContextWindow(state.lastModelKey);
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
        let usagePct = realUsage.percentage;

        if ((deps as any).hasNativeUsage === false && usagePct === 0) {
          let selfTokens = 0;
          for (const m of messages) selfTokens += msgTokensMemo(m, partBillableText, countClaudeTokens);
          usagePct = (selfTokens / contextLimit) * 100;
        }

        if (realUsage.percentage > 0) {
          state.lastContextPercentage = realUsage.percentage;
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
        const breakerFactor = Math.max(0.25, Math.pow(0.5, Math.min(state.historianFailureCount, 3)));
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
        {
          // Only scan the most-recent HARD_TAIL_CAP messages: older ones can never enter the
          // tail (the budget scan floors there too), so stubbing them is wasted O(N·parts) work.
          const microScanFrom = Math.max(0, messages.length - 500);
          for (let i = microScanFrom; i < messages.length; i++) {
            let mutated = false;
            for (const part of (messages[i].parts ?? [])) {
              const st = (part as any).state;
              const tname = (part as any).tool;
              const tinput = st?.input;
              if (st && typeof st.output === "string" && st.output.length > MICROCOMPACT_TRIGGER_CHARS) {
                const orig = st.output.length;
                st.output = st.output.slice(0, MICROCOMPACT_STUB_CHARS) + buildToolStub(tname, tinput, openCodeSessionId, MICROCOMPACT_STUB_CHARS, orig);
                mutated = true;
              }
              if (typeof (part as any).content === "string" && (part as any).content.length > MICROCOMPACT_TRIGGER_CHARS) {
                const orig = (part as any).content.length;
                (part as any).content = (part as any).content.slice(0, MICROCOMPACT_STUB_CHARS) + buildToolStub(tname, tinput, openCodeSessionId, MICROCOMPACT_STUB_CHARS, orig);
                mutated = true;
              }
            }
            if (mutated) {
              const mid = (messages[i] as any)?.info?.id ?? (messages[i] as any)?.id;
              if (mid) msgTokenCache.delete(mid);
            }
          }
        }
        // #280 incident: keep this at outer (tail) scope — line ~3185 reads it. If moved
        // into the bare block below, it vanishes after `}` → ReferenceError → no compression.
        let protectLine = messages.length;
        {
          // Always run the token-budget scan from the end backward — never emit the
          // whole array unbounded. The removed `if (messages.length <= tailStart)`
          // escape hatch emitted every message with no budget, which is exactly how
          // a bounded-usage session still produced "Input is too long" (out=512).
          // tailStart is only a floor: we won't cross below it (compartment coverage),
          // but the budget can cut the tail shorter.
          // HARD_TAIL_CAP raises the floor so a zero-compartment session with a cold cache
          // still only touches the most-recent K messages instead of thousands. Safety net,
          // not the primary strategy: normal budget scans stop far earlier.
          const HARD_TAIL_CAP = 500;
          const floor = Math.max(
            0,
            Math.min(tailStart, messages.length),
            messages.length - HARD_TAIL_CAP,
          );

          // Protect line (HARDENED — see incident build #277: naive Math.min(startIdx,
          // protectLine) dragged startIdx to ~5 on a giant session, pulling 5165 raw msgs
          // → prompt is too long: 3877621 tokens > 1000000). Intent unchanged: anchor the
          // LAST TWO meaningful user turns so a cross-turn reference survives (user answers
          // "C" pointing at the assistant's A/B/C from the PREVIOUS turn). But now four
          // guardrails make it PHYSICALLY incapable of blowing the budget, aligned with
          // magic-context's resolveProtectedTailBoundary:
          //   (a) span cap   — never look back past MAX_PROTECT_SPAN messages
          //   (b) floor hard bottom — startIdx never escapes below `floor` (HARD_TAIL_CAP=500)
          //   (c) token ceiling — protect pull-back can't push tail past PROTECT_TOTAL_MULT×budget
          //   (d) pressure gate — only extend when usagePct < PROTECT_MAX_USAGE_PCT (0/unknown=allow)
          const MAX_PROTECT_SPAN = 80;        // msgs: enough for ~2 turns even in heavy-tool sessions
          const PROTECT_TOTAL_MULT = 1.3;     // tail may exceed base budget by at most 30% for protection
          const PROTECT_MAX_USAGE_PCT = 70;   // above this, skip protection and stay aggressive
          const hasMeaningfulUserText = (msg: any): boolean => {
            if (msg?.info?.role !== "user") return false;
            let combined = "";
            for (const part of (msg.parts ?? [])) {
              if (part?.type === "text" && typeof part.text === "string") combined += part.text;
            }
            let t = combined.replace(/^§\d+§\s*/, "").trim();
            if (t === "") return false;
            if (t.startsWith("<system-reminder>")) return false;
            if (/^\[(analyze-mode|search-mode|CONTEXT)/.test(t)) return false;
            if (/^<!--[\s\S]*-->$/.test(t)) return false;
            return true;
          };

          // Guard (a)+(b) folded into the scan lower bound so protectLine can NEVER land at ~5.
          const protectFloor = Math.max(floor, messages.length - MAX_PROTECT_SPAN);
          let meaningfulSeen = 0;
          protectLine = messages.length;   // hoisted declaration above; assign only
          for (let i = messages.length - 1; i >= protectFloor; i--) {   // bounded scan, never to 0
            if (hasMeaningfulUserText(messages[i])) {
              meaningfulSeen++;
              protectLine = i;
              if (meaningfulSeen >= 2) break;
            }
          }
          // DB fallback: only adopt the hit if it lands inside the protect span, else ignore
          // (never drag startIdx back into already-compressed territory).
          if (protectLine === messages.length && openCodeDb) {
            try {
              const row = openCodeDb.prepare(
                `SELECT id FROM opencode.message WHERE session_id = ? AND json_extract(data, '$.role') = 'user' ORDER BY time_created DESC LIMIT 1`,
              ).get(openCodeSessionId) as { id: string } | undefined;
              if (row?.id && msgIdToIndex.has(row.id)) {
                const dbIdx = msgIdToIndex.get(row.id) as number;
                if (dbIdx >= protectFloor) protectLine = dbIdx;   // span-bounded only
              }
            } catch {}
          }

          let tailTokens = 0;
          let startIdx = messages.length;
          for (let i = messages.length - 1; i >= floor; i--) {
            const msgTokens = msgTokensMemo(messages[i], partBillableText, countClaudeTokens);
            if (tailTokens + msgTokens > tailBudgetTokens) break;
            tailTokens += msgTokens;
            startIdx = i;
          }
          // N=1 guarantee (safe-newest): the budget loop leaves startIdx at its initial
          // value `messages.length` when the newest single message already exceeds
          // tailBudgetTokens (first iteration breaks). That drops the user's CURRENT
          // input entirely (tail=slice(length)=[] → slice(-1) fallback fires late/fragile).
          // Force-include exactly the newest message. This is NOT a #277-style pull-back:
          // startIdx only advances from `length` to `length-1` (fewer messages, never
          // toward index 0), so it can never re-introduce thousands of raw msgs.
          if (startIdx === messages.length && messages.length > 0) {
            startIdx = messages.length - 1;
            const forcedTokens = msgTokensMemo(messages[startIdx], partBillableText, countClaudeTokens);
            tailTokens += forcedTokens;
            if (forcedTokens > tailBudgetTokens) {
              try {
                emitDiag({ file: `/tmp/neural-newest-oversized-${openCodeSessionId}.log`,
                  text: `${new Date().toISOString()} newest msg ${forcedTokens}tok > budget ${tailBudgetTokens}tok — force-included (single msg exceeds budget; upstream chunking territory)\n`,
                  append: true });
              } catch {}
            }
          }

          // Guard (c)+(d): extend to protect line only under low pressure, and only within a
          // token ceiling. Replaces the old unconditional Math.min(startIdx, protectLine).
          const allowProtect = usagePct < PROTECT_MAX_USAGE_PCT;   // 0/unknown < 70 → allow; guards below cap it
          if (allowProtect && protectLine < startIdx) {
            const protectCeiling = Math.floor(tailBudgetTokens * PROTECT_TOTAL_MULT);
            const target = Math.max(protectFloor, protectLine);    // double safety: never cross span/floor
            for (let i = startIdx - 1; i >= target; i--) {
              const msgTokens = msgTokensMemo(messages[i], partBillableText, countClaudeTokens);
              if (tailTokens + msgTokens > protectCeiling) break;  // token ceiling: stop if protect region overflows
              tailTokens += msgTokens;
              startIdx = i;
            }
          }

          // Floor hard bottom — whatever happened above, startIdx never escapes below floor.
          startIdx = Math.max(floor, startIdx);

          // Sticky start: reuse the previous start only if it sits within [floor, startIdx+5]
          // (no longer re-introduces the protectLine drag).
          if (state.lastTailStartIdx >= floor && state.lastTailStartIdx <= startIdx + 5 && state.lastTailStartIdx < messages.length) {
            startIdx = Math.max(floor, state.lastTailStartIdx);
          }
          state.lastTailStartIdx = startIdx;

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
          if (i === tail.length - 1) continue;
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
        // a bounded stub. Cap size is tier-driven: T3/unknown cut hardest, T2 medium, T1
        // (read-only probes) most generous — cheap-to-refetch output loses least context.
        const TOOL_CAP_BY_TIER: Record<1 | 2 | 3, number> = { 1: 4000, 2: 2000, 3: 800 };
        const toolTruncFloor = Math.max(0, tail.length - PROTECTED_TAGS_COUNT);
        for (let i = 0; i < toolTruncFloor; i++) {
          for (const part of (tail[i].parts ?? [])) {
            const st = (part as any).state;
            const tname = (part as any).tool;
            const cap = TOOL_CAP_BY_TIER[resolveToolTier(tname)];
            if (st && typeof st.output === "string" && st.output.length > cap) {
              const orig = st.output.length;
              st.output = st.output.slice(0, cap) + buildToolStub(tname, st.input, openCodeSessionId, cap, orig);
            }
            if (typeof (part as any).content === "string" && (part as any).content.length > cap) {
              const orig = (part as any).content.length;
              (part as any).content = (part as any).content.slice(0, cap) + buildToolStub(tname, st?.input, openCodeSessionId, cap, orig);
            }
          }
        }

        // Protected tail keeps text verbatim, but a single huge tool output could still
        // blow the whole prompt past the model limit. Cap tool output here (wider than the
        // non-protected caps) — text parts are never touched, only tool results.
        const PROTECTED_TOOL_OUTPUT_MAX_CHARS = 16000;
        const protectTailStartInTail = Math.max(0, protectLine - tailActualStart);
        for (let i = protectTailStartInTail; i < tail.length; i++) {
          for (const part of (tail[i].parts ?? [])) {
            const st = (part as any).state;
            const tname = (part as any).tool;
            if (st && typeof st.output === "string" && st.output.length > PROTECTED_TOOL_OUTPUT_MAX_CHARS) {
              const orig = st.output.length;
              st.output = st.output.slice(0, PROTECTED_TOOL_OUTPUT_MAX_CHARS) + buildToolStub(tname, st.input, openCodeSessionId, PROTECTED_TOOL_OUTPUT_MAX_CHARS, orig);
            }
            if (typeof (part as any).content === "string" && (part as any).content.length > PROTECTED_TOOL_OUTPUT_MAX_CHARS) {
              const orig = (part as any).content.length;
              (part as any).content = (part as any).content.slice(0, PROTECTED_TOOL_OUTPUT_MAX_CHARS) + buildToolStub(tname, st?.input, openCodeSessionId, PROTECTED_TOOL_OUTPUT_MAX_CHARS, orig);
            }
          }
        }

        // Emergency drop (mirrors magic-context): only under real pressure, reclaim the
        // lowest-value tool outputs entirely (sentinel + retrievable stub). Tier order
        // T3→T2→T1 drops cheap/unknown tools first; each tier keeps its most-recent
        // TIER_RECENCY_RESERVE fraction verbatim. Only touches the non-protected region.
        const EMERGENCY_DROP_PCT = 85;
        const TIER_RECENCY_RESERVE = 0.2;
        if (usagePct >= EMERGENCY_DROP_PCT) {
          const emTruncFloor = Math.max(0, tail.length - PROTECTED_TAGS_COUNT);
          const byTier: Record<1 | 2 | 3, number[]> = { 1: [], 2: [], 3: [] };
          for (let i = 0; i < emTruncFloor; i++) {
            let hasTool = false;
            let tname = "";
            for (const part of (tail[i].parts ?? [])) {
              if ((part as any).type === "tool" || (part as any).state?.output !== undefined) {
                hasTool = true;
                tname = (part as any).tool ?? tname;
              }
            }
            if (hasTool) byTier[resolveToolTier(tname)].push(i);
          }
          const emDropSet = new Set<number>();
          for (const tier of [3, 2, 1] as const) {
            const idxs = byTier[tier];
            if (idxs.length === 0) continue;
            const reserveCount = Math.ceil(TIER_RECENCY_RESERVE * idxs.length);
            const keepFrom = idxs.length - reserveCount;
            for (let k = 0; k < keepFrom; k++) emDropSet.add(idxs[k]);
          }
          for (const i of emDropSet) {
            for (const part of (tail[i].parts ?? [])) {
              const st = (part as any).state;
              const tname = (part as any).tool;
              if (st && typeof st.output === "string" && st.output.length > 0) {
                const orig = st.output.length;
                st.output = buildToolStub(tname, st.input, openCodeSessionId, 0, orig);
              }
              if (typeof (part as any).content === "string" && (part as any).content.length > 0) {
                const orig = (part as any).content.length;
                (part as any).content = buildToolStub(tname, st?.input, openCodeSessionId, 0, orig);
              }
            }
          }
        }

        let prevRole = "";
        for (let i = 0; i < tail.length; i++) {
          const msg = tail[i];
          tagCounter++;

          const isPinned = pinnedTags.has(tagCounter);

          if (!isPinned && (droppedTags.has(tagCounter) || toolDropIndices.has(i))) {
            rendered.push({
              info: msg.info,
              parts: [{ type: "text", text: "" }],
            });
            prevRole = msg.info?.role ?? "";
            continue;
          }

          const isProtected = isPinned || tagCounter > protectedFloor;
          const ts = toEpochMs(msg.info?.time?.created);

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
            if (tagCounter <= reasoningCutoff || tagCounter <= state.reasoningWatermark) {
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
          if (newWatermark > state.reasoningWatermark) {
            state.reasoningWatermark = newWatermark;
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
            // Pair by id, never by position. The newest rendered message is exempt so the
            // user's current turn is never gutted; Pass D below normalizes any residual
            // trailing tool_result into a protocol-legal boundary.
            const lastRenderedIdx = rendered.length - 1;
            for (let ri = 0; ri < rendered.length; ri++) {
              const m = rendered[ri];
              if (m.info?.role !== "user") continue;
              if (ri === lastRenderedIdx) continue;
              m.parts = ((m.parts ?? []) as any[]).filter(
                (p) => p?.type !== "tool_result" || (typeof p.tool_use_id === "string" && liveToolUseIds.has(p.tool_use_id))
              );
            }

            // Pass C: remove user messages emptied by Pass B. The newest message is never
            // spliced (N=1 guarantee). If everything else collapsed, Pass D re-injects a sentinel.
            for (let i = rendered.length - 1; i >= 0; i--) {
              if (i === rendered.length - 1) continue;
              const m = rendered[i];
              if (m.info?.role === "user" && (m.parts?.length ?? 0) === 0) rendered.splice(i, 1);
            }

            try {
              const orphanRemaining = rendered.length > 0
                ? ((rendered[0].parts ?? []) as any[]).some((p) => p?.type === "tool_result")
                : false;
              emitDiag({ file: `/tmp/neural-orphan-sweep-${openCodeSessionId}.log`,
                text: `${new Date().toISOString()} liveIds=${liveToolUseIds.size} toolCallParts=${toolCallPartCount} renderedAfter=${rendered.length} head0StillToolResult=${orphanRemaining}\n`,
                append: true });
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
                state.dissatisfactionCount++;
                if (state.dissatisfactionCount >= autoEscalateAfter) {
                  messages.push({
                    info: { role: "user" },
                    parts: [{ type: "text", text: `[System hint: The user has expressed dissatisfaction ${state.dissatisfactionCount} times. Your confidence should be LOW. Consider calling neural_ask_server for the current problem.]` }],
                  });
                }
              } else if (userText.length > 10) {
                state.dissatisfactionCount = Math.max(0, state.dissatisfactionCount - 1);
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
              // msgTokensMemo adds a fixed +10 per-message overhead; subtract it to keep
              // this diagnostic sum identical to the old bare billable-token total.
              tailEstTokens += msgTokensMemo(m, partBillableText, countClaudeTokens) - 10;
            }
            emitDiag({ file: `/tmp/neural-rendered-${openCodeSessionId}.json`, text: JSON.stringify({
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
            }, null, 2) });
          } catch {}
        }

        state.historianTurnCount++;
        const tailCount = Math.max(0, tail.length - PROTECTED_TAGS_COUNT);
        const tailTokensEstimate = tailCount * 500;

        const hasUncoveredNewMessages = (() => {
          if (state.lastCompressTime === 0) return false;
          for (let i = tailStart; i < messages.length; i++) {
            const msgTime = toEpochMs(messages[i].info?.time?.created);
            if (msgTime > state.lastCompressTime) return true;
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
        const historianChunkTokens = Math.max(8000, Math.min(50000, Math.round(contextLimit * 0.25)));
        const chunkSize = Math.round(historianChunkTokens / 500);
        const compressMode: "force" | "abort" | "normal" =
          (usagePct >= FORCE_COMPARTMENT_PCT && !isMidTurn) ? "force"
          : (usagePct >= ABORT_PCT) ? "abort"
          : "normal";
        const linkMsgs = messages.slice(-2)
          .filter((m: any) => m.info?.role === "user" || m.info?.role === "assistant")
          .map((m: any) => ({
            role: m.info.role as string,
            content: (m.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text ?? "").join("\n").trim(),
          }));
        if (openCodeSessionId) {
          pendingIdleWork.set(openCodeSessionId, {
            shouldCompress: shouldFireHistorian,
            mode: compressMode,
            lastEndOrd,
            chunkSize,
            minUncovered: PROTECTED_TAGS_COUNT + 1,
            linkMsgs,
          });
        }

        const afterPct = realUsage.percentage > 0
          ? Math.round(realUsage.percentage * (rendered.length / Math.max(messages.length, 1)))
          : Math.round((rendered.length * 500 / contextLimit) * 100);
        const statusPath = openCodeSessionId
          ? `/tmp/neural-compartment-status-${openCodeSessionId}.json`
          : "/tmp/neural-compartment-status.json";
        emitDiag({ file: statusPath, text: JSON.stringify({
          ts: Date.now(),
          beforePct: Math.round(usagePct || (messages.length * 500 / contextLimit) * 100),
          afterPct,
          compartments: compartments.length,
          scheduler: schedulerDecision,
          historianFailures: state.historianFailureCount,
          openCodeSessionId,
          realUsagePct: realUsage.percentage,
          msgCount: messages.length,
          renderedCount: rendered.length,
          msgSizes: messages.slice(0, 5).map((m: any) => JSON.stringify(m.parts ?? []).length),
        }) });
      } catch (transformErr: any) {
        try { emitDiag({ file: "/tmp/neural-transform-error.log", text: `${Date.now()} ${transformErr?.message ?? transformErr}\n${transformErr?.stack ?? ""}\n`, append: true }); } catch {}
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
          emitDiag({ file: "/tmp/neural-echo-diag.log",
            text: `${new Date().toISOString()} out=${output.messages.length} tailRoles=[${roleSeq}] lastRole=${lastMsg?.info?.role} hadContent=${hasContent} lastText=${JSON.stringify(lastText)}\n`,
            append: true });
        } catch {}
      }
  }
