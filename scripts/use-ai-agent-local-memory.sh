#!/bin/bash
CONFIG="$HOME/.config/opencode/opencode.jsonc"
TUI_CONFIG="$HOME/.config/opencode/tui.json"
NEURAL_CONFIG="$HOME/.config/opencode/neural-context.json"

MODE="${1:-none}"

if [ "$MODE" != "none" ] && [ "$MODE" != "ob" ] && [ "$MODE" != "st" ] && [ "$MODE" != "ask" ]; then
  echo "Usage: $0 [ob|st|ask]"
  echo "  (no arg) = no local LLM"
  echo "  ob       = observer mode (server LLM works, local LLM learns silently)"
  echo "  st       = student mode (local LLM works, auto-escalates when unsure)"
  echo "  ask      = primary mode (local LLM works, only escalates on explicit request)"
  exit 1
fi

sed -i '' '/"plugin"/,/\]/c\
  "plugin": [\
    "oh-my-openagent@latest",\
    "ai-agent-local-memory"\
  ],' "$CONFIG"

cat > "$TUI_CONFIG" << 'EOF'
{
  "$schema": "https://opencode.ai/tui.json",
  "theme": "system",
  "plugin": [
    "ai-agent-local-memory"
  ]
}
EOF

export CONFIG NEURAL_CONFIG MODE
node -e '
const fs = require("fs");
const cfgPath = process.env.CONFIG;
const neuralPath = process.env.NEURAL_CONFIG;
const modeArg = process.env.MODE;

const c = fs.existsSync(neuralPath) ? JSON.parse(fs.readFileSync(neuralPath,"utf-8")) : {};
let raw = fs.readFileSync(cfgPath, "utf-8");

if (modeArg === "none") {
  // Restore original small_model
  if (c._originalSmallModel) {
    raw = raw.replace(/("small_model"\s*:\s*)"[^"]*"/, "$1\"" + c._originalSmallModel + "\"");
    fs.writeFileSync(cfgPath, raw);
  }
  delete c.localLlm;
  delete c._originalSmallModel;
  fs.writeFileSync(neuralPath, JSON.stringify(c, null, 2) + "\n");
} else {
  const mode = modeArg === "ob" ? "observer" : modeArg === "st" ? "student" : "primary";
  const base = c.localLlm || { provider:"ollama", endpoint:"http://localhost:11434", model:"qwen3:14b" };
  base.mode = mode;
  if (mode === "student") base.confidence = base.confidence || { userThreshold: 0.5, autoEscalateAfter: 3 };
  base.training = base.training || { triggerCount: mode === "observer" ? 100 : 50 };
  c.localLlm = base;

  // Backup original small_model
  const smMatch = raw.match(/"small_model"\s*:\s*"([^"]*)"/);
  if (smMatch && !smMatch[1].startsWith(base.provider)) {
    c._originalSmallModel = smMatch[1];
  }
  fs.writeFileSync(neuralPath, JSON.stringify(c, null, 2) + "\n");

  // Set small_model to local LLM
  const localModel = base.provider + "/" + base.model;
  raw = raw.replace(/("small_model"\s*:\s*)"[^"]*"/, "$1\"" + localModel + "\"");

  // Add provider if missing
  const pName = base.provider;
  const endpoint = (base.endpoint || "http://localhost:11434") + "/v1";
  if (raw.indexOf("\"" + pName + "\"") === -1) {
    const entry = "    \"" + pName + "\": { \"options\": { \"baseURL\": \"" + endpoint + "\" } },\n";
    raw = raw.replace(/("provider"\s*:\s*\{\n)/, "$1" + entry);
  }
  fs.writeFileSync(cfgPath, raw);
}
'

case "$MODE" in
  none) echo "Switched to ai-agent-local-memory (no local LLM). Restart OpenCode." ;;
  ob) echo "Switched to ai-agent-local-memory + local LLM [OBSERVER mode]. Restart OpenCode." ;;
  st) echo "Switched to ai-agent-local-memory + local LLM [STUDENT mode]. Restart OpenCode." ;;
  ask) echo "Switched to ai-agent-local-memory + local LLM [PRIMARY mode]. Restart OpenCode." ;;
esac

echo "--- small_model + provider ---"
grep -E '"small_model"|"ollama"' "$CONFIG"
echo "--- localLlm ---"
node -e 'const c=JSON.parse(require("fs").readFileSync(process.env.NEURAL_CONFIG,"utf-8")); console.log(JSON.stringify(c.localLlm||"(none)", null, 2))'
