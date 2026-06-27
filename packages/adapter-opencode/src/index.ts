import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Plugin, Hooks } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { NeuralContextEngine, ContextRenderer, NeuralGraph, WorkingMemory, OpenAICompatibleLLM, OpenAICompatibleEmbedding, OllamaLLM, OllamaEmbedding, EmbeddingLinker, OperationLog, LoggedStorageProvider, Historian, LightweightLinker } from "@ai-agent-local-memory/core";
import type { NodeType, RecallResult, MemoryNode, ContextRenderConfig, EpisodicData, LLMProvider, EmbeddingProvider, Compartment } from "@ai-agent-local-memory/core";
import { SqliteStorageProvider, CompartmentStore } from "@ai-agent-local-memory/storage-sqlite";

interface PluginConfig {
  injectSystemPrompt?: boolean;
  contextWindowTokens?: number;
  budgetRatio?: number;
  protectedTags?: number;
  coexistWithMagicContext?: boolean;
  syncRepo?: string;
  llm?: {
    provider: "openai" | "ollama" | "custom";
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  };
  embedding?: {
    provider: "openai" | "ollama" | "custom";
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  };
}

function loadConfig(directory: string): PluginConfig {
  const candidates = [
    join(directory, ".opencode", "neural-context.json"),
    join(directory, "neural-context.json"),
    join(homedir(), ".config", "opencode", "neural-context.json"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, "utf-8")) as PluginConfig;
      } catch {
        return {};
      }
    }
  }
  return {};
}

function detectMagicContext(directory: string): boolean {
  const opencodePaths = [
    join(directory, "opencode.json"),
    join(directory, "opencode.jsonc"),
    join(directory, ".opencode", "opencode.json"),
    join(directory, ".opencode", "opencode.jsonc"),
  ];
  for (const p of opencodePaths) {
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, "utf-8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
        if (raw.includes("@cortexkit/opencode-magic-context") || raw.includes("magic-context")) {
          return true;
        }
      } catch {
        continue;
      }
    }
  }
  return false;
}

const NODE_TYPES: readonly NodeType[] = [
  "concept",
  "assertion",
  "definition",
  "filler",
  "episode",
  "meta",
  "fact",
] as const;

function projectIdFromDir(dir: string): string {
  return createHash("sha256").update(dir).digest("hex").slice(0, 16);
}

function formatRecall(results: RecallResult[]): string {
  if (results.length === 0) return "No memories found.";
  return results
    .map((r, i) => {
      const path = r.path && r.path.length > 1 ? ` [path: ${r.path.join(" → ")}]` : "";
      const time = r.node.createdAt ? new Date(r.node.createdAt).toISOString().slice(0, 16).replace("T", " ") : "";
      return `${i + 1}. [${r.node.type}] (score=${r.score.toFixed(3)}) ${time}${path}\n   ${r.node.content}`;
    })
    .join("\n\n");
}

function formatNode(n: MemoryNode): string {
  return `id=${n.id} type=${n.type} importance=${n.importance.toFixed(2)} strength=${n.strength.toFixed(2)} accesses=${n.accessCount}\n${n.content}`;
}

function parseTagRanges(input: string): number[] {
  const tags: number[] = [];
  for (const part of input.split(",")) {
    const trimmed = part.trim();
    if (trimmed.includes("-")) {
      const [start, end] = trimmed.split("-").map(Number);
      for (let i = start; i <= end; i++) tags.push(i);
    } else {
      tags.push(Number(trimmed));
    }
  }
  return tags.filter((n) => !isNaN(n) && n > 0);
}

