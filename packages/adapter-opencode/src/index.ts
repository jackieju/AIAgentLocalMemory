import { createHash } from "node:crypto";
import type { Plugin, Hooks } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { NeuralContextEngine } from "@ai-agent-local-memory/core";
import type { NodeType, RecallResult, MemoryNode } from "@ai-agent-local-memory/core";
import { SqliteStorageProvider } from "@ai-agent-local-memory/storage-sqlite";

const NODE_TYPES: readonly NodeType[] = [
  "concept",
  "assertion",
  "definition",
  "filler",
  "episode",
  "meta",
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

const AIAgentLocalMemoryPlugin: Plugin = async ({ directory }) => {
  const projectId = projectIdFromDir(directory);
  const storage = new SqliteStorageProvider();
  const engine = new NeuralContextEngine();

  try {
    await engine.init({ storage, projectId });
  } catch (err) {
    console.error("[ai-agent-local-memory] init failed:", err);
    return {} as Hooks;
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
          "Recall memories related to a query using spreading activation across the neural graph.",
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
            `Project: ${projectId}`,
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
    },

    "experimental.chat.system.transform": async (_input, output) => {
      try {
        const recent = output.system[output.system.length - 1];
        if (!recent || typeof recent !== "string") return;
        const results = await engine.recall(recent, { maxResults: 5 });
        if (results.length === 0) return;
        const injected = [
          "## Relevant memories from neural context engine",
          ...results.map((r) => `- [${r.node.type}] ${r.node.content}`),
        ].join("\n");
        output.system.push(injected);
      } catch (err) {
        console.error("[ai-agent-local-memory] system.transform failed:", err);
      }
    },
  };
};

export default AIAgentLocalMemoryPlugin;
