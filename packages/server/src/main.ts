import { createInterface } from "node:readline";
import {
  NeuralContextEngine,
  NeuralGraph,
  WorkingMemory,
  ContextRenderer,
  type EngineConfig,
  type ContextRenderConfig,
  type RecallOptions,
  type SessionData,
  type NodeType,
  type ActivationSeed,
} from "@ai-agent-local-memory/core";
import { SqliteStorageProvider } from "@ai-agent-local-memory/storage-sqlite";

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface RpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

interface RpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

interface Instance {
  engine: NeuralContextEngine;
  storage: SqliteStorageProvider;
  graph: NeuralGraph;
  workingMemory: WorkingMemory;
  projectId: string;
}

const instances = new Map<string, Instance>();

function requireString(params: Record<string, unknown> | undefined, key: string): string {
  const v = params?.[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new RpcParamError(`missing or invalid "${key}" (expected non-empty string)`);
  }
  return v;
}

class RpcParamError extends Error {}

async function getInstance(params: Record<string, unknown> | undefined): Promise<Instance> {
  const dbPath = requireString(params, "dbPath");
  const projectId = typeof params?.projectId === "string" ? params.projectId : "default";
  const key = `${dbPath}::${projectId}`;
  const existing = instances.get(key);
  if (existing) return existing;

  const storage = new SqliteStorageProvider({ storagePath: dbPath });
  const engine = new NeuralContextEngine();
  const workingMemorySize =
    typeof params?.workingMemorySize === "number" ? params.workingMemorySize : 1000;
  const maxEdgesPerNode =
    typeof params?.maxEdgesPerNode === "number" ? params.maxEdgesPerNode : 8;

  const config: EngineConfig = {
    storage,
    projectId,
    workingMemorySize,
    maxEdgesPerNode,
  };
  await engine.init(config);

  const graph = new NeuralGraph(storage, maxEdgesPerNode);
  const workingMemory = new WorkingMemory(workingMemorySize);

  const inst: Instance = { engine, storage, graph, workingMemory, projectId };
  instances.set(key, inst);
  return inst;
}

const handlers: Record<
  string,
  (params: Record<string, unknown> | undefined) => Promise<unknown>
> = {
  async ping() {
    return { ok: true, pid: process.pid };
  },

  async renderContext(params) {
    const inst = await getInstance(params);
    const sessionId = requireString(params, "sessionId");
    const contextWindowTokens =
      typeof params?.contextWindowTokens === "number"
        ? params.contextWindowTokens
        : 200000;

    const config: ContextRenderConfig = {
      contextWindowTokens,
      budgetRatio: typeof params?.budgetRatio === "number" ? params.budgetRatio : undefined,
      systemPromptTokens:
        typeof params?.systemPromptTokens === "number" ? params.systemPromptTokens : undefined,
      reserveTokens:
        typeof params?.reserveTokens === "number" ? params.reserveTokens : undefined,
      recentFullTextTurns:
        typeof params?.recentFullTextTurns === "number"
          ? params.recentFullTextTurns
          : undefined,
    };

    const seeds: ActivationSeed[] = Array.isArray(params?.seeds)
      ? (params.seeds as unknown[]).flatMap((s) => {
          if (
            s &&
            typeof s === "object" &&
            typeof (s as Record<string, unknown>).nodeId === "string"
          ) {
            const o = s as Record<string, unknown>;
            return [
              {
                nodeId: o.nodeId as string,
                baseScore: typeof o.baseScore === "number" ? o.baseScore : 1.0,
              },
            ];
          }
          return [];
        })
      : [];

    const renderer = new ContextRenderer(
      inst.graph,
      inst.workingMemory,
      inst.storage,
      config,
    );
    return renderer.render(sessionId, seeds);
  },

  async remember(params) {
    const inst = await getInstance(params);
    const content = requireString(params, "content");
    const type = (typeof params?.type === "string" ? params.type : "concept") as NodeType;
    const importance =
      typeof params?.importance === "number" ? params.importance : undefined;
    const metadata =
      params?.metadata && typeof params.metadata === "object"
        ? (params.metadata as Record<string, unknown>)
        : undefined;
    return inst.engine.remember(content, type, { importance, metadata });
  },

  async recall(params) {
    const inst = await getInstance(params);
    const query = requireString(params, "query");
    const options: RecallOptions = {};
    if (typeof params?.maxResults === "number") options.maxResults = params.maxResults;
    if (typeof params?.maxHops === "number") options.maxHops = params.maxHops;
    if (typeof params?.threshold === "number") options.threshold = params.threshold;
    if (typeof params?.readOnly === "boolean") options.readOnly = params.readOnly;
    return inst.engine.recall(query, options);
  },

  async ingest(params) {
    const inst = await getInstance(params);
    const session = params?.session;
    if (!session || typeof session !== "object") {
      throw new RpcParamError('missing or invalid "session"');
    }
    await inst.engine.ingest(session as unknown as SessionData);
    return { ok: true };
  },

  async getStats(params) {
    const inst = await getInstance(params);
    return inst.engine.getStats();
  },

  async shutdown(params) {
    if (params?.dbPath) {
      const dbPath = requireString(params, "dbPath");
      const projectId = typeof params?.projectId === "string" ? params.projectId : "default";
      const key = `${dbPath}::${projectId}`;
      const inst = instances.get(key);
      if (inst) {
        await inst.engine.shutdown();
        instances.delete(key);
      }
      return { ok: true };
    }
    for (const inst of instances.values()) {
      await inst.engine.shutdown();
    }
    instances.clear();
    return { ok: true };
  },
};

function write(msg: RpcSuccess | RpcError): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function dispatch(req: RpcRequest): Promise<void> {
  const id = req.id ?? null;
  const handler = handlers[req.method];
  if (!handler) {
    write({ jsonrpc: "2.0", id, error: { code: METHOD_NOT_FOUND, message: `unknown method: ${req.method}` } });
    return;
  }
  try {
    const result = await handler(req.params);
    write({ jsonrpc: "2.0", id, result });
  } catch (err) {
    const code = err instanceof RpcParamError ? INVALID_PARAMS : INTERNAL_ERROR;
    write({
      jsonrpc: "2.0",
      id,
      error: { code, message: err instanceof Error ? err.message : String(err) },
    });
  }
}

function main(): void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let req: RpcRequest;
    try {
      req = JSON.parse(trimmed) as RpcRequest;
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "invalid JSON" } });
      return;
    }
    if (typeof req.method !== "string") {
      write({ jsonrpc: "2.0", id: req.id ?? null, error: { code: INVALID_REQUEST, message: "missing method" } });
      return;
    }
    void dispatch(req);
  });
  rl.on("close", () => {
    void (async () => {
      for (const inst of instances.values()) {
        try {
          await inst.engine.shutdown();
        } catch {
          void 0;
        }
      }
      process.exit(0);
    })();
  });
}

main();
