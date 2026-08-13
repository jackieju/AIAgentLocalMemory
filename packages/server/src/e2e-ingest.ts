// 端到端验证：ingest 写入的 episode 节点必须能被 renderContext 读回。
// 直接在进程内调用 main.ts 里注册的 handler 集合，跑真实 core + 真实 SQLite。
// 若通过，证明 ingest 的数据契约（metadata.episodicData）与 ContextRenderer 对齐。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NeuralGraph,
  WorkingMemory,
  ContextRenderer,
  NeuralContextEngine,
  type EngineConfig,
  type ContextRenderConfig,
  type SessionData,
} from "@ai-agent-local-memory/core";
import { SqliteStorageProvider } from "@ai-agent-local-memory/storage-sqlite";
import { randomUUID } from "node:crypto";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`E2E FAIL: ${msg}`);
    process.exit(1);
  }
}

async function ingestTurns(
  storage: SqliteStorageProvider,
  engine: NeuralContextEngine,
  sd: SessionData,
): Promise<number> {
  const existing = await storage.queryNodes({ type: "episode", sourceSession: sd.id });
  const renderable = existing.filter(
    (n) => (n.metadata?.episodicData as { turnIndex: number } | undefined) !== undefined,
  );
  let turnIndex = renderable.length;
  const startCount = renderable.length;
  const now = Date.now();
  for (const msg of sd.messages) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const content = typeof msg.content === "string" ? msg.content : "";
    if (content.length === 0) continue;
    await storage.putNode({
      id: randomUUID(),
      type: "episode",
      content,
      importance: 0.5,
      strength: 1.0,
      accessCount: 0,
      lastAccessed: msg.timestamp ?? now,
      createdAt: msg.timestamp ?? now,
      sourceSession: sd.id,
      metadata: {
        episodicData: {
          role: msg.role,
          tag: turnIndex + 1,
          turnIndex,
          fidelity: { f0: content },
        },
      },
    });
    turnIndex += 1;
  }
  await engine.ingest(sd);
  return turnIndex - startCount;
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "nvp-e2e-"));
  const dbPath = join(dir, "graph.db");
  try {
    const storage = new SqliteStorageProvider({ storagePath: dbPath });
    const engine = new NeuralContextEngine();
    const config: EngineConfig = { storage, projectId: "e2e", workingMemorySize: 1000, maxEdgesPerNode: 8 };
    await engine.init(config);

    const sessionId = "e2e-session";
    const sd1: SessionData = {
      id: sessionId,
      messages: [
        { role: "user", content: "How do I set up JWT auth in Express?" },
        { role: "assistant", content: "Use jsonwebtoken. Sign on login, verify in middleware." },
        { role: "user", content: "What about refresh tokens?" },
      ],
    };

    const n1 = await ingestTurns(storage, engine, sd1);
    assert(n1 === 3, `first ingest should add 3 turns, got ${n1}`);

    const sd2: SessionData = {
      id: sessionId,
      messages: [
        { role: "assistant", content: "Store refresh tokens server-side, rotate on use." },
        { role: "user", content: "Show me the middleware code." },
      ],
    };
    const n2 = await ingestTurns(storage, engine, sd2);
    assert(n2 === 2, `second ingest should add 2 turns, got ${n2}`);

    const graph = new NeuralGraph(storage, 8);
    const wm = new WorkingMemory(1000);
    const rcfg: ContextRenderConfig = { contextWindowTokens: 200000, budgetRatio: 0.6 };
    const renderer = new ContextRenderer(graph, wm, storage, rcfg);

    const allEpisodes = await storage.queryNodes({ type: "episode", sourceSession: sessionId });
    const renderable = allEpisodes
      .filter((n) => (n.metadata?.episodicData as { turnIndex: number } | undefined) !== undefined)
      .sort(
        (a, b) =>
          (a.metadata!.episodicData as { turnIndex: number }).turnIndex -
          (b.metadata!.episodicData as { turnIndex: number }).turnIndex,
      );
    assert(renderable.length === 5, `expected 5 renderable episodes, got ${renderable.length}`);
    const lastEpisode = renderable[renderable.length - 1];
    const result = await renderer.render(sessionId, [{ nodeId: lastEpisode.id, baseScore: 1.0 }]);

    assert(result != null, "render returned null");
    assert(result.messages.length === 5, `expected 5 messages, got ${result.messages.length}`);

    const contents = result.messages.map((m) => m.content);
    assert(contents[4].includes("middleware code"), `last turn lost verbatim: ${contents[4]}`);

    const roles = result.messages.map((m) => m.role);
    assert(
      JSON.stringify(roles) === JSON.stringify(["user", "assistant", "user", "assistant", "user"]),
      `role order wrong: ${JSON.stringify(roles)}`,
    );

    await engine.shutdown();
    console.log("E2E PASS");
    console.log(JSON.stringify({ ingested: [n1, n2], rendered: result.messages.length, roles }, null, 2));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("E2E FAIL (exception):", err);
  process.exit(1);
});
