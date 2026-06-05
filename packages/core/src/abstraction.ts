import type {
  LLMProvider,
  MemoryNode,
  NodeType,
  SessionData,
  Synapse,
} from "./interfaces.ts";

export interface AbstractionResult {
  nodes: MemoryNode[];
  edges: Synapse[];
}

const IMPORTANCE: Record<NodeType, number> = {
  concept: 0.7,
  assertion: 0.8,
  definition: 0.8,
  episode: 0.5,
  filler: 0.2,
  meta: 0.9,
  fact: 0.9,
};

const MAX_EPISODE_CHARS = 10_000;
const MIN_LEXICAL_OVERLAP = 0.2;
const MAX_LEXICAL_OVERLAP = 0.55;
const TEMPORAL_WEIGHT = 0.3;
const COMPOSITIONAL_WEIGHT = 0.6;

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s\p{P}]+/u)
      .filter((w) => w.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const w of a) if (b.has(w)) intersect++;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

export class SessionAbstractor {
  constructor(private readonly llm: LLMProvider) {}

  async abstract(session: SessionData): Promise<AbstractionResult> {
    const text = session.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");

    const extraction = await this.llm.extractConcepts(text);

    const now = Date.now();
    const nodes: MemoryNode[] = [];
    const conceptByContent = new Map<string, MemoryNode>();

    const episode: MemoryNode = {
      id: crypto.randomUUID(),
      type: "episode",
      content: text.slice(0, MAX_EPISODE_CHARS),
      importance: IMPORTANCE.episode,
      strength: IMPORTANCE.episode,
      accessCount: 0,
      lastAccessed: now,
      createdAt: now,
      sourceSession: session.id,
    };
    nodes.push(episode);

    for (const c of extraction.concepts) {
      const importance = c.importance ?? IMPORTANCE.concept;
      const node: MemoryNode = {
        id: crypto.randomUUID(),
        type: "concept",
        content: c.content,
        importance,
        strength: importance,
        accessCount: 0,
        lastAccessed: now,
        createdAt: now,
        sourceSession: session.id,
      };
      nodes.push(node);
      conceptByContent.set(c.content.toLowerCase(), node);
    }

    const composite: { node: MemoryNode; related: string[] }[] = [];

    for (const a of extraction.assertions) {
      const node: MemoryNode = {
        id: crypto.randomUUID(),
        type: "assertion",
        content: a.content,
        importance: IMPORTANCE.assertion,
        strength: IMPORTANCE.assertion,
        accessCount: 0,
        lastAccessed: now,
        createdAt: now,
        sourceSession: session.id,
      };
      nodes.push(node);
      composite.push({ node, related: a.relatedConcepts });
    }

    for (const d of extraction.definitions) {
      const node: MemoryNode = {
        id: crypto.randomUUID(),
        type: "definition",
        content: d.content,
        importance: IMPORTANCE.definition,
        strength: IMPORTANCE.definition,
        accessCount: 0,
        lastAccessed: now,
        createdAt: now,
        sourceSession: session.id,
      };
      nodes.push(node);
      composite.push({ node, related: d.relatedConcepts });
    }

    console.debug(
      `[abstraction] session=${session.id} extracted concepts=${extraction.concepts.length} assertions=${extraction.assertions.length} definitions=${extraction.definitions.length}`,
    );

    const edges: Synapse[] = [];

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        edges.push({
          src: nodes[i].id,
          dst: nodes[j].id,
          type: "temporal",
          weight: TEMPORAL_WEIGHT,
          lastCoactivated: now,
          coactivationCount: 1,
        });
      }
    }

    for (const { node, related } of composite) {
      for (const rel of related) {
        const concept = conceptByContent.get(rel.toLowerCase());
        if (!concept) continue;
        edges.push({
          src: concept.id,
          dst: node.id,
          type: "compositional",
          weight: COMPOSITIONAL_WEIGHT,
          lastCoactivated: now,
          coactivationCount: 1,
        });
      }
    }

    const tokenCache = new Map<string, Set<string>>();
    for (const n of nodes) tokenCache.set(n.id, tokenize(n.content));

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        if (a.type === "episode" || b.type === "episode") continue;
        const at = tokenCache.get(a.id);
        const bt = tokenCache.get(b.id);
        if (!at || !bt) continue;
        const overlap = jaccard(at, bt);
        if (overlap >= MIN_LEXICAL_OVERLAP && overlap <= MAX_LEXICAL_OVERLAP) {
          edges.push({
            src: a.id,
            dst: b.id,
            type: "lexical",
            weight: overlap,
            lastCoactivated: now,
            coactivationCount: 1,
          });
        }
      }
    }

    return { nodes, edges };
  }
}
