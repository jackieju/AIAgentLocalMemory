import type {
  StorageProvider,
  ContextRenderConfig,
  RenderResult,
  RenderedMessage,
  MemoryNode,
  EpisodicData,
  FactData,
  FidelityLevel,
} from "./interfaces.ts";
import type { ActivationResult, ActivationSeed } from "./graph.ts";
import { NeuralGraph } from "./graph.ts";
import { WorkingMemory } from "./working-memory.ts";

const CHARS_PER_TOKEN = 4;
const F1_FALLBACK_CHARS = 800;
const F2_FALLBACK_CHARS = 120;
const F3_FALLBACK_CHARS = 40;
const RECENT_AVG_SAMPLE = 10;
const TOP_CONCEPTS = 5;
const TOP_ACTIVATION_SCAN = 50;
const ACTIVATION_MAX_HOPS = 3;
const ACTIVATION_HOP_DECAY = 0.5;
const ACTIVATION_THRESHOLD = 0.08;
const WORKING_MEMORY_FLOOR = 0.2;
const WORKING_MEMORY_SAMPLE = 20;
const WORKING_MEMORY_SEED_BOOST = 0.1;
const BINARY_SEARCH_ITERATIONS = 32;
const BINARY_SEARCH_EPSILON = 0.001;
const SUPPRESSED_ACTIVATION = -1;

interface FidelityThresholds {
  full: number;
  para: number;
  gist: number;
  title: number;
}

export class ContextRenderer {
  constructor(
    private readonly graph: NeuralGraph,
    private readonly workingMemory: WorkingMemory,
    private readonly storage: StorageProvider,
    private readonly config: ContextRenderConfig,
  ) {}

  async render(
    sessionId: string,
    currentActivationSeeds: ActivationSeed[],
  ): Promise<RenderResult> {
    const episodes = await this.loadEpisodes(sessionId);
    const budget = this.computeBudget();

    if (episodes.length === 0) {
      const systemInjection = await this.buildSystemInjection(sessionId, []);
      return {
        messages: [],
        systemInjection,
        totalTokens: this.estimateTokens(systemInjection),
        budgetUsed: 0,
        budgetAvailable: budget,
      };
    }

    const seeds = this.augmentSeedsWithWorkingMemory(currentActivationSeeds);
    const activationResults = await this.graph.spreadingActivation(seeds, {
      maxHops: ACTIVATION_MAX_HOPS,
      hopDecay: ACTIVATION_HOP_DECAY,
      threshold: ACTIVATION_THRESHOLD,
    });

    const activationByNode = new Map<string, number>();
    for (const r of activationResults) activationByNode.set(r.nodeId, r.score);

    const recentFullText =
      this.config.recentFullTextTurns ?? this.calcRecentFullText(episodes);
    const lastIdx = episodes.length - 1;
    const forcedFullStart = Math.max(0, episodes.length - recentFullText);

    const effectiveActivation = new Map<string, number>();
    for (let i = 0; i < episodes.length; i++) {
      const ep = episodes[i];
      const data = this.getEpisodicData(ep);
      const baseAct = activationByNode.get(ep.id) ?? 0;
      const recencyBonus = i / Math.max(1, episodes.length);
      const wmFloor = this.workingMemory.contains(ep.id) ? WORKING_MEMORY_FLOOR : 0;
      let act = Math.max(baseAct, recencyBonus, wmFloor);

      if (data?.suppressed && i !== lastIdx) {
        act = SUPPRESSED_ACTIVATION;
      }
      if (data?.pinned || i >= forcedFullStart || i === lastIdx) {
        act = Number.POSITIVE_INFINITY;
      }
      effectiveActivation.set(ep.id, act);
    }

    const thresholds = this.binarySearchThresholds(
      episodes,
      effectiveActivation,
      budget,
    );

    const messages: RenderedMessage[] = [];
    let total = 0;
    for (const ep of episodes) {
      const data = this.getEpisodicData(ep);
      if (!data) continue;
      const act = effectiveActivation.get(ep.id) ?? 0;
      const fidelity = this.pickFidelity(act, thresholds);
      const content = this.renderContent(data, fidelity);
      messages.push({
        tag: data.tag,
        role: data.role,
        content,
        fidelityLevel: fidelity,
      });
      total += this.estimateTokens(content);
    }

    const systemInjection = await this.buildSystemInjection(
      sessionId,
      activationResults,
    );

    return {
      messages,
      systemInjection,
      totalTokens: total + this.estimateTokens(systemInjection),
      budgetUsed: total,
      budgetAvailable: budget,
    };
  }

