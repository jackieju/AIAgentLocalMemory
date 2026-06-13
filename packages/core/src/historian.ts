import type { LLMProvider } from "./interfaces.ts";

export interface Compartment {
  id: number;
  sessionId: string;
  startOrd: number;
  endOrd: number;
  p1: string;
  p2: string;
  p3: string;
  tokenCount: number;
  createdAt: number;
}

export interface HistorianConfig {
  llm: LLMProvider;
  minWindow?: number;
  maxWindow?: number;
}

export interface HistorianMessage {
  role: string;
  content: string;
  ord: number;
}

const HISTORIAN_PROMPT = `You compress conversation history into three fidelity tiers.
Output STRICT JSON: { "p1": "...", "p2": "...", "p3": "..." }

p1: One paragraph (≤150 tokens). Capture: user goals, decisions made, files/symbols touched, errors hit, current state. Past tense. No filler.
p2: One sentence (≤25 tokens). The single most important thing that happened.
p3: A title (≤8 tokens). Like a git commit subject.

Preserve concrete identifiers verbatim: file paths, function names, error strings. Drop pleasantries and tool boilerplate.`;

export class Historian {
  private config: Required<HistorianConfig>;
  private running = new Set<string>();
  private queue = new Map<string, { messages: HistorianMessage[] }>();

  constructor(config: HistorianConfig) {
    this.config = {
      llm: config.llm,
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

    let response: string;
    try {
      response = await this.config.llm.complete(
        `${HISTORIAN_PROMPT}\n\nCONVERSATION:\n${transcript}\n\nJSON:`,
        { maxTokens: 300 }
      );
    } catch {
      return null;
    }

    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.p1 || !parsed.p2 || !parsed.p3) return null;

      return {
        id: 0,
        sessionId,
        startOrd: window[0].ord,
        endOrd: window[window.length - 1].ord,
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
