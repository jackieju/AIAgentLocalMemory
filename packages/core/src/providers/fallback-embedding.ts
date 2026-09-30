import type { EmbeddingProvider } from "../interfaces.ts";

// Primary + fallback EmbeddingProvider. embed() tries primary; on throw it serves
// from fallback AND opens a cooldown so subsequent calls skip the (failing) primary
// instead of eating its failure latency each time; after the cooldown the primary is
// retried once, auto-healing when it recovers. Same EmbeddingProvider interface, so
// all call sites (ingest linking, recall, D fusion) stay unchanged.
export class FallbackEmbedding implements EmbeddingProvider {
  readonly dimensions: number;
  private primaryDownUntil = 0;
  private readonly cooldownMs: number;

  constructor(
    private readonly primary: EmbeddingProvider,
    private readonly fallback: EmbeddingProvider,
    opts?: { cooldownMs?: number },
  ) {
    // Both providers MUST share dimensions or downstream cosine math is invalid.
    this.dimensions = primary.dimensions;
    this.cooldownMs = opts?.cooldownMs ?? 60_000;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const now = Date.now();
    if (now < this.primaryDownUntil) {
      return this.fallback.embed(texts);
    }
    try {
      return await this.primary.embed(texts);
    } catch {
      this.primaryDownUntil = now + this.cooldownMs;
      return this.fallback.embed(texts);
    }
  }
}
