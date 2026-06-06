import type {
  MemoryNode,
  NodeType,
  StorageProvider,
  Synapse,
} from "./interfaces.ts";

export interface ExtractedEntity {
  content: string;
  type: NodeType;
  importance: number;
}

export interface LightweightProcessResult {
  nodes: MemoryNode[];
  edges: Synapse[];
}

const EPISODE_IMPORTANCE = 0.5;
const FILE_PATH_IMPORTANCE = 0.6;
const PACKAGE_IMPORTANCE = 0.7;
const CODE_IDENT_IMPORTANCE = 0.5;
const URL_IMPORTANCE = 0.4;
const TECH_TERM_IMPORTANCE = 0.6;

const MIN_LEXICAL_OVERLAP = 0.2;
const MAX_LEXICAL_OVERLAP = 0.55;
const ENTITY_EDGE_WEIGHT = 0.7;
const TEMPORAL_EDGE_WEIGHT = 0.3;
const MAX_EPISODE_CHARS = 10_000;
const FTS_CANDIDATE_LIMIT = 30;

const URL_RE = /https?:\/\/[^\s<>"']+/g;
const FILE_PATH_RE = /(?:[\w.@/\\-]+[/\\])?[\w.@-]+\.[a-zA-Z]{1,5}\b/g;
const SCOPED_PACKAGE_RE = /@[a-z0-9][\w-]*\/[a-z0-9][\w.-]*/gi;
const CAMEL_CASE_RE = /\b[a-z]+(?:[A-Z][a-z]*)+\b/g;
const PASCAL_CASE_RE = /\b[A-Z][a-z]+(?:[A-Z][a-z]*)+\b/g;
const SNAKE_CASE_RE = /\b[a-z]+(?:_[a-z0-9]+)+\b/g;
const ALLCAPS_RE = /\b[A-Z]{2,6}\b/g;

const TECH_KEYWORDS = new Set([
  "API",
  "SQL",
  "HTTP",
  "HTTPS",
  "REST",
  "JSON",
  "XML",
  "YAML",
  "HTML",
  "CSS",
  "TCP",
  "UDP",
  "DNS",
  "URL",
  "URI",
  "JWT",
  "OAuth",
  "SDK",
  "CLI",
  "CRUD",
  "ORM",
  "FTS",
  "UUID",
  "RPC",
  "gRPC",
  "GraphQL",
  "WebSocket",
  "SSL",
  "TLS",
]);

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "should",
  "could", "may", "might", "must", "shall", "can", "of", "to", "in",
  "on", "at", "by", "for", "with", "about", "from", "as", "and", "or",
  "but", "not", "no", "so", "if", "then", "this", "that", "these",
  "those", "it", "its", "you", "we", "they",
]);

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

