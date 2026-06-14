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
      return `${i + 1}. [${r.node.type}] (score=${r.score.toFixed(3)}) ${r.node.id}${path}\n   ${r.node.content}`;
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

  // historian, gap backfill, and sync disabled for stability
  // TODO: re-enable after memory optimization

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

  const renderConfig: ContextRenderConfig = {
    contextWindowTokens: pluginConfig.contextWindowTokens ?? 128000,
    budgetRatio: pluginConfig.budgetRatio ?? 0.6,
  };

  const graph = new NeuralGraph(storage);
  const workingMemory = new WorkingMemory();
  const renderer = new ContextRenderer(graph, workingMemory, storage, renderConfig);

  let turnCounter = 0;

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
            output: `Marked ${suppressed} episodic node(s) as suppressed (requested tags: ${tags.join(", ")}).`,
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
              const msgsResult = await client.session.messages({ path: { id: sessionId }, query: {} });
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
              return { title: "Pulled", output: `Remote changes pulled.\nApplied: ${result.applied} operations, Skipped: ${result.skipped} (own machine).` };
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
              opLog.append({ ts: node.createdAt || Date.now(), machine: opLog.machineId, op: "add_node", data: node });
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
        const messages = output.messages ?? [];
        const beforeCount = messages.length;
        if (messages.length === 0) return;

        const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);
        const CONTEXT_BUDGET = (pluginConfig.contextWindowTokens ?? 128000) * (pluginConfig.budgetRatio ?? 0.15);
        const RECENT_FULL_COUNT = 20;
        const TRIGGER_BUDGET_PCT = 0.05;
        const TRIGGER_MULTIPLIER = 3;
        const HISTORIAN_CHUNK_PCT = 0.25;
        const HISTORIAN_CHUNK_MIN = 8000;
        const HISTORIAN_CHUNK_MAX = 50000;

        let compartments = compartmentStore.getForSession(sessionId);
        let maxCompartOrd = compartments.length > 0 ? compartments[compartments.length - 1].endOrd : -1;

        const rendered: Array<any> = [];

        for (const c of compartments) {
          let text: string;
          const p1Tokens = estimateTokens(c.p1);
          if (p1Tokens < CONTEXT_BUDGET * 0.3) {
            text = c.p1;
          } else {
            text = c.p2;
          }
          rendered.push({
            info: { role: "user" },
            parts: [{ type: "text", text: `<session-history>\n<compartment start="${c.startOrd}" end="${c.endOrd}">\n${text}\n</compartment>\n</session-history>` }],
          });
        }

        const tailStart = maxCompartOrd + 1;
        const tail = messages.slice(tailStart);
        const MAX_TAIL = 30;
        const trimmedTail = tail.length > MAX_TAIL ? tail.slice(-MAX_TAIL) : tail;
        for (const msg of trimmedTail) rendered.push(msg);

        output.messages.length = 0;
        for (const msg of rendered) output.messages.push(msg);

        historianTurnCount++;
        const contextLimit = pluginConfig.contextWindowTokens ?? 128000;
        const triggerBudget = Math.max(5000, Math.min(50000, Math.round(contextLimit * TRIGGER_BUDGET_PCT)));
        const tailCount = Math.max(0, messages.length - RECENT_FULL_COUNT - (maxCompartOrd + 1));
        const tailTokensEstimate = tailCount * 500;
        
        if (historian && tailTokensEstimate >= triggerBudget * TRIGGER_MULTIPLIER) {
          const tailStartIdx = Math.max(0, maxCompartOrd + 1);
          const chunkSize = Math.min(12, tailCount);
          const windowMsgs = messages.slice(tailStartIdx, tailStartIdx + chunkSize).map((m: any, idx: number) => {
            const textParts = m.parts.filter((p: any) => p.type === "text");
            const content = textParts.map((p: any) => p.text ?? "").join("\n").slice(0, 1000);
            return { role: m.info.role as string, content, ord: tailStartIdx + idx };
          });
          setTimeout(async () => {
            try {
              const result = await (historian as any).compress(sessionId, windowMsgs);
              if (result) compartmentStore.save(result);
            } catch {}
          }, 100);
        }

        const afterTokens = Math.round(totalTokens);
        const beforePct = Math.round((messages.length * 500 / contextLimit) * 100);
        const afterPct = Math.round((afterTokens / contextLimit) * 100);
        setTimeout(async () => {
          try {
            const linker = new LightweightLinker(rawStorage);
            const lastMsgs = messages.slice(-2);
            for (const msg of lastMsgs) {
              const role = msg.info?.role;
              if (role !== "user" && role !== "assistant") continue;
              const textParts = msg.parts.filter((p: any) => p.type === "text");
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

        writeFileSync("/tmp/neural-compartment-status.json", JSON.stringify({
          ts: Date.now(),
          beforePct,
          afterPct,
          compartments: compartments.length,
        }));
      } catch {}
    },

    "experimental.chat.system.transform": async (_input, output) => {
      try {
        const usageGuide = [
          "",
          "## Neural Associative Memory",
          "You have access to a neural associative memory system that finds related concepts by graph traversal, not just keyword match.",
          "- `neural_recall` — Find memories by ASSOCIATION. Discovers related concepts via spreading activation across a neural graph. Better than keyword search for 'what else relates to X?'",
          "- `neural_remember` — Store important concepts, decisions, or facts for later associative recall.",
          "- `neural_note` — Save durable facts/notes (session/project/global scope) that survive compression.",
          "- `neural_reduce` — Drop tagged content (e.g. neural_reduce(drop=\"3-5\")).",
          "- `neural_pin` — Pin tagged content to always show at full fidelity.",
          "- `neural_expand` — Expand compressed/elided content back to full text. When you see `<compartment start=\"N\" end=\"M\">`, call neural_expand(start=N, end=M) to retrieve the original messages. Use this whenever the user asks to see earlier conversation details.",
          "",
          "IMPORTANT: When you are unsure about user preferences, past decisions, project conventions, or anything discussed in previous sessions, ALWAYS call `neural_recall` first to check if relevant knowledge exists in memory. Do not guess — recall first, then act.",
          "IMPORTANT: When the user shares personal preferences, facts about themselves, decisions, or anything worth remembering long-term (e.g. 'my favorite X is Y', 'I prefer Z', 'remember that...'), ALWAYS call `neural_remember` to store it. This ensures cross-session memory.",
          "If the user asks about something from another session, use `neural_session_read` to look up that session's conversation directly.",
        ].join("\n");
        output.system.push(usageGuide);
      } catch {}
    },
  };
};

export default {
  id: "ai-agent-local-memory",
  server: AIAgentLocalMemoryPlugin,
};
