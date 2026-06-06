import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin, Hooks } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { NeuralContextEngine, ContextRenderer, NeuralGraph, WorkingMemory } from "@ai-agent-local-memory/core";
import type { NodeType, RecallResult, MemoryNode, ContextRenderConfig, EpisodicData } from "@ai-agent-local-memory/core";
import { SqliteStorageProvider } from "@ai-agent-local-memory/storage-sqlite";

interface PluginConfig {
  injectSystemPrompt?: boolean;
  contextWindowTokens?: number;
  budgetRatio?: number;
  coexistWithMagicContext?: boolean;
}

function loadConfig(directory: string): PluginConfig {
  const candidates = [
    join(directory, ".opencode", "neural-context.json"),
    join(directory, "neural-context.json"),
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

const AIAgentLocalMemoryPlugin: Plugin = async ({ directory }) => {
  const sessionId = projectIdFromDir(directory);
  const pluginConfig = loadConfig(directory);
  const storage = new SqliteStorageProvider();
  const engine = new NeuralContextEngine();

  try {
    await engine.init({ storage, projectId: "global" });
  } catch (err) {
    console.error("[ai-agent-local-memory] init failed:", err);
    return {} as Hooks;
  }

  const magicContextPresent = pluginConfig.coexistWithMagicContext ?? detectMagicContext(directory);
  if (magicContextPresent) {
    console.log("[ai-agent-local-memory] magic-context detected — running in coexistence mode (messages.transform disabled)");
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
        description: "Expand elided/compressed conversation content back to full text. Use tag numbers from §N§ identifiers.",
        args: {
          tags: z.string().min(1).describe("Tag numbers to expand (e.g. '3-5', '1,2,9')."),
        },
        async execute(args) {
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
    },

    "experimental.chat.messages.transform": magicContextPresent
      ? undefined
      : async (input, output) => {
      try {
        const messages = input.messages ?? [];
        const seeds: Array<{nodeId: string; baseScore: number}> = [];

        for (const msg of messages) {
          if (typeof msg.content !== "string") continue;
          const role = msg.role as "user" | "assistant" | "system" | "tool";
          if (role !== "user" && role !== "assistant") continue;

          const existingNodes = await storage.queryNodes({
            type: "episode",
            sourceSession: sessionId,
          });

          const alreadyStored = existingNodes.some(
            (n) => n.content === msg.content && (n.metadata?.episodicData as Record<string, unknown>)?.role === role,
          );

          if (!alreadyStored) {
            turnCounter++;
            const episodicData: EpisodicData = {
              role,
              tag: turnCounter,
              fidelity: { f0: msg.content },
              turnIndex: turnCounter,
            };
            await engine.remember(msg.content, "episode", {
              importance: role === "user" ? 0.6 : 0.5,
              metadata: { episodicData },
            });
          }
        }

        const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
        if (lastUserMsg && typeof lastUserMsg.content === "string") {
          const tokens = lastUserMsg.content.toLowerCase().split(/\s+/).filter(Boolean);
          const matchingNodes = await storage.search(tokens.slice(0, 5).join(" "), 5);
          for (const node of matchingNodes) {
            if (node.type === "concept" || node.type === "assertion") {
              seeds.push({ nodeId: node.id, baseScore: 0.5 });
            }
          }
        }

        const renderResult = await renderer.render(sessionId, seeds);

        output.messages = renderResult.messages.map((rm) => ({
          role: rm.role,
          content: rm.content,
        }));

        if (renderResult.systemInjection) {
          output.system = [renderResult.systemInjection];
        }
      } catch (err) {
        console.error("[ai-agent-local-memory] messages.transform failed:", err);
      }
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
          "- `neural_expand` — Expand compressed/elided content back to full text.",
        ].join("\n");

        if (magicContextPresent || pluginConfig.injectSystemPrompt === false) {
          output.system.push(usageGuide);
          return;
        }

        const recent = output.system[output.system.length - 1];
        if (recent && typeof recent === "string") {
          const results = await engine.recall(recent, { maxResults: 5 });
          if (results.length > 0) {
            const memories = results.map((r) => `- [${r.node.type}] ${r.node.content}`).join("\n");
            output.system.push(`## Relevant memories from neural context\n${memories}`);
          }
        }

        output.system.push(usageGuide);
      } catch (err) {
        console.error("[ai-agent-local-memory] system.transform failed:", err);
      }
    },
  };
};

export default AIAgentLocalMemoryPlugin;
