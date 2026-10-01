// historian-model-compare.ts — side-by-side historian-summary comparison:
// local ollama (qwen3:14b, free) vs a large cloud model (via proxy).
//
// WHY: deciding whether B/D compaction summaries can run on the free local 14b
// instead of a paid large model. Summaries are a closed compression task, so a
// 14b is expected to be "good enough" — but the real risk is DROPPED key facts /
// HALLUCINATION, not prose quality. This harness feeds the SAME real history
// chunks and the SAME historian prompt to both models so you can eyeball exactly
// what the 14b misses or invents.
//
// Pulls real chunks from a transcript MD (verbatim conversation). No secrets are
// embedded: both endpoints come from env vars.
//
// Usage:
//   BIG_URL=http://localhost:6655/anthropic/v1 BIG_KEY=sk-... BIG_MODEL=claude-opus-4-8 \
//   OLLAMA_URL=http://localhost:11434 OLLAMA_MODEL=qwen3:14b \
//   TRANSCRIPT=~/.local/share/ai-agent-local-memory/transcripts/<sid>.md \
//   CHUNKS=3 \
//   bun benchmark/historian-model-compare.ts
//
// Defaults: ollama localhost:11434 qwen3:14b, 3 chunks of ~12 msgs each.

import { readFileSync } from "node:fs";
import { OpenAICompatibleLLM, OllamaLLM } from "../packages/core/src/providers/index.ts";

// The historian prompt — copied verbatim from packages/core/src/historian.ts (L33-40)
// so the comparison reflects the REAL production summary task, not an approximation.
const HISTORIAN_PROMPT = `You compress conversation history into three fidelity tiers.
Output STRICT JSON: { "p1": "...", "p2": "...", "p3": "..." }

p1: One paragraph (≤150 tokens). Capture: user goals, decisions made, files/symbols touched, errors hit, current state. Past tense. No filler.
p2: One sentence (≤25 tokens). The single most important thing that happened.
p3: A title (≤8 tokens). Like a git commit subject.

Transcript lines shaped "[tool: NAME] in=... → ..." are tool calls and their results — these carry the bulk of the work (files read, commands run, outputs returned). Summarize what each tool found or produced (key results, values, errors), not that a tool ran. Preserve concrete identifiers verbatim: file paths, function names, error strings, key output values. Drop pleasantries.`;

type Msg = { role: string; content: string };

