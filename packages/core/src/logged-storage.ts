import type {
  MemoryNode,
  NodeFilter,
  StorageProvider,
  Synapse,
  SynapseType,
} from "./interfaces.ts";
import type { OperationLog } from "./operation-log.ts";

export class LoggedStorageProvider implements StorageProvider {
  constructor(
    private readonly inner: StorageProvider,
    private readonly log: OperationLog,
  ) {}

  open(projectId: string): Promise<void> {
    return this.inner.open(projectId);
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  getNode(id: string): Promise<MemoryNode | null> {
    return this.inner.getNode(id);
  }

  async putNode(node: MemoryNode): Promise<void> {
    await this.inner.putNode(node);
    this.log.append({
      ts: Date.now(),
      machine: this.log.machineId,
      op: "add_node",
      data: node,
    });
  }

  async updateNode(
    id: string,
    updates: Partial<Omit<MemoryNode, "id">>,
  ): Promise<void> {
    await this.inner.updateNode(id, updates);
    this.log.append({
      ts: Date.now(),
      machine: this.log.machineId,
      op: "update_node",
      data: { id, updates: updates as Partial<MemoryNode> },
    });
  }

  async deleteNode(id: string): Promise<void> {
    await this.inner.deleteNode(id);
    this.log.append({
      ts: Date.now(),
      machine: this.log.machineId,
      op: "delete_node",
      data: { id },
    });
  }

  getNodesByIds(ids: string[]): Promise<MemoryNode[]> {
    return this.inner.getNodesByIds(ids);
  }

  queryNodes(filter: NodeFilter): Promise<MemoryNode[]> {
    return this.inner.queryNodes(filter);
  }

  getEdges(
    nodeId: string,
    direction?: "in" | "out" | "both",
  ): Promise<Synapse[]> {
    return this.inner.getEdges(nodeId, direction);
  }

  async putEdge(edge: Synapse): Promise<void> {
    await this.inner.putEdge(edge);
    this.log.append({
      ts: Date.now(),
      machine: this.log.machineId,
      op: "add_edge",
      data: edge,
    });
  }

  async updateEdge(
    src: string,
    dst: string,
    type: SynapseType,
    updates: Partial<Omit<Synapse, "src" | "dst" | "type">>,
  ): Promise<void> {
    await this.inner.updateEdge(src, dst, type, updates);
    this.log.append({
      ts: Date.now(),
      machine: this.log.machineId,
      op: "update_edge",
      data: { src, dst, type, updates: updates as Partial<Synapse> },
    });
  }

  async deleteEdge(
    src: string,
    dst: string,
    type: SynapseType,
  ): Promise<void> {
    await this.inner.deleteEdge(src, dst, type);
    this.log.append({
      ts: Date.now(),
      machine: this.log.machineId,
      op: "delete_edge",
      data: { src, dst, type },
    });
  }

  getEdgesBatch(
    nodeIds: string[],
    direction?: "in" | "out" | "both",
  ): Promise<Synapse[]> {
    return this.inner.getEdgesBatch(nodeIds, direction);
  }

  search(query: string, limit?: number): Promise<MemoryNode[]> {
    return this.inner.search(query, limit);
  }

  searchWithScores(
    query: string,
    limit?: number,
  ): Promise<Array<{ node: MemoryNode; score: number }>> {
    if (!this.inner.searchWithScores) {
      return Promise.resolve([]);
    }
    return this.inner.searchWithScores(query, limit);
  }

  getAllNodes(): Promise<MemoryNode[]> {
    return this.inner.getAllNodes();
  }

  getAllEdges(): Promise<Synapse[]> {
    return this.inner.getAllEdges();
  }

  getNodeCount(): Promise<number> {
    return this.inner.getNodeCount();
  }
}
