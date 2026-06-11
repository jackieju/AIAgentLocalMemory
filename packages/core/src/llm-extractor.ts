import type { ConceptExtraction, LLMProvider } from "./interfaces.ts";

const MAX_CHUNK_CHARS = 4000;

interface ConceptItem {
  content: string;
  importance: number;
}

interface RelatedItem {
  content: string;
  relatedConcepts: string[];
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function chunkText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    const sentenceBreak = Math.max(
      window.lastIndexOf(". "),
      window.lastIndexOf(".\n"),
      window.lastIndexOf("\n\n"),
    );
    const newlineBreak = window.lastIndexOf("\n");
    const splitAt =
      sentenceBreak > maxChars / 2
        ? sentenceBreak + 1
        : newlineBreak > maxChars / 2
          ? newlineBreak + 1
          : maxChars;

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export class LLMExtractor {
  constructor(private readonly llm: LLMProvider) {}

  async extract(text: string): Promise<ConceptExtraction> {
    const prompt = this.buildPrompt(text);
    const response = await this.llm.complete(prompt, { maxTokens: 1000 });
    return this.parseResponse(response);
  }

  async extractFromSession(
    messages: Array<{ role: string; content: string }>,
  ): Promise<ConceptExtraction> {
    const text = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");

    const chunks = chunkText(text, MAX_CHUNK_CHARS);
    const results: ConceptExtraction[] = [];

    for (const chunk of chunks) {
      try {
        results.push(await this.extract(chunk));
      } catch {
        results.push({ concepts: [], assertions: [], definitions: [] });
      }
    }

    return this.mergeExtractions(results);
  }

  private buildPrompt(text: string): string {
    return `Extract structured knowledge from this conversation text.

Return a JSON object with exactly this format:
{
  "concepts": [{"content": "short concept phrase", "importance": 0.0-1.0}],
  "assertions": [{"content": "claim or decision", "relatedConcepts": ["concept1", "concept2"]}],
  "definitions": [{"content": "X is/means Y", "relatedConcepts": ["concept1"]}]
}

Rules:
- concepts: key entities, technologies, people, specific terms (3-15 words each)
- assertions: decisions, preferences, constraints, conclusions (one sentence each)
- definitions: explanations of what something is or does
- importance: 0.9 for critical decisions, 0.7 for useful facts, 0.5 for context
- Extract 3-10 concepts, 1-5 assertions, 0-3 definitions per chunk
- Be specific and factual — no generic statements

TEXT:
${text}

JSON:`;
  }

  private parseResponse(response: string): ConceptExtraction {
    const empty: ConceptExtraction = { concepts: [], assertions: [], definitions: [] };

    const stripped = response
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();

    const jsonMatch = stripped.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return empty;

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return empty;
    }

    if (!isRecord(parsed)) return empty;

    const concepts: ConceptItem[] = [];
    if (Array.isArray(parsed.concepts)) {
      for (const c of parsed.concepts) {
        if (
          isRecord(c) &&
          isString(c.content) &&
          c.content.trim().length > 0 &&
          typeof c.importance === "number" &&
          Number.isFinite(c.importance)
        ) {
          const importance = Math.max(0, Math.min(1, c.importance));
          concepts.push({ content: c.content.trim(), importance });
        }
      }
    }

    const assertions: RelatedItem[] = [];
    if (Array.isArray(parsed.assertions)) {
      for (const a of parsed.assertions) {
        if (isRecord(a) && isString(a.content) && a.content.trim().length > 0) {
          const related = isStringArray(a.relatedConcepts) ? a.relatedConcepts : [];
          assertions.push({ content: a.content.trim(), relatedConcepts: related });
        }
      }
    }

    const definitions: RelatedItem[] = [];
    if (Array.isArray(parsed.definitions)) {
      for (const d of parsed.definitions) {
        if (isRecord(d) && isString(d.content) && d.content.trim().length > 0) {
          const related = isStringArray(d.relatedConcepts) ? d.relatedConcepts : [];
          definitions.push({ content: d.content.trim(), relatedConcepts: related });
        }
      }
    }

    return { concepts, assertions, definitions };
  }

  private mergeExtractions(results: ConceptExtraction[]): ConceptExtraction {
    const conceptMap = new Map<string, ConceptItem>();
    for (const r of results) {
      for (const c of r.concepts) {
        const key = c.content.toLowerCase();
        const existing = conceptMap.get(key);
        if (!existing || c.importance > existing.importance) {
          conceptMap.set(key, c);
        }
      }
    }

    const assertionMap = new Map<string, RelatedItem>();
    for (const r of results) {
      for (const a of r.assertions) {
        const key = a.content.toLowerCase();
        if (!assertionMap.has(key)) assertionMap.set(key, a);
      }
    }

    const definitionMap = new Map<string, RelatedItem>();
    for (const r of results) {
      for (const d of r.definitions) {
        const key = d.content.toLowerCase();
        if (!definitionMap.has(key)) definitionMap.set(key, d);
      }
    }

    return {
      concepts: Array.from(conceptMap.values()),
      assertions: Array.from(assertionMap.values()),
      definitions: Array.from(definitionMap.values()),
    };
  }
}
