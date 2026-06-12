import { OpenAICompatibleEmbedding, OpenAICompatibleLLM } from "./openai-compatible.ts";

export interface OllamaLLMOptions {
  model?: string;
  embeddingModel?: string;
  port?: number;
  host?: string;
}

export interface OllamaEmbeddingOptions {
  model?: string;
  port?: number;
  host?: string;
}

export class OllamaLLM extends OpenAICompatibleLLM {
  constructor(options?: OllamaLLMOptions) {
    const host = options?.host ?? "localhost";
    const port = options?.port ?? 11434;
    super({
      baseUrl: `http://${host}:${port}/v1`,
      model: options?.model ?? "llama3.2",
      embeddingModel: options?.embeddingModel ?? "nomic-embed-text",
    });
  }
}

export class OllamaEmbedding extends OpenAICompatibleEmbedding {
  constructor(options?: OllamaEmbeddingOptions) {
    const host = options?.host ?? "localhost";
    const port = options?.port ?? 11434;
    super({
      baseUrl: `http://${host}:${port}/v1`,
      embeddingModel: options?.model ?? "nomic-embed-text",
    });
  }
}
