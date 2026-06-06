import type { MemoryNode, StorageProvider, Synapse } from "./interfaces.ts";

const MIN_LEXICAL_OVERLAP = 0.2;
const MAX_LEXICAL_OVERLAP = 0.55;
const ENTITY_EDGE_WEIGHT = 0.7;
const MIN_SHARED_ENTITIES = 2;
const MS_PER_HOUR = 3_600_000;

const LINKABLE_TYPES = new Set([
  "concept",
  "assertion",
  "definition",
  "fact",
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

function intersection(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const w of a) if (b.has(w)) out.add(w);
  return out;
}

export interface CrossSessionLinkerRunOptions {
  sinceHoursAgo?: number;
  minEdges?: number;
}

export class CrossSessionLinker {
  constructor(
    private readonly storage: StorageProvider,
    private readonly maxEdgesPerNode: number = 8,
  ) {}

  async linkNewNode(node: MemoryNode): Promise<Synapse[]> {
    if (!LINKABLE_TYPES.has(node.type)) return [];

    const nodeTokens = tokenize(node.content);
    if (nodeTokens.size === 0) return [];

    const candidates = await this.storage.search(node.content, 30);
    const now = Date.now();
    const created: Synapse[] = [];

    const existingEdges = await this.storage.getEdges(node.id, "both");
    const existingByPeer = new Map<string, Synapse[]>();
    for (const e of existingEdges) {
      const peer = e.src === node.id ? e.dst : e.src;
      const list = existingByPeer.get(peer) ?? [];
      list.push(e);
      existingByPeer.set(peer, list);
    }
    let edgeCount = existingEdges.length;

    for (const candidate of candidates) {
      if (candidate.id === node.id) continue;
      if (!candidate.sourceSession) continue;
      if (candidate.sourceSession === node.sourceSession) continue;
      if (!LINKABLE_TYPES.has(candidate.type)) continue;

      const candidateTokens = tokenize(candidate.content);
      if (candidateTokens.size === 0) continue;

      const overlap = jaccard(nodeTokens, candidateTokens);
      const shared = intersection(nodeTokens, candidateTokens);

      const proposed: Synapse[] = [];

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

      if (shared.size >= MIN_SHARED_ENTITIES) {
        proposed.push({
          src: node.id,
          dst: candidate.id,
          type: "entity",
          weight: ENTITY_EDGE_WEIGHT,
          lastCoactivated: now,
          coactivationCount: 1,
        });
      }

      const peerExisting = existingByPeer.get(candidate.id) ?? [];

      for (const edge of proposed) {
        const duplicate = peerExisting.find(
          (e) =>
            e.type === edge.type &&
            ((e.src === edge.src && e.dst === edge.dst) ||
              (e.src === edge.dst && e.dst === edge.src)),
        );
        if (duplicate) continue;

        if (edgeCount >= this.maxEdgesPerNode) {
          const allEdges = [...existingEdges, ...created];
          if (allEdges.length === 0) break;
          const weakest = allEdges.reduce((a, b) =>
            a.weight <= b.weight ? a : b,
          );
          if (weakest.weight >= edge.weight) continue;
          await this.storage.deleteEdge(weakest.src, weakest.dst, weakest.type);
          const idxAll = existingEdges.indexOf(weakest);
          if (idxAll >= 0) existingEdges.splice(idxAll, 1);
          const idxCreated = created.indexOf(weakest);
          if (idxCreated >= 0) created.splice(idxCreated, 1);
          edgeCount--;
        }

        await this.storage.putEdge(edge);
        created.push(edge);
        peerExisting.push(edge);
        existingByPeer.set(candidate.id, peerExisting);
        edgeCount++;
      }
    }

    return created;
  }

  async run(
    options: CrossSessionLinkerRunOptions = {},
  ): Promise<{ edgesCreated: number }> {
    const sinceHoursAgo = options.sinceHoursAgo ?? 24;
    const minEdges = options.minEdges ?? 2;
    const maxAge = sinceHoursAgo * MS_PER_HOUR;

    const recent = await this.storage.queryNodes({ maxAge });
    let total = 0;

    for (const node of recent) {
      if (!LINKABLE_TYPES.has(node.type)) continue;

      const edges = await this.storage.getEdges(node.id, "both");
      const crossSessionCount = await this.countCrossSessionEdges(node, edges);
      if (crossSessionCount >= minEdges) continue;

      const created = await this.linkNewNode(node);
      total += created.length;
    }

    return { edgesCreated: total };
  }

  private async countCrossSessionEdges(
    node: MemoryNode,
    edges: Synapse[],
  ): Promise<number> {
    if (edges.length === 0) return 0;
    const peerIds = new Set<string>();
    for (const e of edges) {
      const peer = e.src === node.id ? e.dst : e.src;
      peerIds.add(peer);
    }
    const peers = await this.storage.getNodesByIds([...peerIds]);
    const peerById = new Map(peers.map((p) => [p.id, p]));

    let count = 0;
    for (const e of edges) {
      const peerId = e.src === node.id ? e.dst : e.src;
      const peer = peerById.get(peerId);
      if (!peer) continue;
      if (peer.sourceSession && peer.sourceSession !== node.sourceSession) {
        count++;
      }
    }
    return count;
  }
}
