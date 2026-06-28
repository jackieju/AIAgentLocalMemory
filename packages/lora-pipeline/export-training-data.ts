#!/usr/bin/env bun
/**
 * Export experience nodes from graph.db into MLX-compatible training format.
 * Output: JSONL file with {instruction, input, output} triplets.
 */
import { Database } from "bun:sqlite";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const GRAPH_DB_PATH = join(homedir(), ".local", "share", "ai-agent-local-memory", "graph.db");
const OUTPUT_DIR = resolve(import.meta.dir, "training-data");

interface ExperienceNode {
  id: string;
  content: string;
  metadata: string | null;
  createdAt: number;
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

function main() {
  if (!existsSync(GRAPH_DB_PATH)) {
    console.error(`graph.db not found at ${GRAPH_DB_PATH}`);
    process.exit(1);
  }

  const db = new Database(GRAPH_DB_PATH, { readonly: true });

  const experiences = db.prepare(
    `SELECT id, content, metadata, createdAt FROM nodes WHERE type = 'experience' ORDER BY createdAt ASC`
  ).all() as ExperienceNode[];

  console.log(`Found ${experiences.length} experience nodes`);

  if (experiences.length === 0) {
    console.log("No experiences to export. Use neural_ask_server to accumulate learning data first.");
    process.exit(0);
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });

  const trainingData: Array<{ instruction: string; input: string; output: string }> = [];
  let skipped = 0;

  for (const exp of experiences) {
    const parsed = parseExperience(exp);
    if (!parsed) {
      skipped++;
      continue;
    }

    trainingData.push({
      instruction: "You are a senior expert. Solve the following problem with clear reasoning and a concrete solution.",
      input: parsed.refined || parsed.problem,
      output: parsed.response,
    });
  }

  const outputPath = join(OUTPUT_DIR, "train.jsonl");
  const jsonl = trainingData.map(d => JSON.stringify(d)).join("\n") + "\n";
  writeFileSync(outputPath, jsonl);

  console.log(`Exported ${trainingData.length} training examples to ${outputPath}`);
  if (skipped > 0) console.log(`Skipped ${skipped} unparseable entries`);

  const validPath = join(OUTPUT_DIR, "valid.jsonl");
  if (trainingData.length >= 10) {
    const validCount = Math.max(2, Math.floor(trainingData.length * 0.1));
    const validData = trainingData.slice(-validCount);
    const trainData = trainingData.slice(0, -validCount);

    writeFileSync(outputPath, trainData.map(d => JSON.stringify(d)).join("\n") + "\n");
    writeFileSync(validPath, validData.map(d => JSON.stringify(d)).join("\n") + "\n");
    console.log(`Split: ${trainData.length} train, ${validData.length} validation`);
  } else {
    writeFileSync(validPath, jsonl);
    console.log("Too few examples for train/valid split — using same data for both.");
  }

  db.close();
}

main();