  private async loadEpisodes(sessionId: string): Promise<MemoryNode[]> {
    const nodes = await this.storage.queryNodes({
      type: "episode",
      sourceSession: sessionId,
    });
    return nodes.sort((a, b) => this.getTurnIndex(a) - this.getTurnIndex(b));
  }

  private getTurnIndex(node: MemoryNode): number {
    const data = this.getEpisodicData(node);
    if (data?.turnIndex !== undefined) return data.turnIndex;
    const meta = node.metadata?.turnIndex;
    if (typeof meta === "number") return meta;
    return node.createdAt;
  }

  private getEpisodicData(node: MemoryNode): EpisodicData | undefined {
    return node.metadata?.episodicData as EpisodicData | undefined;
  }

  private getFactData(node: MemoryNode): FactData | undefined {
    return node.metadata?.factData as FactData | undefined;
  }

  private augmentSeedsWithWorkingMemory(
    seeds: ActivationSeed[],
  ): ActivationSeed[] {
    const seen = new Set(seeds.map((s) => s.nodeId));
    const result = [...seeds];
    for (const id of this.workingMemory.getTop(WORKING_MEMORY_SAMPLE)) {
      if (seen.has(id)) continue;
      result.push({ nodeId: id, baseScore: WORKING_MEMORY_SEED_BOOST });
      seen.add(id);
    }
    return result;
  }

  private calcRecentFullText(episodes: MemoryNode[]): number {
    const sample = episodes.slice(-RECENT_AVG_SAMPLE);
    let totalChars = 0;
    let count = 0;
    for (const ep of sample) {
      const d = this.getEpisodicData(ep);
      if (!d) continue;
      totalChars += d.fidelity.f0.length;
      count++;
    }
    if (count === 0) return 5;
    const avgTokens = totalChars / count / CHARS_PER_TOKEN;
    if (avgTokens < 200) return 5;
    if (avgTokens < 500) return 4;
    return 3;
  }

  private computeBudget(): number {
    const ratio = this.config.budgetRatio ?? 0.6;
    const sysTokens = this.config.systemPromptTokens ?? 2000;
    const reserve = this.config.reserveTokens ?? 4000;
    return Math.max(
      0,
      this.config.contextWindowTokens * ratio - sysTokens - reserve,
    );
  }

  // Char/4 approximation: average English token ≈ 4 chars.
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  // Binary search for the smallest scale s such that the simulated rendered
  // token count fits within the budget. Thresholds are derived from s with
  // fixed ratios (full=s, para=s/2, gist=s/4, title=s/10). As s increases,
  // fewer nodes meet each threshold and total tokens decrease monotonically;
  // we want the smallest s that still fits so we maximize budget utilization.
  private binarySearchThresholds(
    episodes: MemoryNode[],
    effectiveActivation: Map<string, number>,
    budget: number,
  ): FidelityThresholds {
    const finiteActs = [...effectiveActivation.values()].filter(
      (v) => Number.isFinite(v) && v >= 0,
    );
    const maxAct = finiteActs.length > 0 ? Math.max(...finiteActs) : 1;

    let lo = 0;
    let hi = Math.max(maxAct, 1);
    for (let iter = 0; iter < BINARY_SEARCH_ITERATIONS; iter++) {
      const mid = (lo + hi) / 2;
      const t = this.scaleToThresholds(mid);
      const tokens = this.simulateTokens(episodes, effectiveActivation, t);
      if (tokens > budget) lo = mid;
      else hi = mid;
      if (hi - lo < BINARY_SEARCH_EPSILON) break;
    }
    return this.scaleToThresholds(hi);
  }

