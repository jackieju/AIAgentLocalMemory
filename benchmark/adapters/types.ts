export interface AdapterStats {
  nodeCount: number;
  dbSizeBytes: number;
  edgeCount?: number;
}

export interface MemoryAdapter {
  name: string;
  init(storageDir: string): Promise<void>;
  remember(id: string, content: string, meta?: Record<string, unknown>): Promise<void>;
  /** Optional: called once after all facts are ingested, before queries run. */
  finalizeIngest?(): Promise<void>;
  /** Optional: simulate multi-turn usage to build up graph connections. */
  warmup?(queries: string[]): Promise<void>;
  recall(query: string, k: number): Promise<Array<{ id: string; score: number; content: string }>>;
  stats(): Promise<AdapterStats>;
  close(): Promise<void>;
}
