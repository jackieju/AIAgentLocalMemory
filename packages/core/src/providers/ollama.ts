import { OpenAICompatibleEmbedding, OpenAICompatibleLLM } from "./openai-compatible.ts";

export interface OllamaLLMOptions {
  model?: string;
  embeddingModel?: string;
  port?: number;
  host?: string;
  baseUrl?: string;
}

export interface OllamaEmbeddingOptions {
  model?: string;
  port?: number;
  host?: string;
  baseUrl?: string;
}

export class OllamaLLM extends OpenAICompatibleLLM {
  constructor(options?: OllamaLLMOptions) {
    const base = options?.baseUrl
      ? (options.baseUrl.endsWith("/v1") ? options.baseUrl : `${options.baseUrl}/v1`)
      : `http://${options?.host ?? "localhost"}:${options?.port ?? 11434}/v1`;
    super({
      baseUrl: base,
      model: options?.model ?? "llama3.2",
      embeddingModel: options?.embeddingModel ?? "nomic-embed-text",
    });
  }
}

export class OllamaEmbedding extends OpenAICompatibleEmbedding {
  constructor(options?: OllamaEmbeddingOptions) {
    const base = options?.baseUrl
      ? (options.baseUrl.endsWith("/v1") ? options.baseUrl : `${options.baseUrl}/v1`)
      : `http://${options?.host ?? "localhost"}:${options?.port ?? 11434}/v1`;
    super({
      baseUrl: base,
      embeddingModel: options?.model ?? "nomic-embed-text",
    });
  }
}
