// Golden regression snapshots for runCompartmentTransform (packages/core).
//
// PURPOSE: freeze CURRENT behavior of the compaction pipeline. These are NOT correctness
// tests against a spec — any future edit that alters output is meant to break a snapshot.
// The pipeline has a documented history of catastrophic bugs (protectLine blowup #277,
// non-idempotency collapse, orphan tool_result 400s); this harness is the safety net.
//
// Snapshots store STRUCTURAL SUMMARIES only (counts, role sequence, id list, per-message
// text length, tool-output lengths, part-type shape, diag file sinks) — never full text
// bodies (too large) and never raw timestamps / Date.now() (would break run-to-run
// determinism). Time-derived fields are deterministic because every fixture message uses a
// fixed BASE_TIME with small (<5min) inter-message gaps, so no gap labels are injected.

import { describe, test, expect } from "bun:test";
import { runCompartmentTransform } from "../src/context-compressor.ts";
import {
  makeMsg,
  buildDeps,
  summarize,
  diagFiles,
  toolOutLens,
  textLen,
  BASE_TIME,
  type Part,
} from "./fixtures.ts";

const SID = "test-session";

function genText(seed: string, approxLen: number): string {
  let s = "";
  let n = 0;
  while (s.length < approxLen) s += `${seed}${n++} token phrase content chunk. `;
  return s.slice(0, approxLen);
}

function lastMsg(output: any): any {
  return output.messages[output.messages.length - 1];
}

