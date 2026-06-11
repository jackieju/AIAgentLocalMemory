import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { MemoryNode, StorageProvider, Synapse, SynapseType } from "./interfaces.ts";

export type Operation =
  | { ts: number; machine: string; op: "add_node"; data: MemoryNode }
  | {
      ts: number;
      machine: string;
      op: "update_node";
      data: { id: string; updates: Partial<Omit<MemoryNode, "id">> };
    }
  | { ts: number; machine: string; op: "delete_node"; data: { id: string } }
  | { ts: number; machine: string; op: "add_edge"; data: Synapse }
  | {
      ts: number;
      machine: string;
      op: "update_edge";
      data: {
        src: string;
        dst: string;
        type: SynapseType;
        updates: Partial<Omit<Synapse, "src" | "dst" | "type">>;
      };
    }
  | {
      ts: number;
      machine: string;
      op: "delete_edge";
      data: { src: string; dst: string; type: SynapseType };
    };

interface SyncState {
  lastReplayedTs: number;
  lastSyncTs: number;
  machineId: string;
}

export class OperationLog {
  public readonly machineId: string;
  private readonly logPath: string;
  private readonly statePath: string;
  private lastReplayedTs: number = 0;
  private lastSyncTs: number = 0;

  constructor(logDir: string, machineId?: string) {
    this.machineId = machineId ?? hostname();
    this.logPath = join(logDir, "operations.jsonl");
    this.statePath = join(logDir, "sync-state.json");
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    this.loadState();
  }

  append(op: Operation): void {
    appendFileSync(this.logPath, JSON.stringify(op) + "\n");
  }

  getNewOperations(): Operation[] {
    if (!existsSync(this.logPath)) return [];
    const raw = readFileSync(this.logPath, "utf-8");
    if (raw.length === 0) return [];
    const ops: Operation[] = [];
    for (const line of raw.split("\n")) {
      if (line.length === 0) continue;
      try {
        const op = JSON.parse(line) as Operation;
        if (op.ts > this.lastReplayedTs) ops.push(op);
      } catch {
        continue;
      }
    }
    return ops;
  }

  async replay(storage: StorageProvider): Promise<{ applied: number; skipped: number }> {
    const ops = this.getNewOperations();
    let applied = 0;
    let skipped = 0;

    for (const op of ops) {
      // Skip operations originating from this machine — they were already
      // applied to the local storage at write time. Replay only handles
      // operations pulled in from other machines via git.
      if (op.machine === this.machineId) {
        skipped++;
        continue;
      }

      switch (op.op) {
        case "add_node":
          await storage.putNode(op.data);
          break;
        case "update_node":
          await storage.updateNode(op.data.id, op.data.updates);
          break;
        case "delete_node":
          await storage.deleteNode(op.data.id);
          break;
        case "add_edge":
          await storage.putEdge(op.data);
          break;
        case "update_edge":
          await storage.updateEdge(op.data.src, op.data.dst, op.data.type, op.data.updates);
          break;
        case "delete_edge":
          await storage.deleteEdge(op.data.src, op.data.dst, op.data.type);
          break;
      }
      applied++;
    }

    if (ops.length > 0) {
      this.lastReplayedTs = ops[ops.length - 1].ts;
      this.saveState();
    }

    return { applied, skipped };
  }

  getPendingCount(): number {
    if (!existsSync(this.logPath)) return 0;
    const raw = readFileSync(this.logPath, "utf-8");
    if (raw.length === 0) return 0;
    let count = 0;
    for (const line of raw.split("\n")) {
      if (line.length === 0) continue;
      try {
        const op = JSON.parse(line) as Operation;
        if (op.machine === this.machineId && op.ts > this.lastSyncTs) count++;
      } catch {
        continue;
      }
    }
    return count;
  }

  markSynced(ts: number = Date.now()): void {
    this.lastSyncTs = ts;
    this.saveState();
  }

  async compact(
    _storage: StorageProvider,
    beforeTs?: number,
  ): Promise<{ removed: number }> {
    if (!existsSync(this.logPath)) return { removed: 0 };
    const cutoff = beforeTs ?? this.lastReplayedTs;
    const raw = readFileSync(this.logPath, "utf-8");
    if (raw.length === 0) return { removed: 0 };

    const kept: string[] = [];
    let removed = 0;
    for (const line of raw.split("\n")) {
      if (line.length === 0) continue;
      try {
        const op = JSON.parse(line) as Operation;
        if (op.ts > cutoff) {
          kept.push(line);
        } else {
          removed++;
        }
      } catch {
        kept.push(line);
      }
    }

    writeFileSync(this.logPath, kept.length > 0 ? kept.join("\n") + "\n" : "");
    return { removed };
  }

  private saveState(): void {
    const state: SyncState = {
      lastReplayedTs: this.lastReplayedTs,
      lastSyncTs: this.lastSyncTs,
      machineId: this.machineId,
    };
    const dir = dirname(this.statePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(state));
  }

  private loadState(): void {
    if (!existsSync(this.statePath)) return;
    try {
      const raw = readFileSync(this.statePath, "utf-8");
      const state = JSON.parse(raw) as Partial<SyncState>;
      if (typeof state.lastReplayedTs === "number") {
        this.lastReplayedTs = state.lastReplayedTs;
      }
      if (typeof state.lastSyncTs === "number") {
        this.lastSyncTs = state.lastSyncTs;
      }
    } catch {
      // Corrupt state file: treat as fresh start.
    }
  }
}
