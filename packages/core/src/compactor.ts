import type { StorageProvider, LLMProvider, MemoryNode, EpisodicData, FidelityPayloads } from "./interfaces.ts";

export class Compactor {
  constructor(
    private storage: StorageProvider,
    private llm: LLMProvider,
  ) {}

  async findColdNodes(coldThresholdMs: number = 3600000): Promise<MemoryNode[]> {
    const now = Date.now();
    const episodes = await this.storage.queryNodes({ type: "episode" });
    return episodes.filter(node => {
      const ep = node.metadata?.episodicData as EpisodicData | undefined;
      if (!ep?.fidelity?.f0) return false;
      if (ep.fidelity.f1) return false;
      return (now - node.lastAccessed) > coldThresholdMs;
    });
  }

  async generateSummaries(node: MemoryNode): Promise<void> {
    const ep = node.metadata?.episodicData as EpisodicData | undefined;
    if (!ep?.fidelity?.f0) return;

    const f0 = ep.fidelity.f0;

    const prompt = `Summarize this conversation message at three levels of detail.

MESSAGE:
${f0}

Respond in exactly this JSON format:
{"f1": "paragraph summary (2-3 sentences, max 200 tokens)", "f2": "one sentence gist (max 30 tokens)", "f3": "title/label (max 8 tokens)"}`;

    const response = await this.llm.complete(prompt, { maxTokens: 300 });

    try {
      const parsed = JSON.parse(response) as { f1: string; f2: string; f3: string };
      const updatedFidelity: FidelityPayloads = {
        ...ep.fidelity,
        f1: parsed.f1,
        f2: parsed.f2,
        f3: parsed.f3,
      };
      await this.storage.updateNode(node.id, {
        metadata: {
          ...node.metadata,
          episodicData: { ...ep, fidelity: updatedFidelity },
        },
      });
    } catch {
      const updatedFidelity: FidelityPayloads = {
        ...ep.fidelity,
        f1: f0.slice(0, 800) + (f0.length > 800 ? "..." : ""),
        f2: f0.slice(0, 120) + (f0.length > 120 ? "..." : ""),
        f3: `[${ep.role}] ${f0.slice(0, 40)}${f0.length > 40 ? "..." : ""}`,
      };
      await this.storage.updateNode(node.id, {
        metadata: {
          ...node.metadata,
          episodicData: { ...ep, fidelity: updatedFidelity },
        },
      });
    }
  }

  async run(options?: { coldThresholdMs?: number; batchSize?: number }): Promise<{ processed: number }> {
    const coldMs = options?.coldThresholdMs ?? 3600000;
    const batch = options?.batchSize ?? 20;
    const cold = await this.findColdNodes(coldMs);
    const toProcess = cold.slice(0, batch);

    for (const node of toProcess) {
      await this.generateSummaries(node);
    }

    return { processed: toProcess.length };
  }
}
