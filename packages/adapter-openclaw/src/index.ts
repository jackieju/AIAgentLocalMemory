import { join } from "node:path";
import { homedir } from "node:os";
import { Type } from "@sinclair/typebox";
import { NeuralContextEngine, LightweightLinker } from "@ai-agent-local-memory/core";
import { SqliteStorageProvider } from "@ai-agent-local-memory/storage-sqlite";

interface NeuralContextConfig {
  storageDir?: string;
  autoRecall: boolean;
  autoCapture: boolean;
  maxRecallResults: number;
  debug: boolean;
}

function parseConfig(raw: unknown): NeuralContextConfig {
  const cfg = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    storageDir: typeof cfg.storageDir === "string" ? cfg.storageDir : undefined,
    autoRecall: cfg.autoRecall !== false,
    autoCapture: cfg.autoCapture !== false,
    maxRecallResults: typeof cfg.maxRecallResults === "number" ? cfg.maxRecallResults : 10,
    debug: cfg.debug === true,
  };
}

function getStoragePath(cfg: NeuralContextConfig): string {
  if (cfg.storageDir) return cfg.storageDir;
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "ai-agent-local-memory");
}

type OpenClawPluginApi = {
  logger: { info: (...args: unknown[]) => void; debug: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
  pluginConfig: unknown;
  registerTool: (def: Record<string, unknown>, opts?: Record<string, unknown>) => void;
  registerMemoryCapability?: (cap: Record<string, unknown>) => void;
  registerMemoryPromptSection?: (builder: (params: { availableTools: Set<string> }) => string[]) => void;
  registerMemoryRuntime?: (runtime: Record<string, unknown>) => void;
  on: (event: string, handler: (...args: unknown[]) => unknown) => void;
  registerService?: (service: Record<string, unknown>) => void;
};

let engine: NeuralContextEngine;
let storage: SqliteStorageProvider;
let linker: LightweightLinker;

function buildPromptSection(params: { availableTools: Set<string> }): string[] {
  const hasRecall = params.availableTools.has("neural_recall");
  const hasRemember = params.availableTools.has("neural_remember");
  const hasNote = params.availableTools.has("neural_note");
  if (!hasRecall && !hasRemember && !hasNote) return [];

  const lines: string[] = [
    "## Neural Associative Memory",
    "",
    "Memory is managed by a neural-network-inspired graph engine with spreading activation.",
    "Memories are found by ASSOCIATION — traversing neural connections to discover related concepts.",
    "",
  ];

  if (hasRecall) {
    lines.push("- neural_recall: Find memories by association. Better than keyword search for 'what else relates to X?'");
  }
  if (hasRemember) {
    lines.push("- neural_remember: Store important information for later associative recall.");
  }
  if (hasNote) {
    lines.push("- neural_note: Save durable facts/notes (session/project/global scope) that persist.");
  }
  lines.push("");

  return lines;
}

function buildMemoryRuntime() {
  return {
    async getMemorySearchManager() {
      return {
        manager: {
          status() {
            return {
              backend: "builtin" as const,
              provider: "neural-context",
              model: "spreading-activation",
              custom: { transport: "local" },
            };
          },
          async probeEmbeddingAvailability() { return { ok: true }; },
          async probeVectorAvailability() { return true; },
          async sync() {},
          async close() {},
        },
      };
    },
    resolveMemoryBackendConfig() {
      return { backend: "builtin" as const };
    },
  };
}

function buildRecallHandler(cfg: NeuralContextConfig) {
  return async (event: Record<string, unknown>) => {
    const rawPrompt = event.prompt as string | undefined;
    if (!rawPrompt || rawPrompt.length < 3) return;

    try {
      const results = await engine.recall(rawPrompt);
      if (results.length === 0) return;

      const top = results.slice(0, cfg.maxRecallResults);
      const lines = top.map((r) => `- [${r.node.type}] ${r.node.content}`);
      const context = `<neural-context>\nRelevant memories from neural associative graph (spreading activation):\n${lines.join("\n")}\n</neural-context>`;

      if (cfg.debug) {
        console.log(`[neural-context] injecting ${top.length} memories`);
      }

      return { prependContext: context };
    } catch (err) {
      console.error("[neural-context] recall failed:", err);
      return;
    }
  };
}

function buildCaptureHandler(cfg: NeuralContextConfig) {
  return async (event: Record<string, unknown>) => {
    if (!event.success || !Array.isArray(event.messages) || event.messages.length === 0) return;

    const messages = event.messages as Array<Record<string, unknown>>;
    const texts: Array<{ role: string; content: string }> = [];

    for (const msg of messages.slice(-4)) {
      const role = msg.role as string;
      if (role !== "user" && role !== "assistant") continue;

      let content = "";
      if (typeof msg.content === "string") {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        content = (msg.content as Array<Record<string, unknown>>)
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text as string)
          .join("\n");
      }

      if (content.length >= 10) {
        content = content
          .replace(/<neural-context>[\s\S]*?<\/neural-context>\s*/g, "")
          .trim();
        if (content.length >= 10) {
          texts.push({ role, content });
        }
      }
    }

    if (texts.length === 0) return;

    try {
      for (const { content } of texts) {
        const node = await engine.remember(content, "episode", { importance: 0.5 });
        await linker.linkToExisting(node);
      }
      if (cfg.debug) {
        console.log(`[neural-context] captured ${texts.length} messages`);
      }
    } catch (err) {
      console.error("[neural-context] capture failed:", err);
    }
  };
}

