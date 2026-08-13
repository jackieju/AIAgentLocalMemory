// 生死门 (proof-of-life gate)
// Wires the REAL core against a throwaway SQLite DB, inserts episode nodes,
// and calls ContextRenderer.render() end-to-end. If this passes, the RPC
// surface for packages/server is proven and we can build the binary.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NeuralGraph,
  WorkingMemory,
  ContextRenderer,
  type MemoryNode,
  type EpisodicData,
  type ContextRenderConfig,
} from "@ai-agent-local-memory/core";
import { SqliteStorageProvider } from "@ai-agent-local-memory/storage-sqlite";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`GATE FAIL: ${msg}`);
    process.exit(1);
  }
}

function episodeNode(
  id: string,
  role: EpisodicData["role"],
  tag: number,
  turnIndex: number,
  f0: string,
  createdAt: number,
): MemoryNode {
  const data: EpisodicData = {
    role,
    tag,
    turnIndex,
    fidelity: { f0 },
  };
  return {
    id,
    type: "episode",
    content: f0,
    importance: 0.5,
    strength: 1.0,
    accessCount: 0,
    lastAccessed: createdAt,
    createdAt,
    sourceSession: "gate-session",
    metadata: { episodicData: data },
  };
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "nvp-gate-"));
  const dbPath = join(dir, "graph.db");
  const storage = new SqliteStorageProvider({ storagePath: dbPath });

  try {
    await storage.open("gate-session");

    const now = Date.now();
    const sessionId = "gate-session";
    const turns = [
      episodeNode("ep1", "user", 1, 0, "How do I set up JWT auth in Express?", now - 5000),
      episodeNode("ep2", "assistant", 2, 1, "Use jsonwebtoken. Sign on login, verify in middleware.", now - 4000),
      episodeNode("ep3", "user", 3, 2, "What about refresh tokens?", now - 3000),
      episodeNode("ep4", "assistant", 4, 3, "Store refresh tokens server-side, rotate on use.", now - 2000),
      episodeNode("ep5", "user", 5, 4, "Show me the middleware code.", now - 1000),
    ];
    for (const node of turns) {
      await storage.putNode(node);
    }

    const graph = new NeuralGraph(storage, 8);
    const workingMemory = new WorkingMemory(1000);
    const config: ContextRenderConfig = {
      contextWindowTokens: 200000,
      budgetRatio: 0.6,
    };
    const renderer = new ContextRenderer(graph, workingMemory, storage, config);

    const result = await renderer.render(sessionId, [
      { nodeId: "ep5", baseScore: 1.0 },
    ]);

    assert(result != null, "render() returned null/undefined");
    assert(Array.isArray(result.messages), "result.messages is not an array");
    assert(result.messages.length === turns.length,
      `expected ${turns.length} messages, got ${result.messages.length}`);
    assert(typeof result.systemInjection === "string", "systemInjection not a string");
    assert(typeof result.totalTokens === "number" && result.totalTokens > 0,
      `totalTokens not positive: ${result.totalTokens}`);
    assert(typeof result.budgetAvailable === "number" && result.budgetAvailable > 0,
      `budgetAvailable not positive: ${result.budgetAvailable}`);

    const last = result.messages[result.messages.length - 1];
    assert(last.content.includes("middleware code"),
      `last message lost its verbatim content: "${last.content}"`);
    assert(last.fidelityLevel === "f0",
      `seeded last turn should be f0, got ${last.fidelityLevel}`);

    for (const m of result.messages) {
      assert(["user", "assistant", "system", "tool"].includes(m.role),
        `bad role: ${m.role}`);
      assert(["f0", "f1", "f2", "f3", "f4"].includes(m.fidelityLevel),
        `bad fidelity: ${m.fidelityLevel}`);
    }

    await storage.close();

    console.log("GATE PASS");
    console.log(JSON.stringify({
      messages: result.messages.length,
      totalTokens: result.totalTokens,
      budgetAvailable: result.budgetAvailable,
      budgetUsed: result.budgetUsed,
      fidelities: result.messages.map((m) => m.fidelityLevel),
      systemInjectionChars: result.systemInjection.length,
    }, null, 2));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("GATE FAIL (exception):", err);
  process.exit(1);
});
