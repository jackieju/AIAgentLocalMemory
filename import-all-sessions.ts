import { Database } from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { NeuralContextEngine, LightweightLinker, OperationLog, LoggedStorageProvider } from "./packages/core/src/index.ts";
import { SqliteStorageProvider } from "./packages/storage-sqlite/src/index.ts";

const dataBase = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
const episodesDir = join(dataBase, "ai-agent-local-memory", "episodes");
const syncDir = join(dataBase, "ai-agent-local-memory", "sync");
mkdirSync(episodesDir, { recursive: true });
mkdirSync(syncDir, { recursive: true });

const rawStorage = new SqliteStorageProvider();
const opLog = new OperationLog(syncDir);
const storage = new LoggedStorageProvider(rawStorage, opLog);
const engine = new NeuralContextEngine();
await engine.init({ storage, projectId: "global", episodesDir });

const ocDb = new Database(join(homedir(), ".local/share/opencode/opencode.db"), { readonly: true });

const sessions = ocDb.query("SELECT id, title, time_created FROM session ORDER BY time_created ASC").all() as any[];
console.log(`Found ${sessions.length} sessions`);

let imported = 0;
let skipped = 0;

for (const session of sessions) {
  const parts = ocDb.query(`
    SELECT p.message_id, p.data as part_data, m.data as msg_data
    FROM part p
    JOIN message m ON m.id = p.message_id
    WHERE p.session_id = ?
    ORDER BY p.time_created ASC
  `).all(session.id) as any[];

  const msgMap = new Map<string, { role: string; texts: string[] }>();
  for (const part of parts) {
    const partData = JSON.parse(part.part_data);
    if (partData.type !== "text" || !partData.text) continue;
    const msgData = JSON.parse(part.msg_data);
    if (!msgMap.has(part.message_id)) {
      msgMap.set(part.message_id, { role: msgData.role, texts: [] });
    }
    msgMap.get(part.message_id)!.texts.push(partData.text);
  }

  const messages: Array<{ role: string; content: string }> = [];
  for (const [_, msg] of msgMap) {
    const content = msg.texts.join("\n").trim();
    if (content.length >= 10) messages.push({ role: msg.role, content });
  }

  if (messages.length === 0) { skipped++; continue; }

  const sessionData = {
    id: session.id,
    messages: messages.map(m => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  };

  try {
    await engine.ingest(sessionData);
    imported++;
    if (imported % 10 === 0) console.log(`  Imported ${imported} sessions...`);
  } catch (e: any) {
    console.error(`  Error: ${session.id}: ${e.message}`);
  }
}

console.log(`\nDone! Imported: ${imported}, Skipped: ${skipped}, Total: ${sessions.length}`);

const stats = await engine.getStats();
console.log(`Graph: ${stats.nodeCount} nodes, ${stats.edgeCount} edges`);

const opLines = existsSync(join(syncDir, "operations.jsonl"))
  ? require("fs").readFileSync(join(syncDir, "operations.jsonl"), "utf-8").trim().split("\n").length
  : 0;
console.log(`Operations log: ${opLines} entries`);

await engine.shutdown();
ocDb.close();