export default {
  id: "neural-context",
  name: "Neural Context Engine",
  description: "Neural-network-inspired associative memory with spreading activation",
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    const cfg = parseConfig(api.pluginConfig);
    const storagePath = getStoragePath(cfg);
    const episodesDir = join(storagePath, "episodes");

    storage = new SqliteStorageProvider();
    engine = new NeuralContextEngine();
    linker = new LightweightLinker(storage);

    engine.init({ storage, projectId: "global", episodesDir }).then(() => {
      api.logger.info("neural-context: engine initialized");
    }).catch((err) => {
      api.logger.error("neural-context: init failed", err);
    });

    if (typeof api.registerMemoryCapability === "function") {
      api.registerMemoryCapability({
        runtime: buildMemoryRuntime(),
        promptBuilder: buildPromptSection,
        flushPlanResolver: () => null,
      });
    } else {
      api.registerMemoryRuntime?.(buildMemoryRuntime());
      api.registerMemoryPromptSection?.(buildPromptSection);
    }



    api.registerTool({
      name: "neural_recall",
      label: "Neural Recall",
      description: "Find memories by ASSOCIATION — follows neural connections to discover related concepts you didn't explicitly search for. Unlike keyword search, this traverses a graph of concepts via spreading activation.",
      parameters: Type.Object({
        query: Type.String({ description: "Natural language query" }),
        maxResults: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
      }),
      async execute(_id: string, params: { query: string; maxResults?: number }) {
        const results = await engine.recall(params.query);
        const top = results.slice(0, params.maxResults ?? 10);
        if (top.length === 0) {
          return { content: [{ type: "text" as const, text: "No relevant memories found." }] };
        }
        const text = top.map((r, i) =>
          `${i + 1}. [${r.node.type}] ${r.node.content} (score: ${r.score.toFixed(3)})`
        ).join("\n");
        return { content: [{ type: "text" as const, text: `Found ${top.length} memories:\n\n${text}` }] };
      },
    }, { name: "neural_recall" });

    api.registerTool({
      name: "neural_remember",
      label: "Neural Remember",
      description: "Store important information for later associative recall. Creates a node in the neural graph and links it to existing related concepts.",
      parameters: Type.Object({
        content: Type.String({ description: "The content to remember" }),
        type: Type.Optional(Type.String({ description: "Node type: concept, assertion, definition, fact, episode, meta (default: concept)" })),
        importance: Type.Optional(Type.Number({ description: "Importance 0-1 (default: 0.7)" })),
      }),
      async execute(_id: string, params: { content: string; type?: string; importance?: number }) {
        const nodeType = (params.type || "concept") as any;
        const node = await engine.remember(params.content, nodeType, { importance: params.importance ?? 0.7 });
        await linker.linkToExisting(node);
        return { content: [{ type: "text" as const, text: `Stored: "${node.content.slice(0, 80)}..." (id: ${node.id})` }] };
      },
    }, { name: "neural_remember" });

    api.registerTool({
      name: "neural_forget",
      label: "Neural Forget",
      description: "Remove a memory node by its ID.",
      parameters: Type.Object({
        nodeId: Type.String({ description: "ID of the node to delete" }),
      }),
      async execute(_id: string, params: { nodeId: string }) {
        await storage.deleteNode(params.nodeId);
        return { content: [{ type: "text" as const, text: `Deleted node ${params.nodeId}` }] };
      },
    }, { name: "neural_forget" });

    api.registerTool({
      name: "neural_note",
      label: "Neural Note",
      description: "Save durable facts/notes that persist across sessions. Scope: session, project, or global.",
      parameters: Type.Object({
        content: Type.String({ description: "Note text" }),
        scope: Type.Optional(Type.String({ description: "session, project, or global (default: project)" })),
      }),
      async execute(_id: string, params: { content: string; scope?: string }) {
        const node = await engine.remember(params.content, "fact", { importance: 0.9 });
        await linker.linkToExisting(node);
        return { content: [{ type: "text" as const, text: `Note saved: "${params.content.slice(0, 80)}..."` }] };
      },
    }, { name: "neural_note" });

    api.registerTool({
      name: "neural_status",
      label: "Neural Status",
      description: "Get neural context engine statistics and working memory overview.",
      parameters: Type.Object({}),
      async execute() {
        const allNodes = await storage.getAllNodes();
        const allEdges = await storage.getAllEdges();
        const wm = engine.getWorkingMemory();
        const text = [
          `Nodes: ${allNodes.length}`,
          `Edges: ${allEdges.length}`,
          `Working memory: ${wm.length} items`,
          `Types: ${Object.entries(allNodes.reduce((acc: Record<string, number>, n) => { acc[n.type] = (acc[n.type] || 0) + 1; return acc; }, {})).map(([k, v]) => `${k}=${v}`).join(", ")}`,
        ].join("\n");
        return { content: [{ type: "text" as const, text }] };
      },
    }, { name: "neural_status" });



    if (cfg.autoRecall) {
      api.on("before_prompt_build", buildRecallHandler(cfg));
    }

    if (cfg.autoCapture) {
      api.on("agent_end", buildCaptureHandler(cfg));
    }


    api.on("session_start", (_event: unknown, ctx: unknown) => {
      if (cfg.debug) api.logger.debug("neural-context: session started");
    });


    api.registerService?.({
      id: "neural-context",
      start: () => { api.logger.info("neural-context: service started"); },
      stop: async () => {
        await engine.shutdown();
        api.logger.info("neural-context: service stopped");
      },
    });
  },
};