describe("runCompartmentTransform golden snapshots", () => {
  test("scenario 1: tiny — near-passthrough", async () => {
    const messages = [
      makeMsg("user", "m0", "Hi there", SID, BASE_TIME + 0),
      makeMsg("assistant", "m1", "Hello, how can I help?", SID, BASE_TIME + 1000),
      makeMsg("user", "m2", "What is 2+2?", SID, BASE_TIME + 2000),
    ];
    const output: any = { messages };
    const { deps, diagCalls } = buildDeps({ contextUsagePct: 5 });

    await runCompartmentTransform({}, output, deps);

    expect(summarize(output.messages)).toMatchSnapshot();
    expect(diagFiles(diagCalls)).toMatchSnapshot();
  });

  test("scenario 2: giant — heavy tail-cut, bounded, newest preserved", async () => {
    const N = 600;
    const messages = [];
    for (let i = 0; i < N; i++) {
      const role = i % 2 === 0 ? "assistant" : "user";
      messages.push(makeMsg(role, `m${i}`, genText(`s2msg${i}-`, 500), SID, BASE_TIME + i * 1000));
    }
    const newestId = `m${N - 1}`;
    const newestText = messages[N - 1].parts[0].text;
    const output: any = { messages };
    const { deps } = buildDeps({ contextUsagePct: 0 });

    await runCompartmentTransform({}, output, deps);

    const out = output.messages;
    expect({
      count: out.length,
      firstId: out[0]?.info?.id ?? null,
      lastId: out[out.length - 1]?.info?.id ?? null,
      lastTextLen: textLen(out[out.length - 1]),
    }).toMatchSnapshot();

    expect(out.length).toBeLessThanOrEqual(500);
    const last = lastMsg(output);
    expect(last.info.id).toBe(newestId);
    const lastText = (last.parts ?? []).filter((p: Part) => p.type === "text").map((p: Part) => p.text).join("");
    expect(lastText).toContain(newestText);
  });

  test("scenario 3: tool-heavy — microCompact stubs oversized tool outputs", async () => {
    const messages = [];
    let assistantOrd = 0;
    for (let i = 0; i < 40; i++) {
      if (i % 2 === 0) {
        messages.push(makeMsg("user", `m${i}`, `question ${i}`, SID, BASE_TIME + i * 1000));
      } else {
        const withTool = assistantOrd % 2 === 0;
        assistantOrd++;
        const parts: Part[] = [{ type: "text", text: `response ${i}` }];
        if (withTool) {
          parts.push({
            type: "tool",
            tool: "bash",
            callID: `toolu_${i}`,
            state: { status: "completed", input: { command: `run ${i}` }, output: "X".repeat(80000) },
          });
        }
        messages.push(makeMsg("assistant", `m${i}`, parts, SID, BASE_TIME + i * 1000));
      }
    }
    const output: any = { messages };
    const { deps, diagCalls } = buildDeps({ contextUsagePct: 0 });

    await runCompartmentTransform({}, output, deps);

    const out = output.messages;
    expect({
      count: out.length,
      roles: out.map((m: any) => m.info?.role ?? "?"),
      toolOutLens: out.map((m: any) => toolOutLens(m)),
      truncatedIndices: out.map((m: any, i: number) => (toolOutLens(m).some((l: number) => l > 0 && l < 80000) ? i : -1)).filter((i: number) => i >= 0),
    }).toMatchSnapshot();
    expect(diagFiles(diagCalls)).toMatchSnapshot();
  });

  test("scenario 4: mid-turn — orphan sweep + trailing boundary + newest exemption", async () => {
    const messages = [
      makeMsg("assistant", "m0", "analysis start", SID, BASE_TIME + 0),
      makeMsg("user", "m1", "q1", SID, BASE_TIME + 1000),
      makeMsg("assistant", "m2", [
        { type: "text", text: "working" },
        { type: "tool_call", name: "bash", callID: "toolu_A" },
      ], SID, BASE_TIME + 2000),
      makeMsg("user", "m3", [
        { type: "text", text: "result A" },
        { type: "tool_result", tool_use_id: "toolu_A" },
      ], SID, BASE_TIME + 3000),
      makeMsg("user", "m4", [
        { type: "tool_result", tool_use_id: "toolu_ORPHAN1" },
      ], SID, BASE_TIME + 4000),
      makeMsg("assistant", "m5", [
        { type: "text", text: "more work" },
        { type: "tool_call", name: "bash", callID: "toolu_B" },
      ], SID, BASE_TIME + 5000),
      makeMsg("user", "m6", [
        { type: "text", text: "result B" },
        { type: "tool_result", tool_use_id: "toolu_B" },
      ], SID, BASE_TIME + 6000),
      makeMsg("user", "m7", [
        { type: "text", text: "final question" },
        { type: "tool_result", tool_use_id: "toolu_ORPHAN2" },
      ], SID, BASE_TIME + 7000),
    ];
    const output: any = { messages };
    const { deps } = buildDeps({ contextUsagePct: 0 });

    await runCompartmentTransform({}, output, deps);

    const out = output.messages;
    expect({
      count: out.length,
      roles: out.map((m: any) => m.info?.role ?? "?"),
      ids: out.map((m: any) => m.info?.id ?? null),
      partTypes: out.map((m: any) => (m.parts ?? []).map((p: Part) => p.type)),
    }).toMatchSnapshot();

    const headHasToolResult = (out[0]?.parts ?? []).some((p: Part) => p.type === "tool_result");
    expect(headHasToolResult).toBe(false);

    const lastIdx = out.length - 1;
    const liveCallIds = new Set<string>();
    for (const m of out) {
      for (const p of (m.parts ?? []) as Part[]) {
        if ((p.type === "tool" || p.type === "tool_call") && typeof p.callID === "string") liveCallIds.add(p.callID);
      }
    }
    for (let ri = 0; ri < out.length; ri++) {
      if (ri === lastIdx) continue;
      for (const p of (out[ri].parts ?? []) as Part[]) {
        if (p.type === "tool_result") expect(liveCallIds.has(p.tool_use_id)).toBe(true);
      }
    }

    const last = lastMsg(output);
    expect(last.info.id).toBe("m7");
    const lastText = (last.parts ?? []).filter((p: Part) => p.type === "text").map((p: Part) => p.text).join("");
    expect(lastText).toContain("final question");
  });

  test("scenario 5: with-compartments — tail starts after last compartment endMessageId", async () => {
    const N = 100;
    const messages = [];
    for (let i = 0; i < N; i++) {
      const role = i % 2 === 0 ? "assistant" : "user";
      messages.push(makeMsg(role, `m${i}`, `msg ${i} body`, SID, BASE_TIME + i * 1000));
    }
    const compartments = [
      { id: 1, sessionId: SID, startOrd: 0, endOrd: 20, startMessageId: "m0", endMessageId: "m20", p1: "p1a", p2: "p2a", p3: "p3a", tokenCount: 100, createdAt: BASE_TIME },
      { id: 2, sessionId: SID, startOrd: 21, endOrd: 40, startMessageId: "m21", endMessageId: "m40", p1: "p1b", p2: "p2b", p3: "p3b", tokenCount: 100, createdAt: BASE_TIME },
    ];
    const output: any = { messages };
    const { deps } = buildDeps({ contextUsagePct: 0, compartments });

    await runCompartmentTransform({}, output, deps);

    const out = output.messages;
    const ids = out.map((m: any) => m.info?.id ?? null);
    expect({
      count: out.length,
      firstId: ids[0],
      lastId: ids[ids.length - 1],
    }).toMatchSnapshot();

    for (let i = 0; i <= 40; i++) {
      expect(ids).not.toContain(`m${i}`);
    }
    expect(ids).toContain("m41");
    expect(ids).toContain("m99");
  });

  test("scenario 6: idempotency — second call is a no-op (RENDERED_SENTINEL guard)", async () => {
    const messages = [
      makeMsg("user", "m0", "first message here", SID, BASE_TIME + 0),
      makeMsg("assistant", "m1", "an assistant reply", SID, BASE_TIME + 1000),
      makeMsg("user", "m2", "a follow-up question", SID, BASE_TIME + 2000),
    ];
    const output: any = { messages };
    const { deps, diagCalls } = buildDeps({ contextUsagePct: 5 });

    await runCompartmentTransform({}, output, deps);
    const afterFirst = summarize(output.messages);
    const diagCountBeforeSecond = diagCalls.length;

    await runCompartmentTransform({}, output, deps);
    const afterSecond = summarize(output.messages);

    expect(afterSecond).toEqual(afterFirst);

    const secondCallDiags = diagCalls.slice(diagCountBeforeSecond);
    const sawNoop = secondCallDiags.some((d) => d.text.includes("IDEMPOTENT-NOOP"));
    expect(sawNoop).toBe(true);

    expect(afterFirst).toMatchSnapshot();
  });
});
