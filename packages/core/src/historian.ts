import type { LLMProvider } from "./interfaces.ts";

export interface Compartment {
  id: number;
  sessionId: string;
  startOrd: number;
  endOrd: number;
  startMessageId: string;
  endMessageId: string;
  p1: string;
  p2: string;
  p3: string;
  tokenCount: number;
  createdAt: number;
}

export interface HistorianConfig {
  llm: LLMProvider;
  fallbackModels?: string[];
  minWindow?: number;
  maxWindow?: number;
}

export interface HistorianMessage {
  role: string;
  content: string;
  ord: number;
  id?: string;
}

const HISTORIAN_PROMPT = `You compress conversation history into three fidelity tiers.
Output STRICT JSON: { "p1": "...", "p2": "...", "p3": "..." }

p1: One paragraph (≤150 tokens). Capture: user goals, decisions made, files/symbols touched, errors hit, current state. Past tense. No filler.
p2: One sentence (≤25 tokens). The single most important thing that happened.
p3: A title (≤8 tokens). Like a git commit subject.

Preserve concrete identifiers verbatim: file paths, function names, error strings. Drop pleasantries and tool boilerplate.`;

export class Historian {
  private config: { llm: LLMProvider; fallbackModels: string[]; minWindow: number; maxWindow: number };
  private running = new Set<string>();
  private queue = new Map<string, { messages: HistorianMessage[] }>();

  constructor(config: HistorianConfig) {
    this.config = {
      llm: config.llm,
      fallbackModels: config.fallbackModels ?? [],
      minWindow: config.minWindow ?? 6,
      maxWindow: config.maxWindow ?? 12,
    };
  }

  enqueue(sessionId: string, messages: HistorianMessage[]): void {
    if (this.running.has(sessionId)) return;
    this.queue.set(sessionId, { messages });
    void this.processNext();
  }

  private async processNext(): Promise<void> {
    for (const [sessionId, job] of this.queue) {
      if (this.running.has(sessionId)) continue;
      this.queue.delete(sessionId);
      this.running.add(sessionId);

      try {
        await this.compress(sessionId, job.messages);
      } catch {
      } finally {
        this.running.delete(sessionId);
      }
    }
  }

  async compress(sessionId: string, messages: HistorianMessage[]): Promise<Compartment | null> {
    const window = messages.slice(0, this.config.maxWindow);
    if (window.length < this.config.minWindow) return null;

    const transcript = window.map(m => `[${m.role}]: ${m.content.slice(0, 1000)}`).join("\n\n");
    const prompt = `${HISTORIAN_PROMPT}\n\nCONVERSATION:\n${transcript}\n\nJSON:`;

    let response: string | null = null;
    const modelsToTry = [undefined, ...this.config.fallbackModels];
    for (const model of modelsToTry) {
      try {
        response = await this.config.llm.complete(prompt, { model, maxTokens: 300 });
        if (response) break;
      } catch {
        continue;
      }
    }
    if (!response) return null;

    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.p1 || !parsed.p2 || !parsed.p3) return null;

      // Derive boundaries from the min/max ordinal in the window rather than
      // window[0]/window[last]. Callers may hand us messages whose `ord` is not
      // monotonic (mixed DB-ordinal and fallback values), which previously
      // produced startOrd > endOrd and a corrupt compartment range.
      let startMsg = window[0];
      let endMsg = window[0];
      for (const m of window) {
        if (m.ord < startMsg.ord) startMsg = m;
        if (m.ord > endMsg.ord) endMsg = m;
      }

      return {
        id: 0,
        sessionId,
        startOrd: startMsg.ord,
        endOrd: endMsg.ord,
        startMessageId: startMsg.id ?? "",
        endMessageId: endMsg.id ?? "",
        p1: String(parsed.p1),
        p2: String(parsed.p2),
        p3: String(parsed.p3),
        tokenCount: Math.round(transcript.length / 4),
        createdAt: Date.now(),
      };
    } catch {
      return null;
    }
  }
}
