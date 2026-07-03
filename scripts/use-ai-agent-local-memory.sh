#!/bin/bash
CONFIG="$HOME/.config/opencode/opencode.jsonc"
TUI_CONFIG="$HOME/.config/opencode/tui.json"
NEURAL_CONFIG="$HOME/.config/opencode/neural-context.json"

MODE="$1"

# Switch OpenCode plugins
sed -i '' '/"plugin"/,/\]/c\
  "plugin": [\
    "oh-my-openagent@latest",\
    "ai-agent-local-memory"\
  ],' "$CONFIG"

# TUI config
cat > "$TUI_CONFIG" << 'EOF'
{
  "$schema": "https://opencode.ai/tui.json",
  "theme": "system",
  "plugin": [
    "ai-agent-local-memory"
  ]
}
EOF

# Neural context config with optional localLlm
if [ -z "$MODE" ]; then
  # No local LLM
  node -e "
    const fs = require('fs');
    const c = JSON.parse(fs.readFileSync('$NEURAL_CONFIG','utf-8'));
    delete c.localLlm;
    fs.writeFileSync('$NEURAL_CONFIG', JSON.stringify(c, null, 2) + '\n');
  "
  echo "Switched to ai-agent-local-memory (no local LLM). Restart OpenCode."
elif [ "$MODE" = "ob" ]; then
  node -e "
    const fs = require('fs');
    const c = JSON.parse(fs.readFileSync('$NEURAL_CONFIG','utf-8'));
    c.localLlm = { provider:'ollama', endpoint:'http://localhost:11434', model:'qwen3:8b', mode:'observer', training:{ triggerCount:100 } };
    fs.writeFileSync('$NEURAL_CONFIG', JSON.stringify(c, null, 2) + '\n');
  "
  echo "Switched to ai-agent-local-memory + local LLM [OBSERVER mode]. Restart OpenCode."
elif [ "$MODE" = "st" ]; then
  node -e "
    const fs = require('fs');
    const c = JSON.parse(fs.readFileSync('$NEURAL_CONFIG','utf-8'));
    c.localLlm = { provider:'ollama', endpoint:'http://localhost:11434', model:'qwen3:8b', mode:'student', confidence:{ userThreshold:0.5, autoEscalateAfter:3 }, training:{ triggerCount:50 } };
    fs.writeFileSync('$NEURAL_CONFIG', JSON.stringify(c, null, 2) + '\n');
  "
  echo "Switched to ai-agent-local-memory + local LLM [STUDENT mode]. Restart OpenCode."
elif [ "$MODE" = "ask" ]; then
  node -e "
    const fs = require('fs');
    const c = JSON.parse(fs.readFileSync('$NEURAL_CONFIG','utf-8'));
    c.localLlm = { provider:'ollama', endpoint:'http://localhost:11434', model:'qwen3:8b', mode:'primary', training:{ triggerCount:50 } };
    fs.writeFileSync('$NEURAL_CONFIG', JSON.stringify(c, null, 2) + '\n');
  "
  echo "Switched to ai-agent-local-memory + local LLM [PRIMARY mode]. Restart OpenCode."
else
  echo "Usage: $0 [ob|st|ask]"
  echo "  (no arg) = no local LLM"
  echo "  ob       = observer mode (Claude works, local LLM learns silently)"
  echo "  st       = student mode (local LLM works, auto-escalates when unsure)"
  echo "  ask      = primary mode (local LLM works, only escalates on '问大模型')"
  exit 1
fi

grep -A5 '"plugin"' "$CONFIG"
cat "$NEURAL_CONFIG"
