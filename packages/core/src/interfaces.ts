
export type NodeType =
  | "concept"      // Key concept/entity extracted from conversation
  | "assertion"    // Composite: multiple concepts forming a claim
  | "definition"   // Definition-style description
  | "filler"       // Low-priority context/filler words
  | "episode"      // Single message in conversation history
  | "meta"         // Hub node: consolidated summary of related nodes
  | "fact";        // Durable session/project fact (survives compression)

export interface MemoryNode {
  id: string;
  type: NodeType;
  content: string;
  importance: number;        // 0..1, affects decay rate
  strength: number;          // Current activation level (influenced by access)
  accessCount: number;
  lastAccessed: number;      // Unix timestamp ms
  createdAt: number;         // Unix timestamp ms
  sourceSession?: string;    // Originating session ID
  sourceRange?: [number, number]; // Position in original conversation
  metadata?: Record<string, unknown>;
}


export type SynapseType =
  | "entity"         // Shared named entity
  | "temporal"       // Co-occurrence within time window
  | "lexical"        // Word overlap in [0.2, 0.55] range
  | "semantic"       // Semantic similarity (embedding-based)
  | "causal"         // Causal relationship (A causes B)
  | "compositional"; // Composition (concepts → assertion)

export interface Synapse {
  src: string;               // Source node ID
  dst: string;               // Target node ID
  type: SynapseType;
  weight: number;            // 0..1, synapse strength
  lastCoactivated: number;   // Unix timestamp ms
  coactivationCount: number;
}


export interface SessionMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp?: number;
}

export interface SessionData {
  id: string;
  messages: SessionMessage[];
  metadata?: Record<string, unknown>;
}


export interface RecallOptions {
  maxResults?: number;       // Default: 20
  maxHops?: number;          // Default: 3
  decayFactor?: number;      // Default: 0.5
  threshold?: number;        // Minimum activation to include, default: 0.08
  includeTypes?: NodeType[]; // Filter by node type
  excludeTypes?: NodeType[]; // Exclude node types
}

export interface RecallResult {
  node: MemoryNode;
  score: number;             // Activation score
  path?: string[];           // Node IDs showing how we reached this node
}


export interface ConceptExtraction {
  concepts: Array<{
    content: string;
    importance: number;       // 0..1
  }>;
  assertions: Array<{
    content: string;
    relatedConcepts: string[]; // Content strings of related concepts
  }>;
  definitions: Array<{
    content: string;
    relatedConcepts: string[];
  }>;
}


/**
 * LLM provider — injected by the host adapter.
 * The core engine never imports any LLM SDK directly.
 */
export interface LLMProvider {
  /**
   * Generate a text completion.
   */
  complete(prompt: string, options?: { model?: string; maxTokens?: number }): Promise<string>;

  /**
   * Extract concepts, assertions, and definitions from text.
   * The implementation should parse the LLM response into structured data.
   */
  extractConcepts(text: string): Promise<ConceptExtraction>;
}

/**
 * Storage provider — the persistence layer.
 * Default implementation: SQLite + FTS5.
 */
export interface StorageProvider {
  // Lifecycle
  open(projectId: string): Promise<void>;
  close(): Promise<void>;

  // Node operations
  getNode(id: string): Promise<MemoryNode | null>;
  putNode(node: MemoryNode): Promise<void>;
  updateNode(id: string, updates: Partial<Omit<MemoryNode, "id">>): Promise<void>;
  deleteNode(id: string): Promise<void>;
  getNodesByIds(ids: string[]): Promise<MemoryNode[]>;
  queryNodes(filter: NodeFilter): Promise<MemoryNode[]>;

  // Edge operations
  getEdges(nodeId: string, direction?: "in" | "out" | "both"): Promise<Synapse[]>;
  putEdge(edge: Synapse): Promise<void>;
  updateEdge(src: string, dst: string, type: SynapseType, updates: Partial<Omit<Synapse, "src" | "dst" | "type">>): Promise<void>;
  deleteEdge(src: string, dst: string, type: SynapseType): Promise<void>;
  getEdgesBatch(nodeIds: string[], direction?: "in" | "out" | "both"): Promise<Synapse[]>;

