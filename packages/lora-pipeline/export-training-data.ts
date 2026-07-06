#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const DATA_ROOT = join(homedir(), ".local", "share", "ai-agent-local-memory");
const GRAPH_DB_PATH = join(DATA_ROOT, "graph.db");
const PAIRS_JSONL_PATH = join(DATA_ROOT, "training-pairs", "pairs.jsonl");
const OUTPUT_DIR = resolve(import.meta.dir, "training-data");

const DIVERGENCE_THRESHOLD = Number(process.env.DIVERGENCE_MIN ?? "0.3");
const KEEP_ALL_WITHOUT_LOCAL = process.env.KEEP_UNLABELED !== "0";

interface ExperienceNode { id: string; content: string; metadata: string | null; created_at: number; }
interface TrainingExample {
  instruction: string;
  input: string;
  output: string;
  source: "experience" | "observer";
  divergence?: number;
  priority: number;
}

function parseExperience(node: ExperienceNode): { problem: string; response: string; refined?: string } | null {
  const content = node.content;
  const problemMatch = content.match(/\[Problem\]\s*(.*?)(?=\[Refined\]|\[Server Response\])/s);
  const refinedMatch = content.match(/\[Refined\]\s*(.*?)(?=\[Server Response\])/s);
  const responseMatch = content.match(/\[Server Response\]\s*(.*)/s);
  if (!problemMatch || !responseMatch) return null;
  return {
    problem: problemMatch[1].trim(),
    refined: refinedMatch?.[1].trim(),
    response: responseMatch[1].trim(),
  };
}

function loadFromGraphDb(): TrainingExample[] {
  if (!existsSync(GRAPH_DB_PATH)) return [];
  const db = new Database(GRAPH_DB_PATH, { readonly: true });
  const rows = db.prepare(
    `SELECT id, content, metadata, created_at FROM nodes WHERE type = 'experience' ORDER BY created_at ASC`
  ).all() as ExperienceNode[];
  db.close();

  const out: TrainingExample[] = [];
  for (const row of rows) {
    const parsed = parseExperience(row);
    if (!parsed) continue;
    out.push({
      instruction: "You are a senior expert. Solve the following problem with clear reasoning and a concrete solution. Structure your answer as [Reasoning] then [Answer].",
      input: parsed.refined || parsed.problem,
      output: parsed.response,
      source: "experience",
      priority: 1.0,
    });
  }
  return out;
}

function loadFromPairsJsonl(): TrainingExample[] {
  if (!existsSync(PAIRS_JSONL_PATH)) return [];
  const raw = readFileSync(PAIRS_JSONL_PATH, "utf-8");
  const out: TrainingExample[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let obj: any;
    try { obj = JSON.parse(t); } catch { continue; }
    if (!obj.input || !obj.output) continue;

    const divergence = typeof obj.divergence === "number" ? obj.divergence : undefined;
    let priority: number;
    if (divergence === undefined) {
      if (!KEEP_ALL_WITHOUT_LOCAL) continue;
      priority = 0.5;
    } else if (divergence >= DIVERGENCE_THRESHOLD) {
      priority = Math.min(1.0, 0.5 + divergence * 0.5);
    } else {
      continue;
    }

    out.push({
      instruction: obj.instruction || "You are a helpful AI assistant. Answer the user's question thoroughly.",
      input: String(obj.input).slice(0, 4000),
      output: String(obj.output).slice(0, 8000),
      source: "observer",
      divergence,
      priority,
    });
  }
  return out;
}

function dedupe(items: TrainingExample[]): TrainingExample[] {
  const seen = new Map<string, TrainingExample>();
  for (const item of items) {
    const key = item.input.slice(0, 200).toLowerCase().replace(/\s+/g, " ").trim();
    const existing = seen.get(key);
    if (!existing || item.priority > existing.priority) {
      seen.set(key, item);
    }
  }
  return [...seen.values()];
}

function main() {
  const graphData = loadFromGraphDb();
  const pairsData = loadFromPairsJsonl();

  console.log(`Loaded ${graphData.length} experience nodes (graph.db)`);
  console.log(`Loaded ${pairsData.length} observer pairs (divergence >= ${DIVERGENCE_THRESHOLD})`);

  const merged = dedupe([...graphData, ...pairsData]);
  merged.sort((a, b) => b.priority - a.priority);

  console.log(`After dedup: ${merged.length} unique examples`);

  if (merged.length === 0) {
    console.error("No training data available. Use neural_ask_server or run in observer mode to accumulate data.");
    process.exit(1);
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });

  const forOutput = merged.map(m => ({
    instruction: m.instruction,
    input: m.input,
    output: m.output,
  }));

  const outputPath = join(OUTPUT_DIR, "train.jsonl");
  const validPath = join(OUTPUT_DIR, "valid.jsonl");

  if (forOutput.length >= 10) {
    const validCount = Math.max(2, Math.floor(forOutput.length * 0.1));
    const trainData = forOutput.slice(0, -validCount);
    const validData = forOutput.slice(-validCount);
    writeFileSync(outputPath, trainData.map(d => JSON.stringify(d)).join("\n") + "\n");
    writeFileSync(validPath, validData.map(d => JSON.stringify(d)).join("\n") + "\n");
    console.log(`Split: ${trainData.length} train, ${validData.length} validation`);
  } else {
    const jsonl = forOutput.map(d => JSON.stringify(d)).join("\n") + "\n";
    writeFileSync(outputPath, jsonl);
    writeFileSync(validPath, jsonl);
    console.log("Too few examples for train/valid split — using same data for both.");
  }

  const byPriority = merged.reduce((acc, m) => {
    const bucket = m.divergence === undefined ? "no-divergence" : m.divergence >= 0.7 ? "high" : m.divergence >= 0.5 ? "med" : "low";
    acc[bucket] = (acc[bucket] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  console.log(`Priority buckets:`, byPriority);
}

main();