function splitSentences(text: string): string[] {
  return text
    .split(/[.?!\n]+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export class LightweightLinker {
  constructor(
    private readonly storage: StorageProvider,
    private readonly maxEdgesPerNode: number = 8,
  ) {}

  extractEntities(text: string): ExtractedEntity[] {
    const found = new Map<string, ExtractedEntity>();

    const add = (raw: string, type: NodeType, importance: number): void => {
      const content = raw.trim();
      if (content.length === 0) return;
      const key = content.toLowerCase();
      const existing = found.get(key);
      if (!existing || importance > existing.importance) {
        found.set(key, { content, type, importance });
      }
    };

    for (const m of text.matchAll(URL_RE)) {
      add(m[0], "concept", URL_IMPORTANCE);
    }

    for (const m of text.matchAll(SCOPED_PACKAGE_RE)) {
      add(m[0], "concept", PACKAGE_IMPORTANCE);
    }

    for (const m of text.matchAll(FILE_PATH_RE)) {
      const value = m[0];
      if (found.has(value.toLowerCase())) continue;
      add(value, "concept", FILE_PATH_IMPORTANCE);
    }

    for (const m of text.matchAll(CAMEL_CASE_RE)) {
      add(m[0], "concept", CODE_IDENT_IMPORTANCE);
    }

    for (const m of text.matchAll(PASCAL_CASE_RE)) {
      add(m[0], "concept", CODE_IDENT_IMPORTANCE);
    }

    for (const m of text.matchAll(SNAKE_CASE_RE)) {
      add(m[0], "concept", CODE_IDENT_IMPORTANCE);
    }

    for (const m of text.matchAll(ALLCAPS_RE)) {
      const value = m[0];
      if (TECH_KEYWORDS.has(value)) {
        add(value, "concept", TECH_TERM_IMPORTANCE);
      }
    }

    for (const keyword of TECH_KEYWORDS) {
      const re = new RegExp(`\\b${keyword}\\b`, "g");
      if (re.test(text)) {
        add(keyword, "concept", TECH_TERM_IMPORTANCE);
      }
    }

    return [...found.values()];
  }

  async linkToExisting(node: MemoryNode): Promise<Synapse[]> {
    const created: Synapse[] = [];
    const now = Date.now();

    const nodeTokens = tokenize(node.content);
    const nodeEntityKeys = new Set(
      this.extractEntities(node.content).map((e) => e.content.toLowerCase()),
    );

    const candidates = await this.storage.search(
      node.content,
      FTS_CANDIDATE_LIMIT,
    );

    const existingEdges = await this.storage.getEdges(node.id, "both");
    const existingPeers = new Set<string>();
    for (const e of existingEdges) {
      existingPeers.add(e.src === node.id ? e.dst : e.src);
    }
    let edgeCount = existingEdges.length;

    for (const candidate of candidates) {
      if (candidate.id === node.id) continue;

      const proposed: Synapse[] = [];

      if (
        candidate.sourceSession &&
        node.sourceSession &&
        candidate.sourceSession === node.sourceSession
      ) {
        proposed.push({
          src: node.id,
          dst: candidate.id,
          type: "temporal",
          weight: TEMPORAL_EDGE_WEIGHT,
          lastCoactivated: now,
          coactivationCount: 1,
        });
      }

      const candidateEntities = this.extractEntities(candidate.content);
      const sharesEntity = candidateEntities.some((e) =>
        nodeEntityKeys.has(e.content.toLowerCase()),
      );
      if (sharesEntity) {
        proposed.push({
          src: node.id,
          dst: candidate.id,
          type: "entity",
          weight: ENTITY_EDGE_WEIGHT,
          lastCoactivated: now,
          coactivationCount: 1,
        });
      }

      if (nodeTokens.size > 0) {
        const candidateTokens = tokenize(candidate.content);
        const overlap = jaccard(nodeTokens, candidateTokens);
        if (overlap >= MIN_LEXICAL_OVERLAP && overlap <= MAX_LEXICAL_OVERLAP) {
          proposed.push({
            src: node.id,
            dst: candidate.id,
            type: "lexical",
            weight: overlap,
            lastCoactivated: now,
            coactivationCount: 1,
          });
        }
      }

      for (const edge of proposed) {
        if (edgeCount >= this.maxEdgesPerNode) break;
        await this.storage.putEdge(edge);
        created.push(edge);
        edgeCount++;
      }

      if (edgeCount >= this.maxEdgesPerNode) break;
      existingPeers.add(candidate.id);
    }

    return created;
  }

  async processText(
    text: string,
    sessionId: string,
  ): Promise<LightweightProcessResult> {
    const now = Date.now();
    const sentences = splitSentences(text);

    const merged = new Map<string, ExtractedEntity>();
    for (const sentence of sentences) {
      for (const entity of this.extractEntities(sentence)) {
        const key = entity.content.toLowerCase();
        const existing = merged.get(key);
        if (!existing || entity.importance > existing.importance) {
          merged.set(key, entity);
        }
      }
    }

    const nodes: MemoryNode[] = [];

    const episode: MemoryNode = {
      id: crypto.randomUUID(),
      type: "episode",
      content: text.slice(0, MAX_EPISODE_CHARS),
      importance: EPISODE_IMPORTANCE,
      strength: EPISODE_IMPORTANCE,
      accessCount: 0,
      lastAccessed: now,
      createdAt: now,
      sourceSession: sessionId,
    };
    nodes.push(episode);

    const entityNodes: MemoryNode[] = [];
    for (const entity of merged.values()) {
      const node: MemoryNode = {
        id: crypto.randomUUID(),
        type: entity.type,
        content: entity.content,
        importance: entity.importance,
        strength: entity.importance,
        accessCount: 0,
        lastAccessed: now,
        createdAt: now,
        sourceSession: sessionId,
      };
      nodes.push(node);
      entityNodes.push(node);
    }

    const edges: Synapse[] = [];

    for (const node of entityNodes) {
      edges.push({
        src: episode.id,
        dst: node.id,
        type: "temporal",
        weight: TEMPORAL_EDGE_WEIGHT,
        lastCoactivated: now,
        coactivationCount: 1,
      });
    }

    for (let i = 0; i < entityNodes.length; i++) {
      for (let j = i + 1; j < entityNodes.length; j++) {
        edges.push({
          src: entityNodes[i].id,
          dst: entityNodes[j].id,
          type: "entity",
          weight: ENTITY_EDGE_WEIGHT,
          lastCoactivated: now,
          coactivationCount: 1,
        });
      }
    }

    const tokenCache = new Map<string, Set<string>>();
    for (const n of entityNodes) tokenCache.set(n.id, tokenize(n.content));

    for (let i = 0; i < entityNodes.length; i++) {
      for (let j = i + 1; j < entityNodes.length; j++) {
        const a = entityNodes[i];
        const b = entityNodes[j];
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

  private extractKeywords(text: string, topN: number = 10): string[] {
    const counts = new Map<string, number>();
    const tokens = text
      .toLowerCase()
      .split(/[\s\p{P}]+/u)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));

    for (const token of tokens) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }

    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([word]) => word);
  }
}
