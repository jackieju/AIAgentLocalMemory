import type { ConceptExtraction, EmbeddingProvider, LLMProvider } from "../interfaces.ts";

export interface OpenAIProviderConfig {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  embeddingModel?: string;
  maxTokens?: number;
}

interface ResolvedLLMConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  embeddingModel: string;
  maxTokens: number;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
}

export class OpenAICompatibleLLM implements LLMProvider {
  private readonly config: ResolvedLLMConfig;

  constructor(config: OpenAIProviderConfig) {
    this.config = {
      baseUrl: config.baseUrl.replace(/\/$/, ""),
      apiKey: config.apiKey,
      model: config.model ?? "gpt-4o-mini",
      embeddingModel: config.embeddingModel ?? "text-embedding-3-small",
      maxTokens: config.maxTokens ?? 1000,
    };
  }

  async complete(
    prompt: string,
    options?: { model?: string; maxTokens?: number },
  ): Promise<string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: options?.model ?? this.config.model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: options?.maxTokens ?? this.config.maxTokens,
          temperature: 0.1,
        }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`LLM request failed: network error: ${message}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`LLM request failed: ${response.status} ${response.statusText} ${body}`.trim());
    }

    const data = (await response.json()) as ChatCompletionResponse;
    return data.choices?.[0]?.message?.content ?? "";
  }

  async extractConcepts(text: string): Promise<ConceptExtraction> {
    const { LLMExtractor } = await import("../llm-extractor.ts");
    const extractor = new LLMExtractor(this);
    return extractor.extract(text);
  }
}

export class OpenAICompatibleEmbedding implements EmbeddingProvider {
  private readonly config: { baseUrl: string; apiKey?: string; model: string };
  readonly dimensions: number;

  constructor(config: OpenAIProviderConfig) {
    const model = config.embeddingModel ?? "text-embedding-3-small";
    this.config = {
      baseUrl: config.baseUrl.replace(/\/$/, ""),
      apiKey: config.apiKey,
      model,
    };
    this.dimensions = model.includes("3-large")
      ? 3072
      : model.includes("3-small")
        ? 1536
        : model.includes("ada")
          ? 1536
          : 768;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/embeddings`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.config.model,
          input: texts,
        }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Embedding request failed: network error: ${message}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Embedding request failed: ${response.status} ${response.statusText} ${body}`.trim(),
      );
    }

    const data = (await response.json()) as EmbeddingResponse;
    if (!Array.isArray(data.data)) {
      throw new Error("Embedding response missing 'data' array");
    }

    return data.data.map((d, i) => {
      if (!Array.isArray(d.embedding)) {
        throw new Error(`Embedding response item ${i} missing 'embedding' array`);
      }
      return d.embedding;
    });
  }
}
