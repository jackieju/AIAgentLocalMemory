interface WorkingMemoryEntry {
  nodeId: string;
  frequency: number;
  lastAccessed: number;
}

interface SerializedWorkingMemory {
  maxSize: number;
  entries: WorkingMemoryEntry[];
}

const MS_PER_HOUR = 3_600_000;
const RECENCY_LAMBDA = 0.01;

export class WorkingMemory {
  private readonly entries: Map<string, WorkingMemoryEntry>;
  private readonly maxSize: number;

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
    this.entries = new Map();
  }

  private score(entry: WorkingMemoryEntry, now: number): number {
    // Score = frequency × exp(-0.01 × hoursSinceAccess)
    const hours = (now - entry.lastAccessed) / MS_PER_HOUR;
    return entry.frequency * Math.exp(-RECENCY_LAMBDA * hours);
  }

  access(nodeId: string): void {
    const now = Date.now();
    const existing = this.entries.get(nodeId);
    if (existing) {
      existing.frequency += 1;
      existing.lastAccessed = now;
      return;
    }

    if (this.entries.size >= this.maxSize) {
      let lowestId: string | null = null;
      let lowestScore = Infinity;
      for (const [id, entry] of this.entries) {
        const s = this.score(entry, now);
        if (s < lowestScore) {
          lowestScore = s;
          lowestId = id;
        }
      }
      if (lowestId !== null) this.entries.delete(lowestId);
    }

    this.entries.set(nodeId, { nodeId, frequency: 1, lastAccessed: now });
  }

  contains(nodeId: string): boolean {
    return this.entries.has(nodeId);
  }

  getTop(n: number): string[] {
    const now = Date.now();
    return [...this.entries.values()]
      .map((e) => ({ id: e.nodeId, s: this.score(e, now) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, n)
      .map((e) => e.id);
  }

  getAll(): string[] {
    return [...this.entries.keys()];
  }

  remove(nodeId: string): void {
    this.entries.delete(nodeId);
  }

  size(): number {
    return this.entries.size;
  }

  serialize(): string {
    const data: SerializedWorkingMemory = {
      maxSize: this.maxSize,
      entries: [...this.entries.values()],
    };
    return JSON.stringify(data);
  }

  static deserialize(json: string): WorkingMemory {
    const data = JSON.parse(json) as SerializedWorkingMemory;
    const wm = new WorkingMemory(data.maxSize);
    for (const e of data.entries) {
      wm.entries.set(e.nodeId, {
        nodeId: e.nodeId,
        frequency: e.frequency,
        lastAccessed: e.lastAccessed,
      });
    }
    return wm;
  }
}