  // Full-text search (fallback when not in working memory)
  search(query: string, limit?: number): Promise<MemoryNode[]>;

  // Full-text search with relevance scores (for hybrid scoring)
  searchWithScores?(query: string, limit?: number): Promise<Array<{ node: MemoryNode; score: number }>>;

  // Bulk operations
  getAllNodes(): Promise<MemoryNode[]>;
  getAllEdges(): Promise<Synapse[]>;
  getNodeCount(): Promise<number>;
}

export interface NodeFilter {
  type?: NodeType | NodeType[];
  minImportance?: number;
  maxAge?: number;           // Max age in ms from now
  sourceSession?: string;
  limit?: number;
}


export interface EngineConfig {
  storage: StorageProvider;
  llm?: LLMProvider;         // Optional — engine works without LLM (no abstraction)

  // Hebbian learning parameters
  learningRate?: number;     // η, default: 0.1
  decayRate?: number;        // λ, per-day decay constant, default: 0.005
  pruneThreshold?: number;   // Min weight before prune eligible, default: 0.01
  pruneMinAge?: number;      // Min age (days) before prune eligible, default: 30
  pruneMinCoactivations?: number; // Min coactivation count to protect from pruning, default: 3

  // Spreading activation parameters
  maxHops?: number;          // Default: 3
  hopDecay?: number;         // Default: 0.5
  activationThreshold?: number; // Default: 0.08
  maxEdgesPerNode?: number;  // Bound on edges per node, default: 8

  // Working memory
  workingMemorySize?: number; // Default: 1000

  // Project identity
  projectId?: string;
}


/**
 * The main NeuralContext engine interface.
 * Host-agnostic: does not import any AI framework SDK.
 */
export interface INeuralContextEngine {
  // Lifecycle
  init(config: EngineConfig): Promise<void>;
  shutdown(): Promise<void>;

  // Write operations
  ingest(session: SessionData): Promise<void>;
  remember(content: string, type: NodeType, options?: { importance?: number; metadata?: Record<string, unknown> }): Promise<MemoryNode>;

  // Read operations
  recall(query: string, options?: RecallOptions): Promise<RecallResult[]>;
  associate(nodeId: string, hops?: number): Promise<RecallResult[]>;
  getWorkingMemory(): MemoryNode[];

  // Maintenance
  decay(): Promise<{ pruned: number; decayed: number }>;
  consolidate(): Promise<{ hubs: number; merged: number }>;

  // Introspection
  getStats(): Promise<EngineStats>;
}

export interface EngineStats {
  nodeCount: number;
  edgeCount: number;
  workingMemorySize: number;
  nodesByType: Record<NodeType, number>;
}

export type FidelityLevel = "f0" | "f1" | "f2" | "f3" | "f4";

export interface FidelityPayloads {
  f0: string;    // Full verbatim text
  f1?: string;   // Paragraph summary (~200 tokens)
  f2?: string;   // One-sentence gist (~30 tokens)
  f3?: string;   // Title only (~8 tokens)
}

export interface EpisodicData {
  role: "user" | "assistant" | "system" | "tool";
  tag: number;
  fidelity: FidelityPayloads;
  suppressed?: boolean;
  pinned?: boolean;
  turnIndex: number;
}

export interface FactData {
  scope: "session" | "project" | "global";
  surfaceCondition?: string;
  activationFloor: number;
  ready?: boolean;
}

export interface ContextRenderConfig {
  contextWindowTokens: number;
  budgetRatio?: number;           // Fraction of window for history, default: 0.6
  systemPromptTokens?: number;    // Tokens reserved for system prompt, default: 2000
  reserveTokens?: number;         // Tokens reserved for response, default: 4000
  recentFullTextTurns?: number;   // Override: force this many turns to f0 (auto-calculated if omitted)
  hysteresisThreshold?: number;   // Activation change % to trigger fidelity shift, default: 0.2
}

export interface RenderedMessage {
  tag: number;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  fidelityLevel: FidelityLevel;
}

export interface RenderResult {
  messages: RenderedMessage[];
  systemInjection: string;
  totalTokens: number;
  budgetUsed: number;
  budgetAvailable: number;
}