// Parse a transcript MD into role/content messages. Real format: each turn starts
// with a line-leading "[user]" or "[assistant]" marker and runs until the next such
// marker. Legacy lines wrap content as {"text":"..."} — unwrap those to raw text.
function parseTranscript(md: string): Msg[] {
  const out: Msg[] = [];
  const lines = md.split("\n");
  let role: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (role && buf.length) {
      let content = buf.join("\n").trim();
      const m = content.match(/^\{"text":"([\s\S]*)"\}$/);
      if (m) { try { content = JSON.parse(content).text; } catch {} }
      if (content) out.push({ role, content });
    }
    buf = [];
  };
  for (const line of lines) {
    const mk = line.match(/^\[(user|assistant)\]\s?(.*)$/);
    if (mk) {
      flush();
      role = mk[1];
      buf = mk[2] ? [mk[2]] : [];
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
}

// Build the exact transcript string historian.compress() builds (L81): role-tagged,
// each content capped at 1000 chars.
function buildHistorianTranscript(window: Msg[]): string {
  return window.map(m => `[${m.role}]: ${m.content.slice(0, 1000)}`).join("\n\n");
}

// Call the big model via Anthropic's native /messages API (hai proxy's claude models
// reject the OpenAI /chat/completions subpath, so OpenAICompatibleLLM can't reach them).
async function anthropicComplete(baseUrl: string, apiKey: string, model: string, prompt: string): Promise<string> {
  const url = `${baseUrl.replace(/\/$/, "")}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model, max_tokens: 400, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();
  return (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
}

async function summarize(kind: "local" | "big", cfg: any, transcript: string): Promise<string> {
  // qwen3 is a reasoning model: without /no_think it dumps everything into reasoning_content
  // and leaves `content` empty. Historian needs clean JSON, so the local path forces thinking off.
  const basePrompt = `${HISTORIAN_PROMPT}\n\nCONVERSATION:\n${transcript}\n\nJSON:`;
  const prompt = kind === "local" ? `/no_think ${basePrompt}` : basePrompt;
  const t0 = Date.now();
  try {
    let r: string | null;
    if (kind === "big" && cfg.anthropic) {
      r = await anthropicComplete(cfg.baseUrl, cfg.apiKey, cfg.model, prompt);
    } else {
      r = await cfg.llm.complete(prompt, { model: cfg.model, maxTokens: 400 });
    }
    return `(${Date.now() - t0}ms)\n${(r ?? "").trim()}`;
  } catch (e: any) {
    return `ERROR: ${e?.message ?? e}`;
  }
}

async function main() {
  const home = process.env.HOME || "";
  const transcriptPath = (process.env.TRANSCRIPT || `${home}/.local/share/ai-agent-local-memory/transcripts/ses_166d0e7b9ffeBpCjAtqVkPPkP4.md`).replace(/^~/, home);
  const chunks = parseInt(process.env.CHUNKS || "3", 10);
  const windowSize = parseInt(process.env.WINDOW || "12", 10);

  const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
  const ollamaModel = process.env.OLLAMA_MODEL || "qwen3:14b";
  const bigUrl = process.env.BIG_URL;
  const bigKey = process.env.BIG_KEY;
  const bigModel = process.env.BIG_MODEL || "claude-opus-4-8";

  const local = new OllamaLLM({ baseUrl: ollamaUrl, model: ollamaModel });
  const localCfg = { kind: "local" as const, llm: local, model: undefined };
  const bigAnthropic = !!bigUrl && /anthropic/.test(bigUrl);
  const big = bigUrl && !bigAnthropic ? new OpenAICompatibleLLM({ baseUrl: bigUrl, apiKey: bigKey, model: bigModel }) : null;
  const bigCfg = bigUrl ? { kind: "big" as const, anthropic: bigAnthropic, baseUrl: bigUrl, apiKey: bigKey, model: bigModel, llm: big } : null;

  const md = readFileSync(transcriptPath, "utf8");
  const msgs = parseTranscript(md);
  console.log(`transcript: ${transcriptPath}`);
  console.log(`parsed ${msgs.length} messages; comparing ${chunks} chunks of ${windowSize} msgs each`);
  console.log(`LOCAL: ollama ${ollamaModel} @ ${ollamaUrl}`);
  console.log(`BIG:   ${bigCfg ? `${bigModel} @ ${bigUrl}${bigAnthropic ? " (anthropic native)" : ""}` : "(not configured — set BIG_URL/BIG_KEY to compare)"}`);
  console.log("=".repeat(80));

  // Sample chunks evenly across the whole history (oldest→newest) so we test the
  // model on varied material, not just one region.
  const step = Math.max(windowSize, Math.floor(msgs.length / (chunks + 1)));
  for (let c = 0; c < chunks; c++) {
    const start = c * step;
    const window = msgs.slice(start, start + windowSize);
    if (window.length < 4) break;
    const transcript = buildHistorianTranscript(window);

    console.log(`\n### CHUNK ${c + 1}  (msgs ${start}..${start + window.length - 1})`);
    console.log(`--- input preview (first 200 chars) ---`);
    console.log(transcript.slice(0, 200) + "…");

    const localOut = await summarize("local", localCfg, transcript);
    console.log(`\n--- LOCAL ${ollamaModel} ---\n${localOut}`);

    if (bigCfg) {
      const bigOut = await summarize("big", bigCfg, transcript);
      console.log(`\n--- BIG ${bigModel} ---\n${bigOut}`);
    }
    console.log("\n" + "-".repeat(80));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