const AIAgentLocalMemoryPlugin: Plugin = async ({ directory, client }) => {
  const sessionId = projectIdFromDir(directory);
  const pluginConfig = loadConfig(directory);
  const rawStorage = new SqliteStorageProvider();
  const engine = new NeuralContextEngine();
  const dataBase = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  const episodesDir = join(dataBase, 'ai-agent-local-memory', 'episodes');
  const syncDir = join(dataBase, 'ai-agent-local-memory', 'sync');

  const opLog = new OperationLog(syncDir);
  const storage = new LoggedStorageProvider(rawStorage, opLog);

  let llmProvider: LLMProvider | undefined;
  let embeddingProvider: EmbeddingProvider | undefined;

  if (pluginConfig.llm) {
    const c = pluginConfig.llm;
    if (c.provider === "ollama") {
      llmProvider = new OllamaLLM({ model: c.model });
    } else if (c.provider === "openai" || c.provider === "custom") {
      llmProvider = new OpenAICompatibleLLM({
        baseUrl: c.baseUrl ?? "https://api.openai.com/v1",
        apiKey: c.apiKey ?? process.env.OPENAI_API_KEY,
        model: c.model,
      });
    }
  }

  if (pluginConfig.embedding) {
    const c = pluginConfig.embedding;
    if (c.provider === "ollama") {
      embeddingProvider = new OllamaEmbedding({ model: c.model });
    } else if (c.provider === "openai" || c.provider === "custom") {
      embeddingProvider = new OpenAICompatibleEmbedding({
        baseUrl: c.baseUrl ?? "https://api.openai.com/v1",
        apiKey: c.apiKey ?? process.env.OPENAI_API_KEY,
        embeddingModel: c.model,
      });
    }
  }

  try {
    await engine.init({ storage, projectId: "global", episodesDir, llm: llmProvider, embedding: embeddingProvider });
  } catch (err) {
    console.error("[ai-agent-local-memory] init failed:", err);
    return {} as Hooks;
  }

  const compartmentStore = new CompartmentStore(rawStorage.getDb());

  let openCodeDb: any = null;
  try {
    const xdgData = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
    const openCodeDbPath = join(xdgData, 'opencode', 'opencode.db');
    if (existsSync(openCodeDbPath)) {
      const mainDb = rawStorage.getDb();
      mainDb.exec(`ATTACH DATABASE '${openCodeDbPath}' AS opencode`);
      openCodeDb = mainDb;
    }
  } catch {}

  function getContextUsage(sid: string): { percentage: number; inputTokens: number } {
    if (!openCodeDb) return { percentage: 0, inputTokens: 0 };
    try {
      const row = openCodeDb.prepare(`
        SELECT 
          COALESCE(json_extract(data, '$.tokens.input'), 0)
            + COALESCE(json_extract(data, '$.tokens.cache.read'), 0)
            + COALESCE(json_extract(data, '$.tokens.cache.write'), 0) AS prompt
        FROM opencode.message
        WHERE session_id = ?
          AND json_extract(data, '$.role') = 'assistant'
          AND data IS NOT NULL
        ORDER BY time_created DESC
        LIMIT 1
      `).get(sid) as { prompt: number } | undefined;
      if (!row) return { percentage: 0, inputTokens: 0 };
      const contextLimit = pluginConfig.contextWindowTokens ?? 128000;
      return { percentage: (row.prompt / contextLimit) * 100, inputTokens: row.prompt };
    } catch { return { percentage: 0, inputTokens: 0 }; }
  }

  const historianModels = ["claude-sonnet-4-6", "gpt-4.1-mini", "gpt-5-mini"];
  const historianLlm = llmProvider ?? new OpenAICompatibleLLM({
    baseUrl: pluginConfig.embedding?.baseUrl ?? pluginConfig.llm?.baseUrl ?? "http://localhost:6655/openai/v1",
    apiKey: pluginConfig.embedding?.apiKey ?? pluginConfig.llm?.apiKey ?? process.env.OPENAI_API_KEY,
    model: historianModels[0],
    maxTokens: 400,
  });
  const historian = (embeddingProvider || llmProvider || pluginConfig.embedding || pluginConfig.llm)
    ? new Historian({ llm: historianLlm, fallbackModels: historianModels.slice(1) })
    : null;
  let historianTurnCount = 0;

  const SERVER_BUILD = "__BUILD_NUMBER__";
  writeFileSync("/tmp/neural-server-build.txt", SERVER_BUILD);
  writeFileSync("/tmp/neural-plugin-init.log", JSON.stringify({
    ts: new Date().toISOString(),
    build: SERVER_BUILD,
    hasEmbedding: !!embeddingProvider,
    hasLlm: !!llmProvider,
    configLoaded: !!pluginConfig.embedding,
    directory,
  }, null, 2));

  let rpcServer: any = null;
  try {
    const { createServer } = await import("node:net");
    const rpcPath = "/tmp/neural-context-rpc.sock";
    try { const { unlinkSync } = await import("node:fs"); unlinkSync(rpcPath); } catch {}
    rpcServer = createServer((conn) => {
      conn.on("data", async (data) => {
        try {
          const req = JSON.parse(data.toString());
          let res: any = {};
          if (req.method === "status") {
            const usage = getContextUsage(sessionId);
            const compartments = compartmentStore.getForSession(sessionId);
            const nodeCount = await storage.getNodeCount();
            res = { build: SERVER_BUILD, usage, compartments: compartments.length, nodes: nodeCount, historianFailures: 0, model: "" };
          } else if (req.method === "compartments") {
            res = { compartments: compartmentStore.getForSession(sessionId) };
          }
          conn.write(JSON.stringify(res) + "\n");
        } catch { conn.write("{}\n"); }
      });
    });
    rpcServer.listen(rpcPath);
  } catch {}

  if (historian && openCodeDb) {
    setTimeout(async () => {
      try {
        const sessions = await client.session.list();
        if (!sessions.data || sessions.data.length === 0) return;
        const currentSession = sessions.data[0];
        const sid = currentSession.id;
        const row = openCodeDb.prepare(`
          SELECT 
            COALESCE(json_extract(data, '$.tokens.input'), 0)
              + COALESCE(json_extract(data, '$.tokens.cache.read'), 0)
              + COALESCE(json_extract(data, '$.tokens.cache.write'), 0) AS prompt
          FROM opencode.message
          WHERE session_id = ?
            AND json_extract(data, '$.role') = 'assistant'
            AND data IS NOT NULL
          ORDER BY time_created DESC
          LIMIT 1
        `).get(sid) as { prompt: number } | undefined;
        if (!row) return;
        const contextLimit = pluginConfig.contextWindowTokens ?? 128000;
        const pct = (row.prompt / contextLimit) * 100;
        if (pct >= 90) {
          const maxOrd = compartmentStore.getMaxOrd(sessionId);
          const msgsResult = await client.session.messages({ path: { id: sid }, query: { limit: 100 } });
          if (!msgsResult.data) return;
          const uncovered = msgsResult.data.slice(maxOrd + 1);
          if (uncovered.length < 6) return;
          const chunkSize = Math.min(64, uncovered.length - 20);
          if (chunkSize < 6) return;
          const windowMsgs = uncovered.slice(0, chunkSize).map((m: any, idx: number) => {
            const textParts = (m.parts ?? []).filter((p: any) => p.type === "text");
            const content = textParts.map((p: any) => p.text ?? "").join("\n").slice(0, 1000);
            return { role: (m.info?.role ?? "user") as string, content, ord: maxOrd + 1 + idx };
          });
          const result = await (historian as any).compress(sessionId, windowMsgs);
          if (result) compartmentStore.save(result);
          writeFileSync("/tmp/neural-init-compress.log", JSON.stringify({ ts: Date.now(), pct, chunkSize, success: !!result }));
        }
      } catch {}
    }, 3000);
  }

  setTimeout(async () => {
    try {
      if (!currentOpenCodeSessionId) return;
      const msgsResult = await client.session.messages({ path: { id: currentOpenCodeSessionId }, query: { limit: 50 } });
      if (!msgsResult.data || msgsResult.data.length === 0) return;
      for (const msg of msgsResult.data.slice(-20)) {
        const role = msg.info.role;
        if (role !== "user" && role !== "assistant") continue;
        const textParts = msg.parts.filter((p: any) => p.type === "text");
        const content = textParts.map((p: any) => (p as { text?: string }).text ?? "").join("\n").trim();
        if (content.length < 10 || content.length > 3000) continue;
        await storage.putNode({
          id: crypto.randomUUID(),
          type: "episode",
          content: content.slice(0, 2000),
          importance: role === "user" ? 0.6 : 0.5,
          strength: 0.5,
          accessCount: 0,
          lastAccessed: Date.now(),
          createdAt: Date.now(),
          sourceSession: sessionId,
        });
      }
    } catch {}
  }, 8000);

  if (existsSync(join(syncDir, ".git"))) {
  }

  const magicContextPresent = pluginConfig.coexistWithMagicContext ?? detectMagicContext(directory);
  if (magicContextPresent) {
    console.log("[ai-agent-local-memory] magic-context detected — running in coexistence mode (messages.transform disabled)");
  }

  if (pluginConfig.syncRepo && !existsSync(join(syncDir, ".git"))) {
    try {
      const { mkdirSync: mkSync } = await import("node:fs");
      const { execSync } = await import("node:child_process");
      mkSync(syncDir, { recursive: true });
      execSync(`git init && git remote add origin ${pluginConfig.syncRepo}`, { cwd: syncDir, stdio: "ignore" });
      console.log(`[ai-agent-local-memory] sync repo initialized: ${pluginConfig.syncRepo}`);
    } catch {
      console.warn("[ai-agent-local-memory] sync repo auto-init failed");
    }
  }

  let syncTimer: ReturnType<typeof setInterval> | null = null;
  let dreamerTimer: ReturnType<typeof setInterval> | null = null;
  let reconciliationTimer: ReturnType<typeof setInterval> | null = null;

  reconciliationTimer = setInterval(async () => {
    try {
      if (!openCodeDb) return;
      const row = openCodeDb.prepare(`SELECT COUNT(*) as cnt FROM opencode.message WHERE session_id = ?`).get(sessionId) as { cnt: number } | undefined;
      if (!row || row.cnt === 0) return;
      const storedCount = await storage.getNodeCount();
      if (row.cnt > storedCount * 2) {
        if (!currentOpenCodeSessionId) return;
        const msgsResult = await client.session.messages({ path: { id: currentOpenCodeSessionId }, query: { limit: 10 } });
        if (!msgsResult.data) return;
        for (const msg of msgsResult.data.slice(-5)) {
          const role = msg.info.role;
          if (role !== "user" && role !== "assistant") continue;
          const textParts = msg.parts.filter((p: any) => p.type === "text");
          const content = textParts.map((p: any) => (p as { text?: string }).text ?? "").join("\n").trim();
          if (content.length < 10 || content.length > 3000) continue;
          await storage.putNode({
            id: crypto.randomUUID(),
            type: "episode",
            content: content.slice(0, 2000),
            importance: role === "user" ? 0.6 : 0.5,
            strength: 0.5,
            accessCount: 0,
            lastAccessed: Date.now(),
            createdAt: Date.now(),
            sourceSession: sessionId,
          });
        }
      }
    } catch {}
  }, 5 * 60 * 1000);

  if (historian) {
    // Dreamer: daily cron at 2:00 AM (matching magic-context's schedule)
    const runDreamer = async () => {
      try {
        const recentEpisodes = await storage.queryNodes({ type: "episode", sourceSession: sessionId, limit: 20 });
        if (recentEpisodes.length < 5) return;

        const existingFacts = await storage.queryNodes({ type: "fact" });
        const existingFactContents = new Set(existingFacts.map(f => f.content.toLowerCase()));

        const transcript = recentEpisodes
          .slice(-10)
          .map(e => e.content.slice(0, 500))
          .join("\n");

        const extractPrompt = `Extract user preferences, decisions, and constraints from this conversation excerpt.
Return a JSON array of strings — each string is one standalone fact worth remembering long-term.
Only extract CLEAR preferences/decisions (e.g. "User prefers TypeScript over JavaScript", "Project uses Bun runtime").
If nothing worth extracting, return [].
Do NOT extract opinions, questions, or temporary states.

CONVERSATION:
${transcript}

JSON:`;

        const response = await historianLlm.complete(extractPrompt, { maxTokens: 300 });
        if (!response) return;

        const jsonMatch = response.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return;

        const facts: string[] = JSON.parse(jsonMatch[0]);
        for (const fact of facts) {
          if (typeof fact !== "string" || fact.length < 10 || fact.length > 500) continue;
          if (existingFactContents.has(fact.toLowerCase())) continue;
          await engine.remember(fact, "fact", {
            importance: 0.8,
            metadata: { factData: { scope: "global", activationFloor: 0.5, ready: true } },
          });
        }

        const filePathRegex = /(?:\/[\w.-]+)+\.\w+/g;
        const fileCounts = new Map<string, number>();
        for (const ep of recentEpisodes) {
          const matches = ep.content.match(filePathRegex);
          if (matches) {
            for (const m of matches) {
              fileCounts.set(m, (fileCounts.get(m) ?? 0) + 1);
            }
          }
        }
        const keyFiles = [...fileCounts.entries()]
          .filter(([, count]) => count >= 3)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([path]) => path);

        for (const filePath of keyFiles) {
          const factContent = `Key file: ${filePath}`;
          if (existingFactContents.has(factContent.toLowerCase())) continue;
          await engine.remember(factContent, "fact", {
            importance: 0.7,
            metadata: { factData: { scope: "session", activationFloor: 0.3, ready: true, keyFile: true } },
          });
        }
      } catch {}
    };

    // Schedule dreamer at 2:00 AM daily (like magic-context)
    const scheduleDreamerCron = () => {
      const now = new Date();
      const next2am = new Date(now);
      next2am.setHours(2, 0, 0, 0);
      if (next2am <= now) next2am.setDate(next2am.getDate() + 1);
      const msUntilNext = next2am.getTime() - now.getTime();
      dreamerTimer = setTimeout(async () => {
        await runDreamer();
        // Reschedule for next day
        dreamerTimer = setInterval(runDreamer, 24 * 60 * 60 * 1000);
      }, msUntilNext) as any;
    };
    scheduleDreamerCron();
  }

  if (existsSync(join(syncDir, ".git"))) {
    syncTimer = setInterval(async () => {
      try {
        const { execSync } = await import("node:child_process");
        const hasChanges = (() => {
          try {
            const out = execSync("git status --porcelain", { cwd: syncDir, encoding: "utf-8" });
            return out.trim().length > 0;
          } catch { return false; }
        })();
        if (hasChanges) {
          execSync('git add -A && git commit -m "sync: auto" && git push', { cwd: syncDir, stdio: "ignore" });
        }
        execSync("git pull --rebase", { cwd: syncDir, stdio: "ignore" });
      } catch {}
    }, 60 * 60 * 1000);
  }

  const sessionBackupDir = join(dataBase, 'ai-agent-local-memory', 'session-backup');
  setTimeout(async () => {
    try {
      const { mkdirSync, copyFileSync } = await import("node:fs");
      const { execSync } = await import("node:child_process");

      const lastBackupFile = join(sessionBackupDir, ".last-session-backup");
      mkdirSync(sessionBackupDir, { recursive: true });
      const lastBackup = existsSync(lastBackupFile) ? parseInt(readFileSync(lastBackupFile, "utf-8")) || 0 : 0;
      if (Date.now() - lastBackup < 24 * 60 * 60 * 1000) return;

      const xdgData = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
      const openCodeDbPath = join(xdgData, 'opencode', 'opencode.db');
      if (!existsSync(openCodeDbPath)) return;

      const icloudDir = join(homedir(), "Library", "Mobile Documents", "com~apple~CloudDocs", "opencode-backup");
      mkdirSync(icloudDir, { recursive: true });

      const backupFile = join(icloudDir, "opencode.db.gz");
      const { exec: execAsync } = await import("node:child_process");
      execAsync(`nice -n 19 gzip -1 -c "${openCodeDbPath}" > "${backupFile}"`, { stdio: "ignore" } as any, () => {
        writeFileSync(lastBackupFile, String(Date.now()));
      });

      const configDir = join(homedir(), '.config', 'opencode');
      for (const f of ['opencode.jsonc', 'opencode.json', 'neural-context.json']) {
        const src = join(configDir, f);
        if (existsSync(src)) copyFileSync(src, join(icloudDir, f));
      }
    } catch {}
  }, 30 * 1000);

  const renderConfig: ContextRenderConfig = {
    contextWindowTokens: pluginConfig.contextWindowTokens ?? 128000,
    budgetRatio: pluginConfig.budgetRatio ?? 0.6,
  };

  const graph = new NeuralGraph(storage);
  const workingMemory = new WorkingMemory();
  const renderer = new ContextRenderer(graph, workingMemory, storage, renderConfig);

  let turnCounter = 0;
  const droppedTags = new Set<number>();
  let lastModelKey = "";
  let lastContextPercentage = 0;
  let reasoningWatermark = 0;
  let historianFailureCount = 0;
  let lastTailStartIdx = -1;
  let lastSystemHash = "";
  let lastCompressTime = 0;
  let currentOpenCodeSessionId = "";

  try {
    const row = rawStorage.getDb().prepare(`SELECT value FROM kv WHERE key = 'reasoning_watermark'`).get() as { value: string } | undefined;
    if (row) reasoningWatermark = parseInt(row.value) || 0;
    const row2 = rawStorage.getDb().prepare(`SELECT value FROM kv WHERE key = 'last_compress_time'`).get() as { value: string } | undefined;
    if (row2) lastCompressTime = parseInt(row2.value) || 0;
  } catch {
    try { rawStorage.getDb().exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)`); } catch {}
  }

  const z = tool.schema;

  return {
    dispose: async () => {
      try {
        await engine.shutdown();
      } catch (err) {
        console.error("[ai-agent-local-memory] shutdown failed:", err);
      }
    },

    tool: {
      neural_remember: tool({
        description: "Store a memory node in the neural context engine for later associative recall.",
        args: {
          content: z.string().min(1).describe("The content to remember."),
          type: z
            .enum(NODE_TYPES as unknown as [NodeType, ...NodeType[]])
            .optional()
            .describe("Node type (default: concept)."),
          importance: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe("Importance from 0 to 1, affects decay rate."),
        },
        async execute(args) {
          const node = await engine.remember(args.content, args.type ?? "concept", {
            importance: args.importance,
          });
          return {
            title: `Remembered ${node.type}`,
            output: `Stored memory ${node.id} (${node.type}, importance=${node.importance.toFixed(2)}).`,
            metadata: { nodeId: node.id, type: node.type },
          };
        },
      }),

      neural_recall: tool({
        description:
          "Find memories by ASSOCIATION — follows neural connections to discover related concepts you didn't explicitly search for. Unlike keyword/vector search, this traverses a graph of concepts via spreading activation: starting from your query, it finds directly related ideas, then ideas related to THOSE, revealing non-obvious connections. Use when you need 'what else relates to X?' or 'what context surrounds Y?'",
        args: {
          query: z.string().min(1).describe("Natural language query."),
          maxResults: z.number().int().positive().max(100).optional().describe("Max results (default 10)."),
        },
        async execute(args) {
          const results = await engine.recall(args.query, {
            maxResults: args.maxResults ?? 10,
          });
          return {
            title: `Recalled ${results.length} memor${results.length === 1 ? "y" : "ies"}`,
            output: formatRecall(results),
            metadata: { count: results.length },
          };
        },
      }),

      neural_forget: tool({
        description: "Remove a memory node by its ID.",
        args: {
          nodeId: z.string().min(1).describe("ID of the node to delete."),
        },
        async execute(args) {
          await storage.deleteNode(args.nodeId);
          return {
            title: "Forgot memory",
            output: `Deleted node ${args.nodeId}.`,
            metadata: { nodeId: args.nodeId },
          };
        },
      }),

      neural_status: tool({
        description: "Get neural context engine statistics and working memory overview.",
        args: {},
        async execute() {
          const stats = await engine.getStats();
          const wm = engine.getWorkingMemory();
          const byType = Object.entries(stats.nodesByType)
            .map(([t, c]) => `  ${t}: ${c}`)
            .join("\n");
          const wmPreview = wm
            .slice(0, 10)
            .map((n) => `  - ${formatNode(n)}`)
            .join("\n");
          const output = [
            `Session: ${sessionId}`,
            `Nodes: ${stats.nodeCount}`,
            `Edges: ${stats.edgeCount}`,
            `Working memory: ${stats.workingMemorySize}`,
            "Nodes by type:",
            byType,
            "",
            `Top working memory (${Math.min(wm.length, 10)} of ${wm.length}):`,
            wmPreview || "  (empty)",
          ].join("\n");
          return {
            title: `Engine stats (${stats.nodeCount} nodes)`,
            output,
            metadata: { stats, workingMemorySize: wm.length },
          };
        },
      }),

      neural_reduce: tool({
        description:
          "Drop tagged content you no longer need. Use §N§ identifiers visible in conversation. Accepts ranges: '3-5', '1,2,9', '1-5,8'.",
        args: {
          drop: z.string().min(1).describe("Tag IDs to suppress, supports ranges."),
        },
        async execute(args) {
          const tags = parseTagRanges(args.drop);
          for (const t of tags) droppedTags.add(t);
          const episodes = await storage.queryNodes({ type: "episode", sourceSession: sessionId });
          let suppressed = 0;
          for (const node of episodes) {
            const ep = (node.metadata?.episodicData as Record<string, unknown> | undefined) ?? undefined;
            const tag = ep && typeof ep.tag === "number" ? (ep.tag as number) : undefined;
            if (tag !== undefined && tags.includes(tag)) {
              await storage.updateNode(node.id, {
                metadata: {
                  ...node.metadata,
                  episodicData: { ...ep, suppressed: true },
                },
              });
              suppressed++;
            }
          }
          return {
            title: `Suppressed ${suppressed} tag${suppressed === 1 ? "" : "s"}`,
            output: `Dropped tags ${tags.join(", ")} from context. Changes take effect next turn.`,
            metadata: { suppressed, requested: tags },
          };
        },
      }),

      neural_pin: tool({
        description: "Pin tagged content to always show at full fidelity. Use §N§ identifiers.",
        args: {
          tags: z.string().min(1).describe("Tag IDs to pin, supports ranges."),
        },
        async execute(args) {
          const tags = parseTagRanges(args.tags);
          const episodes = await storage.queryNodes({ type: "episode", sourceSession: sessionId });
          let pinned = 0;
          for (const node of episodes) {
            const ep = (node.metadata?.episodicData as Record<string, unknown> | undefined) ?? undefined;
            const tag = ep && typeof ep.tag === "number" ? (ep.tag as number) : undefined;
            if (tag !== undefined && tags.includes(tag)) {
              await storage.updateNode(node.id, {
                metadata: {
                  ...node.metadata,
                  episodicData: { ...ep, pinned: true },
                },
              });
              pinned++;
            }
          }
          return {
            title: `Pinned ${pinned} tag${pinned === 1 ? "" : "s"}`,
            output: `Marked ${pinned} episodic node(s) as pinned (requested tags: ${tags.join(", ")}).`,
            metadata: { pinned, requested: tags },
          };
        },
      }),

      neural_expand: tool({
        description: "Expand compressed/elided content back to full text. Use tag numbers from §N§ identifiers, or expand a compartment by ordinal range (start, end).",
        args: {
          tags: z.string().optional().describe("Tag numbers to expand (e.g. '3-5', '1,2,9')."),
          start: z.number().int().optional().describe("Start ordinal of compartment to expand."),
          end: z.number().int().optional().describe("End ordinal of compartment to expand."),
        },
        async execute(args) {
          if (args.start !== undefined && args.end !== undefined) {
            try {
              const expandSessionId = currentOpenCodeSessionId || sessionId;
              const msgsResult = await client.session.messages({ path: { id: expandSessionId }, query: {} });
              if (!msgsResult.data) return { title: "Error", output: "Failed to read session messages." };
              
              const allMsgs = msgsResult.data;
              const slice = allMsgs.slice(args.start, args.end + 1);
              const texts: string[] = [];
              for (const msg of slice) {
                const role = msg.info.role;
                const textParts = msg.parts.filter((p: any) => p.type === "text");
                const content = textParts.map((p: any) => (p as { text?: string }).text ?? "").join("\n");
                if (content) texts.push(`[${role}] ${content}`);
              }
              if (texts.length === 0) return { title: "Empty", output: `No messages in range ${args.start}-${args.end}.` };
              return {
                title: `Expanded ${texts.length} messages (ordinal ${args.start}-${args.end})`,
                output: texts.join("\n\n---\n\n"),
              };
            } catch (e: any) {
              return { title: "Error", output: e.message };
            }
          }

          if (!args.tags) return { title: "Error", output: "Provide tags or start+end range." };
          const tagNumbers = parseTagRanges(args.tags);
          const episodes = await storage.queryNodes({ type: "episode", sourceSession: sessionId });
          const results: string[] = [];

          for (const node of episodes) {
            const ep = (node.metadata?.episodicData as Record<string, unknown> | undefined);
            const tag = ep && typeof ep.tag === "number" ? ep.tag : undefined;
            if (tag !== undefined && tagNumbers.includes(tag)) {
              const fidelity = ep?.fidelity as Record<string, string> | undefined;
              const fullText = fidelity?.f0 ?? node.content;
              results.push(`§${tag}§ [${ep?.role ?? "?"}]\n${fullText}`);
            }
          }

          if (results.length === 0) {
            return { title: "No matches", output: `No episodic nodes found for tags: ${tagNumbers.join(", ")}` };
          }
          return {
            title: `Expanded ${results.length} message(s)`,
            output: results.join("\n\n---\n\n"),
            metadata: { expanded: results.length, tags: tagNumbers },
          };
        },
      }),

      neural_import_history: tool({
        description:
          "Import conversation history from past OpenCode sessions into the neural memory graph. Processes messages, extracts entities, and builds associative edges. Use this to bootstrap the memory graph with existing knowledge.",
        args: {
          limit: z.number().int().positive().optional().describe("Max number of sessions to import (default: all)."),
          since: z.string().optional().describe("Only import sessions created after this date (ISO format, e.g. '2025-01-01')."),
        },
        async execute(args) {
          if (!client) {
            return { title: "Error", output: "OpenCode client not available." };
          }

          const sessionsResult = await client.session.list();
          if (!sessionsResult.data) {
            return { title: "Error", output: "Failed to list sessions." };
          }
          let sessions = sessionsResult.data;

          if (args.since) {
            const sinceMs = new Date(args.since).getTime();
            sessions = sessions.filter((s) => s.time.created >= sinceMs / 1000);
          }

          if (args.limit) {
            sessions = sessions.slice(0, args.limit);
          }

          let totalNodes = 0;
          let totalEdges = 0;
          let processed = 0;

          for (const session of sessions) {
            try {
              const msgsResult = await client.session.messages({ path: { id: session.id } });
              if (!msgsResult.data) continue;

              const messages = msgsResult.data.flatMap((msg) => {
                const role = msg.info.role;
                if (role !== "user" && role !== "assistant") return [];
                return msg.parts
                  .filter((p) => p.type === "text" && (p as { text?: string }).text)
                  .map((p) => ({
                    role: role as "user" | "assistant",
                    content: (p as { text: string }).text,
                    timestamp: msg.info.time?.created ? msg.info.time.created * 1000 : undefined,
                  }));
              });

              if (messages.length === 0) continue;

              await engine.ingest({
                id: session.id,
                messages,
              });

              processed++;
              const stats = await engine.getStats();
              totalNodes = stats.nodeCount;
              totalEdges = stats.edgeCount;
            } catch {
              continue;
            }
          }

          return {
            title: `Imported ${processed} session(s)`,
            output: `Processed ${processed}/${sessions.length} sessions.\nGraph now has ${totalNodes} nodes and ${totalEdges} edges.`,
            metadata: { processed, totalSessions: sessions.length, totalNodes, totalEdges },
          };
        },
      }),

      neural_backup: tool({
        description:
          "Backup the entire neural memory graph to a timestamped directory. Returns the backup path.",
        args: {
          destination: z.string().optional().describe("Custom backup directory. Default: ~/.local/share/ai-agent-local-memory/backups/<timestamp>/"),
        },
        async execute(args) {
          const { cpSync, mkdirSync } = await import("node:fs");
          const dataDir = process.env.AI_AGENT_LOCAL_MEMORY_DIR
            ? join(process.env.AI_AGENT_LOCAL_MEMORY_DIR)
            : join(homedir(), ".local", "share", "ai-agent-local-memory");
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          const backupDir = args.destination || join(dataDir, "backups", timestamp);

          mkdirSync(backupDir, { recursive: true });
          cpSync(dataDir, backupDir, {
            recursive: true,
            filter: (src) => !src.includes("/backups/"),
          });

          const { statSync, readdirSync } = await import("node:fs");
          let totalSize = 0;
          const countFiles = (dir: string): number => {
            let count = 0;
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              const p = join(dir, entry.name);
              if (entry.isDirectory()) {
                count += countFiles(p);
              } else {
                count++;
                totalSize += statSync(p).size;
              }
            }
            return count;
          };
          const fileCount = countFiles(backupDir);
          const sizeMB = (totalSize / 1024 / 1024).toFixed(2);

          return {
            title: `Backup complete (${sizeMB} MB)`,
            output: `Backed up to: ${backupDir}\nFiles: ${fileCount}\nSize: ${sizeMB} MB`,
            metadata: { backupDir, fileCount, sizeMB },
          };
        },
      }),

      neural_sync: tool({
        description:
          "Synchronize neural memory across machines via Git. Commits local changes, pulls remote changes, and replays new operations into the local graph.",
        args: {
          action: z.enum(["status", "push", "pull", "init", "export"]).optional().describe("Action: status (default), push (commit+push), pull (pull+replay), init (initialize sync repo), export (backfill existing memories into operation log)."),
          repoUrl: z.string().optional().describe("Git remote URL (required for init)."),
        },
        async execute(args) {
          const action = args.action ?? "status";
          const syncDir = join(homedir(), ".local", "share", "ai-agent-local-memory", "sync");

          if (action === "init") {
            if (!args.repoUrl) return { title: "Error", output: "repoUrl required for init." };
            const { execSync } = await import("node:child_process");
            const { mkdirSync } = await import("node:fs");
            mkdirSync(syncDir, { recursive: true });
            try {
              execSync(`git init && git remote add origin ${args.repoUrl}`, { cwd: syncDir });
              return { title: "Sync initialized", output: `Sync repo created at ${syncDir}\nRemote: ${args.repoUrl}` };
            } catch (e: any) {
              return { title: "Error", output: e.message };
            }
          }

          if (action === "status") {
            const { existsSync: ex, statSync } = await import("node:fs");
            if (!ex(syncDir)) return { title: "Not initialized", output: "Run neural_sync(action='init', repoUrl='...') first." };
            const logFile = join(syncDir, "operations.jsonl");
            const logExists = ex(logFile);
            const logSize = logExists ? statSync(logFile).size : 0;
            const pending = opLog.getPendingCount();
            return { title: "Sync status", output: `Sync dir: ${syncDir}\nLog: ${logExists ? `${logSize} bytes` : "empty"}\nPending ops: ${pending}\nAuto-sync: every 5 min` };
          }

          if (action === "push") {
            const { execSync } = await import("node:child_process");
            try {
              execSync('git add -A && git commit -m "sync: update operations" --allow-empty && git push', { cwd: syncDir });
              return { title: "Pushed", output: "Local operations committed and pushed." };
            } catch (e: any) {
              return { title: "Push failed", output: e.message };
            }
          }

          if (action === "pull") {
            const { execSync } = await import("node:child_process");
            try {
              execSync("git pull --rebase", { cwd: syncDir, stdio: "ignore" });
              const result = await opLog.replay(storage);
              let embedded = 0;
              if (result.applied > 0 && embeddingProvider) {
                const { EmbeddingLinker } = await import("@ai-agent-local-memory/core");
                const linker = new EmbeddingLinker(rawStorage, embeddingProvider, { batchSize: 32, similarityThreshold: 0.7 });
                const embResult = await linker.run({ limit: result.applied });
                embedded = embResult.embedded;
              }
              return { title: "Pulled", output: `Remote changes pulled.\nApplied: ${result.applied} operations, Skipped: ${result.skipped}.\nEmbedded: ${embedded} new nodes.` };
            } catch (e: any) {
              return { title: "Pull failed", output: e.message };
            }
          }

          if (action === "export") {
            const { readFileSync: rfs, existsSync: ex } = await import("node:fs");
            const logFile = join(syncDir, "operations.jsonl");
            const existingIds = new Set<string>();
            if (ex(logFile)) {
              const lines = rfs(logFile, "utf-8").trim().split("\n").filter(Boolean);
              for (const line of lines) {
                try {
                  const op = JSON.parse(line);
                  if (op.op === "add_node" && op.data?.id) existingIds.add(op.data.id);
                  if (op.op === "add_edge" && op.data) existingIds.add(`${op.data.src}|${op.data.dst}|${op.data.type}`);
                } catch {}
              }
            }

            const allNodes = await storage.getAllNodes();
            const allEdges = await storage.getAllEdges();
            let exported = 0;
            let skipped = 0;
            for (const node of allNodes) {
              if (existingIds.has(node.id)) { skipped++; continue; }
              const { metadata, ...nodeWithoutMeta } = node;
              const cleanMeta = metadata ? { ...metadata } : undefined;
              if (cleanMeta) delete (cleanMeta as any).embedding;
              opLog.append({ ts: node.createdAt || Date.now(), machine: opLog.machineId, op: "add_node", data: { ...nodeWithoutMeta, metadata: cleanMeta } });
              exported++;
            }
            for (const edge of allEdges) {
              const key = `${edge.src}|${edge.dst}|${edge.type}`;
              if (existingIds.has(key)) { skipped++; continue; }
              opLog.append({ ts: edge.lastCoactivated || Date.now(), machine: opLog.machineId, op: "add_edge", data: edge });
              exported++;
            }
            return { title: `Exported ${exported} operations`, output: `Backfilled ${allNodes.length} nodes + ${allEdges.length} edges.\nNew: ${exported}, Skipped (already in log): ${skipped}.\nRun neural_sync(action='push') to upload.` };
          }

          return { title: "Error", output: `Unknown action: ${action}` };
        },
      }),

      neural_note: tool({
        description:
          "Save or manage durable notes/facts that persist across conversation and survive compression. Facts are automatically surfaced in context when relevant concepts activate.",
        args: {
          action: z.enum(["write", "read", "dismiss"]).optional().describe("Operation: write (default), read, or dismiss."),
          content: z.string().optional().describe("Note text (required for write)."),
          scope: z.enum(["session", "project", "global"]).optional().describe("Scope: session (default), project, or global."),
          noteId: z.string().optional().describe("Note ID (required for dismiss)."),
        },
        async execute(args) {
          const action = args.action ?? "write";

          if (action === "write") {
            if (!args.content) return { title: "Error", output: "Content is required for write." };
            const factData = {
              scope: args.scope ?? "session",
              activationFloor: 0.5,
              ready: true,
            };
            const node = await engine.remember(args.content, "fact", {
              importance: 0.9,
              metadata: { factData, sourceSession: sessionId },
            });
            return {
              title: "Note saved",
              output: `Saved note ${node.id} (scope=${factData.scope}).`,
              metadata: { noteId: node.id, scope: factData.scope },
            };
          }

          if (action === "read") {
            const facts = await storage.queryNodes({ type: "fact" });
            const relevant = facts.filter((f) => {
              const fd = f.metadata?.factData as Record<string, unknown> | undefined;
              if (!fd) return false;
              if (fd.scope === "session") return f.sourceSession === sessionId;
              return true;
            });
            if (relevant.length === 0) return { title: "No notes", output: "No saved notes found." };
            const list = relevant
              .map((f, i) => {
                const fd = f.metadata?.factData as Record<string, unknown> | undefined;
                return `${i + 1}. [${fd?.scope ?? "?"}] id=${f.id}\n   ${f.content}`;
              })
              .join("\n\n");
            return { title: `${relevant.length} note(s)`, output: list };
          }

          if (action === "dismiss") {
            if (!args.noteId) return { title: "Error", output: "noteId is required for dismiss." };
            await storage.deleteNode(args.noteId);
            return { title: "Note dismissed", output: `Deleted note ${args.noteId}.` };
          }

          return { title: "Error", output: `Unknown action: ${action}` };
        },
      }),

      neural_session_read: tool({
        description: "Read messages from another OpenCode session. Use this when the user asks about something from a different session or you need context from past conversations.",
        args: {
          sessionId: z.string().optional().describe("Session ID to read (e.g. 'ses_abc123'). If omitted, lists recent sessions."),
          limit: z.number().int().positive().optional().describe("Max messages to return (default: 20)."),
        },
        async execute(args) {
          if (!client) {
            return { title: "Error", output: "OpenCode client not available." };
          }

          if (!args.sessionId) {
            const sessionsResult = await client.session.list();
            if (!sessionsResult.data) return { title: "Error", output: "Failed to list sessions." };
            const sessions = sessionsResult.data.slice(0, 20);
            const list = sessions.map((s, i) => `${i + 1}. ${s.id} — "${s.title}" (${new Date(s.time.created * 1000).toLocaleDateString()})`).join("\n");
            return { title: `${sessions.length} recent sessions`, output: list };
          }

          const msgsResult = await client.session.messages({ path: { id: args.sessionId }, query: { limit: args.limit ?? 20 } });
          if (!msgsResult.data) return { title: "Error", output: `Failed to read session ${args.sessionId}.` };

          const texts: string[] = [];
          for (const msg of msgsResult.data) {
            const role = msg.info.role;
            for (const part of msg.parts) {
              if (part.type === "text" && (part as { text?: string }).text) {
                const text = (part as { text: string }).text;
                texts.push(`[${role}] ${text.slice(0, 500)}${text.length > 500 ? "..." : ""}`);
              }
            }
          }

          if (texts.length === 0) return { title: "Empty", output: `No text messages found in session ${args.sessionId}.` };
          return {
            title: `${texts.length} messages from ${args.sessionId}`,
            output: texts.join("\n\n"),
            metadata: { sessionId: args.sessionId, messageCount: texts.length },
          };
        },
      }),
    },

    "experimental.chat.messages.transform": magicContextPresent
      ? undefined
      : async (input, output) => {
      try {
        const messages = output.messages;
        if (!messages || messages.length === 0) return;

        const openCodeSessionId = (() => {
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg.info?.role === "user" && typeof msg.info.sessionID === "string") {
              return msg.info.sessionID;
            }
          }
          return sessionId;
        })();
        currentOpenCodeSessionId = openCodeSessionId;

        const estimateTokens = (text: string) => {
          let tokens = 0;
          for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            if (code > 0x4E00 && code < 0x9FFF) tokens += 0.7;
            else if (code > 0x3000 && code < 0x303F) tokens += 0.5;
            else if (code > 0xAC00 && code < 0xD7AF) tokens += 0.7;
            else if (code > 0x3040 && code < 0x30FF) tokens += 0.7;
            else tokens += 0.28;
          }
          return Math.ceil(tokens);
        };

        const FILLER_WORDS = /\b(basically|actually|really|just|very|quite|pretty|somewhat|certainly|definitely|obviously|clearly|simply|literally|honestly|frankly|anyway|so|well|now|then|also|still|already|even)\b/gi;
        const HEDGING = /\b(I think|I believe|I would say|it seems like|it appears that|in my opinion|from my perspective|if you will|sort of|kind of|more or less|to be honest|at the end of the day)\b/gi;
        const PLEASANTRIES = /\b(please|thanks|thank you|kindly|if possible)\b/gi;

        const cavemanCompress = (text: string, level: "lite" | "full" | "ultra"): string => {
          let w = text;
          w = w.replace(FILLER_WORDS, "");
          w = w.replace(HEDGING, "");
          w = w.replace(PLEASANTRIES, "");
          if (level === "full" || level === "ultra") {
            w = w.replace(/\b(the|a|an)\b/gi, "");
            w = w.replace(/\b(is|are|was|were|has been|have been|will be|would be|could be|should be)\b/gi, "");
          }
          if (level === "ultra") {
            w = w.replace(/\b(however|therefore|furthermore|additionally|moreover|nevertheless|consequently)\b/gi, "→");
            w = w.replace(/\bfor example\b/gi, "eg");
            w = w.replace(/\bin order to\b/gi, "to");
            w = w.replace(/\bas well as\b/gi, "&");
          }
          w = w.replace(/  +/g, " ").replace(/\n{3,}/g, "\n\n").trim();
          return w;
        };

        const contextLimit = pluginConfig.contextWindowTokens ?? 128000;
        const EXECUTE_THRESHOLD = 65;
        const HISTORY_BUDGET_PCT = 0.15;
        const PROTECTED_TAGS_COUNT = pluginConfig.protectedTags ?? 20;
        const CLEAR_REASONING_AGE = 50;
        const TRIGGER_BUDGET_PCT = 0.05;
        const TRIGGER_MULTIPLIER = 3;
        const HISTORIAN_CHUNK_PCT = 0.25;
        const FORCE_COMPARTMENT_PCT = 80;
        const TARGET_USAGE_PCT = 0.55;
        const ABORT_PCT = 95;
        const historyBudgetTokens = Math.round(contextLimit * HISTORY_BUDGET_PCT);
        const triggerBudget = Math.max(5000, Math.min(50000, Math.round(contextLimit * TRIGGER_BUDGET_PCT)));

        const realUsage = getContextUsage(openCodeSessionId);
        const estimatedPct = (() => {
          let totalTokens = 0;
          for (const msg of messages) {
            totalTokens += 10;
            for (const part of (msg.parts ?? [])) {
              const text = (part as any).text ?? "";
              if (text) totalTokens += estimateTokens(text);
            }
          }
          return (totalTokens / contextLimit) * 100;
        })();
        const usagePct = realUsage.percentage > 0 ? realUsage.percentage : estimatedPct;

        const lastAssistantModel = (() => {
          for (let i = messages.length - 1; i >= 0; i--) {
            const info = messages[i].info;
            if (info?.role === "assistant" && info.providerID && info.modelID) {
              return { providerID: info.providerID, modelID: info.modelID };
            }
          }
          return null;
        })();

        if (lastAssistantModel && lastModelKey) {
          const newKey = `${lastAssistantModel.providerID}/${lastAssistantModel.modelID}`;
          if (lastModelKey !== newKey) {
            lastModelKey = newKey;
            lastContextPercentage = 0;
            reasoningWatermark = 0;
          }
        } else if (lastAssistantModel) {
          lastModelKey = `${lastAssistantModel.providerID}/${lastAssistantModel.modelID}`;
        }

        if (realUsage.percentage > 0) {
          lastContextPercentage = realUsage.percentage;
        }

        const isMidTurn = (() => {
          if (messages.length === 0) return false;
          const last = messages[messages.length - 1];
          return last.info?.role === "assistant" && (last.parts ?? []).some((p: any) => p.type === "tool_call");
        })();

        let schedulerDecision: "execute" | "defer" | "skip" = "skip";
        if (usagePct >= EXECUTE_THRESHOLD) {
          schedulerDecision = isMidTurn ? "defer" : "execute";
        } else if (usagePct >= EXECUTE_THRESHOLD - 2) {
          schedulerDecision = "defer";
        }

        let compartments = compartmentStore.getForSession(openCodeSessionId);
        let maxCompartOrd = compartments.length > 0 ? compartments[compartments.length - 1].endOrd : -1;

        const rendered: Array<any> = [];

        // Compartments are injected via system.transform — NOT as fake user messages here.
        // This avoids LLM language confusion (English summaries as "user" messages)
        // and double-injection of the same content.

        const tailStart = maxCompartOrd + 1;
        let tail: Array<any>;

        const tailBudgetTokens = Math.round(contextLimit * TARGET_USAGE_PCT);
        if (messages.length <= tailStart) {
          const lastUserIdx = messages.findLastIndex((m: any) => m.info?.role === "user");
          tail = lastUserIdx >= 0 ? messages.slice(lastUserIdx) : messages.slice(-1);
        } else {
          let tailTokens = 0;
          let startIdx = messages.length;
          for (let i = messages.length - 1; i >= tailStart; i--) {
            let msgTokens = 10;
            for (const part of (messages[i].parts ?? [])) {
              const text = (part as any).text ?? "";
              if (text) {
                const effectiveLen = Math.min(text.length, 1000);
                msgTokens += estimateTokens(text.slice(0, effectiveLen));
              }
            }
            if (tailTokens + msgTokens > tailBudgetTokens) break;
            tailTokens += msgTokens;
            startIdx = i;
          }

          if (lastTailStartIdx >= tailStart && lastTailStartIdx <= startIdx + 5 && lastTailStartIdx < messages.length) {
            startIdx = lastTailStartIdx;
          }
          lastTailStartIdx = startIdx;

          tail = messages.slice(startIdx);
          if (tail.length === 0) {
            tail = messages.slice(-1);
          }
        }

        const tailActualStart = messages.length - tail.length;
        let tagCounter = tailActualStart;
        let prevTimestamp = 0;
        const maxTag = tailActualStart + tail.length;
        const protectedFloor = maxTag - PROTECTED_TAGS_COUNT;
        const reasoningCutoff = maxTag - CLEAR_REASONING_AGE;

        const seenToolOutputs = new Map<string, number>();
        const toolFingerprints = new Map<string, number[]>();

        for (let i = 0; i < tail.length; i++) {
          const msg = tail[i];
          if (msg.info?.role === "tool" || ((msg.parts ?? []).some((p: any) => p.type === "tool_call"))) {
            const toolName = msg.info?.toolName ?? msg.info?.tool ?? (msg.parts ?? []).find((p: any) => p.type === "tool_call")?.name ?? "";
            const inputText = (msg.parts ?? []).map((p: any) => p.text ?? JSON.stringify(p.input ?? "")).join("").slice(0, 300);
            const fingerprint = `${toolName}:${inputText}`;
            const group = toolFingerprints.get(fingerprint) ?? [];
            group.push(i);
            toolFingerprints.set(fingerprint, group);
          }
        }

        const toolDropIndices = new Set<number>();
        for (const [, indices] of toolFingerprints) {
          if (indices.length <= 1) continue;
          for (let k = 0; k < indices.length - 1; k++) {
            const idx = indices[k];
            if (tailActualStart + idx <= protectedFloor) {
              toolDropIndices.add(idx);
            }
          }
        }

        const STRUCTURAL_NOISE_TYPES = new Set(["meta", "step-start", "step-finish"]);

        for (let i = 0; i < tail.length; i++) {
          const msg = tail[i];
          for (let pi = 0; pi < (msg.parts ?? []).length; pi++) {
            const part = msg.parts[pi];
            if (STRUCTURAL_NOISE_TYPES.has(part?.type)) {
              msg.parts[pi] = { type: "text", text: "" };
            }
          }
        }

        const cavemanEligibleCount = Math.max(0, tail.length - PROTECTED_TAGS_COUNT);
        for (let i = 0; i < cavemanEligibleCount; i++) {
          const msg = tail[i];
          if (msg.info?.role !== "user" && msg.info?.role !== "assistant") continue;
          const fraction = i / cavemanEligibleCount;
          let level: "lite" | "full" | "ultra" | null = null;
          if (fraction < 0.2) level = "ultra";
          else if (fraction < 0.4) level = "full";
          else if (fraction < 0.6) level = "lite";
          if (!level) continue;
          for (const part of (msg.parts ?? [])) {
            if (part.type === "text" && part.text && part.text.length > 200) {
              part.text = cavemanCompress(part.text, level);
            }
          }
        }

        let prevRole = "";
        for (let i = 0; i < tail.length; i++) {
          const msg = tail[i];
          tagCounter++;

          if (droppedTags.has(tagCounter) || toolDropIndices.has(i)) {
            rendered.push({
              info: msg.info,
              parts: [{ type: "text", text: "" }],
            });
            prevRole = msg.info?.role ?? "";
            continue;
          }

          const isProtected = tagCounter > protectedFloor;
          const ts = msg.info?.time?.created ? msg.info.time.created * 1000 : 0;

          if (prevTimestamp > 0 && ts > 0 && msg.info?.role === "user") {
            const gap = ts - prevTimestamp;
            if (gap > 5 * 60 * 1000) {
              const minutes = Math.round(gap / 60000);
              let label: string;
              if (minutes < 60) label = `+${minutes}m`;
              else if (minutes < 1440) label = `+${Math.floor(minutes / 60)}h ${minutes % 60}m`;
              else label = `+${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
              for (const part of (msg.parts ?? [])) {
                if (part.type === "text" && part.text) {
                  part.text = `<!-- ${label} -->\n${part.text}`;
                  break;
                }
              }
            }
          }
          if (ts > 0) prevTimestamp = ts;

          if (!isProtected && msg.info?.role === "assistant") {
            if (tagCounter <= reasoningCutoff || tagCounter <= reasoningWatermark) {
              for (let pi = 0; pi < (msg.parts ?? []).length; pi++) {
                const part = msg.parts[pi];
                if (part.type === "reasoning" || part.type === "thinking") {
                  msg.parts[pi] = { type: "text", text: "" };
                }
              }
              for (const part of (msg.parts ?? [])) {
                if (part.type === "text" && part.text) {
                  part.text = part.text.replace(/<(?:thinking|think)>[\s\S]*?<\/(?:thinking|think)>\s*/g, "").trim();
                }
              }
            }

            const firstInRun = prevRole !== "assistant";
            if (!firstInRun) {
              for (let pi = 0; pi < (msg.parts ?? []).length; pi++) {
                const part = msg.parts[pi];
                if (part.type === "reasoning" || part.type === "thinking") {
                  msg.parts[pi] = { type: "text", text: "" };
                }
              }
            }
          }

          if (!isProtected && (msg.info?.role === "tool" || msg.info?.role === "assistant")) {
            for (let pi = 0; pi < (msg.parts ?? []).length; pi++) {
              const part = msg.parts[pi];
              if (part.type === "tool" && part.state?.status === "error" && typeof part.state.error === "string" && part.state.error.length > 100) {
                part.state.error = part.state.error.slice(0, 100) + "... [truncated]";
              }
              if (part.type === "text" || part.type === "tool_result") {
                const text = part.text ?? "";
                if (text.length > 300) {
                  const toolName = msg.info?.toolName ?? msg.info?.tool ?? "";
                  const dedupeKey = `${toolName}:${text.slice(0, 200)}`;
                  const prevIdx = seenToolOutputs.get(dedupeKey);
                  if (prevIdx !== undefined && prevIdx !== i) {
                    part.text = "";
                  } else {
                    seenToolOutputs.set(dedupeKey, i);
                    let compressed = text.slice(0, 600);
                    compressed = compressed.replace(/\n{3,}/g, "\n\n");
                    compressed = compressed.replace(/^[ \t]+/gm, "");
                    compressed = compressed.replace(/(.{1,80})\1{2,}/g, "$1 [×repeated]");
                    part.text = compressed + (text.length > 600 ? "\n...[truncated]..." : "");
                  }
                }
              }
              if (part.type === "tool_call" && part.name === "neural_reduce" && tagCounter <= protectedFloor - 5) {
                msg.parts[pi] = { type: "text", text: "" };
              }
            }
          }

          for (const part of (msg.parts ?? [])) {
            if (part.type === "text" && part.text !== undefined && part.text !== "" && !part.text.startsWith("§")) {
              part.text = `§${tagCounter}§ ${part.text}`;
              break;
            }
          }

          rendered.push(msg);
          prevRole = msg.info?.role ?? "";
        }

        if (schedulerDecision === "execute" && !isMidTurn) {
          const newWatermark = maxTag - CLEAR_REASONING_AGE;
          if (newWatermark > reasoningWatermark) {
            reasoningWatermark = newWatermark;
            try {
              rawStorage.getDb().prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES ('reasoning_watermark', ?)`).run(String(newWatermark));
            } catch {}
          }
        }

        if (rendered.length > 0) {
          const skippedCount = tailActualStart - tailStart;
          if (skippedCount > 20) {
            const skippedSummaries: string[] = [];
            for (let i = tailStart; i < tailActualStart; i++) {
              const m = messages[i];
              if (m.info?.role !== "user") continue;
              const text = (m.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => (p as { text?: string }).text ?? "").join(" ").trim();
              if (text.length < 5) continue;
              skippedSummaries.push(text.slice(0, 80));
              if (skippedSummaries.length >= 50) break;
            }
            if (skippedSummaries.length > 0) {
              const summaryMsg = {
                info: { role: "user" },
                parts: [{ type: "text", text: `<earlier-topics count="${skippedCount} messages not shown">\n${skippedSummaries.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n</earlier-topics>` }]
              };
              rendered.unshift(summaryMsg);
            }
          }
          messages.splice(0, messages.length, ...rendered);
          try {
            writeFileSync("/tmp/neural-rendered-sample.json", JSON.stringify({
              ts: Date.now(),
              renderedCount: rendered.length,
              firstMsg: rendered[0] ? { role: rendered[0].info?.role, partsCount: rendered[0].parts?.length, partTypes: (rendered[0].parts ?? []).map((p: any) => p.type) } : null,
              lastMsg: rendered[rendered.length - 1] ? { role: rendered[rendered.length - 1].info?.role, partsCount: rendered[rendered.length - 1].parts?.length, partTypes: (rendered[rendered.length - 1].parts ?? []).map((p: any) => p.type) } : null,
            }, null, 2));
          } catch {}
        } else if (messages.length > 0) {
          messages.splice(0, messages.length - 1);
        }

        historianTurnCount++;
        const tailCount = Math.max(0, tail.length - PROTECTED_TAGS_COUNT);
        const tailTokensEstimate = tailCount * 500;

        const hasUncoveredNewMessages = (() => {
          if (lastCompressTime === 0) return false;
          for (let i = maxCompartOrd + 1; i < messages.length; i++) {
            const msgTime = messages[i].info?.time?.created ? messages[i].info.time.created * 1000 : 0;
            if (msgTime > lastCompressTime) return true;
          }
          return false;
        })();

        const shouldFireHistorian = (() => {
          if (!historian) return false;
          if (hasUncoveredNewMessages && tailCount > 6) return true;
          if (usagePct >= FORCE_COMPARTMENT_PCT) return true;
          if (tailTokensEstimate >= triggerBudget * TRIGGER_MULTIPLIER) return true;
          if (usagePct >= EXECUTE_THRESHOLD - 2 && tailCount > 6) return true;
          return false;
        })();

        if (shouldFireHistorian && maxCompartOrd < messages.length - PROTECTED_TAGS_COUNT - 1) {
          const tailStartIdx = Math.max(0, maxCompartOrd + 1);
          const historianChunkTokens = Math.max(8000, Math.min(50000, Math.round(contextLimit * 0.25)));
          const chunkSize = Math.min(Math.round(historianChunkTokens / 500), tailCount);
          const windowMsgs = messages.slice(tailStartIdx, tailStartIdx + chunkSize).map((m: any, idx: number) => {
            const textParts = (m.parts ?? []).filter((p: any) => p.type === "text");
            const content = textParts.map((p: any) => p.text ?? "").join("\n").slice(0, 1000);
            return { role: (m.info?.role ?? "user") as string, content, ord: tailStartIdx + idx };
          });

          if (usagePct >= FORCE_COMPARTMENT_PCT && !isMidTurn) {
            writeFileSync("/tmp/neural-compress-notify.txt", `⏳ Context at ${Math.round(usagePct)}% — compressing history...`);
            try {
              const compressPromise = (historian as any).compress(openCodeSessionId, windowMsgs);
              const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 60000));
              const result = await Promise.race([compressPromise, timeoutPromise]).catch(() => null) as any;
              if (result) {
                compartmentStore.save(result);
                lastCompressTime = Date.now();
                try { rawStorage.getDb().prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES ('last_compress_time', ?)`).run(String(lastCompressTime)); } catch {}
              }
            } catch {}
          } else if (usagePct >= ABORT_PCT) {
            try {
              await client.session.abort?.({ path: { id: currentOpenCodeSessionId || sessionId } });
            } catch {}
            try {
              const compressPromise = (historian as any).compress(openCodeSessionId, windowMsgs);
              const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 60000));
              const result = await Promise.race([compressPromise, timeoutPromise]).catch(() => null) as any;
              if (result) {
                compartmentStore.save(result);
                lastCompressTime = Date.now();
                try { rawStorage.getDb().prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES ('last_compress_time', ?)`).run(String(lastCompressTime)); } catch {}
              }
            } catch {}
          } else {
            (async () => {
              try {
                const childSession = await client.session.create({});
                if (!childSession.data) return;
                const childId = childSession.data.id;

                const historianPrompt = `You compress conversation history into three fidelity tiers.
Output STRICT JSON: { "p1": "...", "p2": "...", "p3": "..." }

p1: One paragraph (≤150 tokens). Capture: user goals, decisions made, files/symbols touched, errors hit, current state. Past tense. No filler.
p2: One sentence (≤25 tokens). The single most important thing that happened.
p3: A title (≤8 tokens). Like a git commit subject.

IMPORTANT: Write p1, p2, p3 in the SAME LANGUAGE the user uses in the conversation. If user writes Chinese, output Chinese. If English, output English.
Preserve concrete identifiers verbatim: file paths, function names, error strings. Drop pleasantries and tool boilerplate.

CONVERSATION:
${windowMsgs.map(m => `[${m.role}]: ${m.content}`).join("\n\n")}

JSON:`;

                await client.session.promptAsync({
                  path: { id: childId },
                  body: { parts: [{ type: "text", text: historianPrompt }] },
                });

                await new Promise(r => setTimeout(r, 15000));

                const childMsgs = await client.session.messages({ path: { id: childId }, query: { limit: 5 } });
                if (childMsgs.data) {
                  for (const msg of childMsgs.data) {
                    if (msg.info.role !== "assistant") continue;
                    for (const part of msg.parts) {
                      if (part.type !== "text") continue;
                      const text = (part as { text?: string }).text ?? "";
                      const jsonMatch = text.match(/\{[\s\S]*\}/);
                      if (!jsonMatch) continue;
                      try {
                        const parsed = JSON.parse(jsonMatch[0]);
                        if (parsed.p1 && parsed.p2 && parsed.p3) {
                          compartmentStore.save({
                            sessionId: openCodeSessionId,
                            startOrd: windowMsgs[0].ord,
                            endOrd: windowMsgs[windowMsgs.length - 1].ord,
                            p1: String(parsed.p1),
                            p2: String(parsed.p2),
                            p3: String(parsed.p3),
                            tokenCount: Math.round(windowMsgs.reduce((s, m) => s + m.content.length, 0) / 4),
                            createdAt: Date.now(),
                          });
                          historianFailureCount = 0;
                          lastCompressTime = Date.now();
                          try { rawStorage.getDb().prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES ('last_compress_time', ?)`).run(String(lastCompressTime)); } catch {}

                          try {
                            await engine.remember(
                              `[${parsed.p3}] ${parsed.p1}`,
                              "episode",
                              { importance: 0.6, metadata: { sourceSession: sessionId, startOrd: windowMsgs[0].ord, endOrd: windowMsgs[windowMsgs.length - 1].ord } }
                            );
                          } catch {}
                        }
                      } catch {
                        historianFailureCount++;
                      }
                    }
                  }
                }

                try { await client.session.delete({ path: { id: childId } }); } catch {}
              } catch {
                historianFailureCount++;
              }
            })();
          }
        }

        setTimeout(async () => {
          try {
            const linker = new LightweightLinker(rawStorage);
            const lastMsgs = messages.slice(-2);
            for (const msg of lastMsgs) {
              const role = msg.info?.role;
              if (role !== "user" && role !== "assistant") continue;
              const textParts = (msg.parts ?? []).filter((p: any) => p.type === "text");
              const content = textParts.map((p: any) => p.text ?? "").join("\n").trim();
              if (content.length < 10 || content.length > 3000) continue;
              turnCounter++;
              const node = {
                id: crypto.randomUUID(),
                type: "episode" as const,
                content: content.slice(0, 2000),
                importance: role === "user" ? 0.6 : 0.5,
                strength: 0.5,
                accessCount: 0,
                lastAccessed: Date.now(),
                createdAt: Date.now(),
                sourceSession: sessionId,
              };
              await storage.putNode(node);
              await linker.linkToExisting(node);
            }
          } catch {}
        }, 500);

        const afterPct = (() => {
          let totalTokens = 0;
          for (const msg of messages) {
            totalTokens += 10;
            for (const part of (msg.parts ?? [])) {
              const text = (part as any).text ?? "";
              if (text) totalTokens += estimateTokens(text);
            }
          }
          return Math.round((totalTokens / contextLimit) * 100);
        })();
        writeFileSync("/tmp/neural-compartment-status.json", JSON.stringify({
          ts: Date.now(),
          beforePct: Math.round(usagePct || (messages.length * 500 / contextLimit) * 100),
          afterPct,
          compartments: compartments.length,
          scheduler: schedulerDecision,
          historianFailures: historianFailureCount,
          openCodeSessionId,
          realUsagePct: realUsage.percentage,
          msgCount: messages.length,
          renderedCount: rendered.length,
          msgSizes: messages.slice(0, 5).map((m: any) => JSON.stringify(m.parts ?? []).length),
        }));
      } catch {}
      if (output.messages) {
        const hasContent = output.messages.some((m: any) =>
          (m.parts ?? []).some((p: any) => p.type === "text" && p.text && p.text.trim().length > 0)
        );
        if (!hasContent) {
          output.messages.length = 0;
          output.messages.push({ info: { role: "user" }, parts: [{ type: "text", text: "." }] });
        }
      }
    },

    "experimental.chat.system.transform": async (_input, output) => {
      try {
        writeFileSync("/tmp/neural-system-transform.log", `${Date.now()} start\n`);
        const facts = await storage.queryNodes({ type: "fact" });
        writeFileSync("/tmp/neural-system-transform.log", `${Date.now()} facts=${facts.length}\n`);
        const relevantFacts = facts.filter((f) => {
          const fd = f.metadata?.factData as Record<string, unknown> | undefined;
          if (!fd) return false;
          if (fd.scope === "session") return f.sourceSession === sessionId;
          return true;
        });

        const blocks: string[] = [];

        if (!magicContextPresent) {
          const sysSessionId = currentOpenCodeSessionId || sessionId;
          const compartments = compartmentStore.getForSession(sysSessionId);
          if (compartments.length > 0) {
            blocks.push("<session-history>");
            for (const c of compartments) {
              blocks.push(`<compartment start="${c.startOrd}" end="${c.endOrd}" title="${c.p3}">`);
              blocks.push(c.p1);
              blocks.push("</compartment>");
            }
            blocks.push("</session-history>");
          }
        }

        if (relevantFacts.length > 0) {
          blocks.push("");
          blocks.push("<project-memory>");
          for (const f of relevantFacts) {
            const fd = f.metadata?.factData as Record<string, unknown> | undefined;
            blocks.push(`  <memory id="${f.id.slice(0, 8)}" category="${fd?.scope ?? "global"}">${f.content}</memory>`);
          }
          blocks.push("</project-memory>");
        }

        if (blocks.length > 0) {
          const blockText = blocks.join("\n");
          const blockHash = createHash("md5").update(blockText).digest("hex");
          if (blockHash !== lastSystemHash) {
            lastSystemHash = blockHash;
          }
          output.system.unshift(blockText);
        }
      } catch {}
    },

    "command.execute.before": async (input: any, output: any) => {
      try {
        const command = input?.command;
        if (command === "ctx-status" || command === "neural-status") {
          const usage = getContextUsage(sessionId);
          const compartments = compartmentStore.getForSession(sessionId);
          const stats = await engine.getStats();
          output.response = [
            `## Neural Context Status`,
            `Context: ${usage.percentage.toFixed(1)}% (${usage.inputTokens} tokens)`,
            `Nodes: ${stats.nodeCount} | Edges: ${stats.edgeCount}`,
            `Compartments: ${compartments.length}`,
            `Historian failures: ${historianFailureCount}`,
            `Reasoning watermark: ${reasoningWatermark}`,
            `Model: ${lastModelKey || "unknown"}`,
          ].join("\n");
          output.handled = true;
        } else if (command === "ctx-recomp" || command === "neural-recomp") {
          if (historian) {
            const messages = (await client.session.messages({ path: { id: currentOpenCodeSessionId || sessionId }, query: { limit: 50 } })).data ?? [];
            const maxOrd = compartmentStore.getMaxOrd(sessionId);
            const uncovered = messages.slice(maxOrd + 1, maxOrd + 13);
            const windowMsgs = uncovered.map((m: any, idx: number) => {
              const textParts = (m.parts ?? []).filter((p: any) => p.type === "text");
              const content = textParts.map((p: any) => p.text ?? "").join("\n").slice(0, 1000);
              return { role: m.info.role as string, content, ord: maxOrd + 1 + idx };
            });
            if (windowMsgs.length >= 6) {
              const result = await (historian as any).compress(sessionId, windowMsgs);
              if (result) {
                compartmentStore.save(result);
                output.response = `Recompacted: created compartment covering ordinals ${result.startOrd}-${result.endOrd}`;
              } else {
                output.response = "Recompaction failed — historian returned null.";
              }
            } else {
              output.response = "Not enough uncovered messages to recompact (need >= 6).";
            }
          } else {
            output.response = "Historian not available (no LLM configured).";
          }
          output.handled = true;
        }
      } catch {}
    },

    event: async (input: any) => {
      try {
        const eventType = input?.event?.type ?? "unknown";
        if (eventType !== "session.status") return;
        const props = input.event.properties;
        if (props?.status?.type !== "idle") return;
        const sid = props?.sessionID;
        if (!sid) return;
        if (!sid) return;

        const transcriptDir = join(homedir(), ".local", "share", "ai-agent-local-memory", "transcripts");
        const { mkdirSync } = await import("node:fs");
        mkdirSync(transcriptDir, { recursive: true });
        const transcriptPath = join(transcriptDir, `${sid}.md`);

        const existingLines = existsSync(transcriptPath) ? readFileSync(transcriptPath, "utf-8").split("\n").length : 0;

        const msgsResult = await client.session.messages({ path: { id: sid }, query: {} });
        if (!msgsResult.data) return;

        const allMessages: string[] = [];
        for (const msg of msgsResult.data) {
          const role = msg.info.role;
          const textParts = (msg.parts ?? []).filter((p: any) => p.type === "text");
          const content = textParts.map((p: any) => (p as { text?: string }).text ?? "").join("\n").trim();
          if (!content) continue;
          allMessages.push(`[${role}] ${content}\n\n---\n`);
        }

        const fullContent = allMessages.join("\n");
        const newLineCount = fullContent.split("\n").length;

        if (newLineCount > existingLines) {
          writeFileSync(transcriptPath, fullContent);
        }
      } catch {}
    },
  };
};

export default {
  id: "ai-agent-local-memory",
  server: AIAgentLocalMemoryPlugin,
};