  private scaleToThresholds(scale: number): FidelityThresholds {
    return {
      full: scale,
      para: scale * 0.5,
      gist: scale * 0.25,
      title: scale * 0.1,
    };
  }

  private simulateTokens(
    episodes: MemoryNode[],
    effectiveActivation: Map<string, number>,
    thresholds: FidelityThresholds,
  ): number {
    let total = 0;
    for (const ep of episodes) {
      const data = this.getEpisodicData(ep);
      if (!data) continue;
      const act = effectiveActivation.get(ep.id) ?? 0;
      const fid = this.pickFidelity(act, thresholds);
      const content = this.renderContent(data, fid);
      total += this.estimateTokens(content);
    }
    return total;
  }

  private pickFidelity(
    activation: number,
    t: FidelityThresholds,
  ): FidelityLevel {
    if (activation >= t.full) return "f0";
    if (activation >= t.para) return "f1";
    if (activation >= t.gist) return "f2";
    if (activation >= t.title) return "f3";
    return "f4";
  }

  private renderContent(data: EpisodicData, fidelity: FidelityLevel): string {
    const tag = `§${data.tag}§`;
    const f = data.fidelity;

    switch (fidelity) {
      case "f0":
        return `${tag} ${f.f0}`;
      case "f1": {
        if (f.f1) return `${tag} ${f.f1}`;
        const truncated = f.f0.slice(0, F1_FALLBACK_CHARS);
        const suffix = f.f0.length > F1_FALLBACK_CHARS ? "..." : "";
        return `${tag} ${truncated}${suffix}`;
      }
      case "f2": {
        if (f.f2) return `${tag} ${f.f2}`;
        const truncated = f.f0.slice(0, F2_FALLBACK_CHARS);
        const suffix = f.f0.length > F2_FALLBACK_CHARS ? "..." : "";
        return `${tag} ${truncated}${suffix}`;
      }
      case "f3": {
        if (f.f3) return `${tag} ${f.f3}`;
        const head = f.f0.slice(0, F3_FALLBACK_CHARS);
        return `${tag} [${data.role}] ${head}...`;
      }
      case "f4":
        return `${tag} [elided]`;
    }
  }

  private async buildSystemInjection(
    sessionId: string,
    activationResults: ActivationResult[],
  ): Promise<string> {
    const factNodes = await this.storage.queryNodes({ type: "fact" });
    const facts: string[] = [];
    for (const node of factNodes) {
      const fd = this.getFactData(node);
      if (!fd) continue;
      if (fd.ready === false) continue;
      if (fd.scope === "session" && node.sourceSession !== sessionId) continue;
      facts.push(node.content);
    }

    const top = activationResults.slice(0, TOP_ACTIVATION_SCAN);
    const ids = top.map((r) => r.nodeId);
    const nodes = ids.length > 0 ? await this.storage.getNodesByIds(ids) : [];
    const byId = new Map(nodes.map((n) => [n.id, n]));

    const concepts: Array<{ type: string; content: string }> = [];
    for (const r of top) {
      const node = byId.get(r.nodeId);
      if (!node) continue;
      if (node.type !== "concept" && node.type !== "assertion") continue;
      concepts.push({ type: node.type, content: node.content });
      if (concepts.length >= TOP_CONCEPTS) break;
    }

    const lines: string[] = ["<neural-memory>"];
    if (facts.length > 0) {
      lines.push("## Session Facts");
      for (const f of facts) lines.push(`- ${f}`);
      lines.push("");
    }
    if (concepts.length > 0) {
      lines.push("## Relevant Context");
      for (const c of concepts) lines.push(`- [${c.type}] ${c.content}`);
      lines.push("");
    }
    lines.push("</neural-memory>");
    lines.push("");
    lines.push(
      'Use `neural_reduce` to drop content you no longer need (e.g. neural_reduce(drop="3-5")).',
    );
    lines.push("Use `neural_pin` to keep important content at full fidelity.");
    lines.push("Use `neural_recall` to search memories by association.");
    lines.push(
      "Use `neural_note` to save durable facts that survive compression.",
    );
    return lines.join("\n");
  }
}
