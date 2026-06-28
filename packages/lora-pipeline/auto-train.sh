#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL="${MODEL:-Qwen/Qwen3-8B}"
MIN_EXPERIENCES="${MIN_EXPERIENCES:-20}"
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen3-experience}"
GRAPH_DB="$HOME/.local/share/ai-agent-local-memory/graph.db"
STATE_FILE="$SCRIPT_DIR/.auto-train-state"
HISTORY_FILE="$HOME/.local/share/ai-agent-local-memory/train-history.json"
TRAIN_DATA="$SCRIPT_DIR/training-data/train.jsonl"

EXPERIENCE_COUNT=$(sqlite3 "$GRAPH_DB" "SELECT COUNT(*) FROM nodes WHERE type='experience';" 2>/dev/null || echo "0")
LAST_TRAINED_COUNT=0
if [ -f "$STATE_FILE" ]; then
  LAST_TRAINED_COUNT=$(cat "$STATE_FILE")
fi

NEW_SINCE_LAST=$((EXPERIENCE_COUNT - LAST_TRAINED_COUNT))

echo "[auto-train] Experiences: ${EXPERIENCE_COUNT} total, ${NEW_SINCE_LAST} new since last training"

if [ "$NEW_SINCE_LAST" -lt "$MIN_EXPERIENCES" ]; then
  echo "[auto-train] Not enough new experiences (need ${MIN_EXPERIENCES}). Skipping."
  exit 0
fi

echo "[auto-train] Threshold reached. Starting pipeline..."

echo ""
echo "=== Step 1: Export training data ==="
bun run "$SCRIPT_DIR/export-training-data.ts"

TRAIN_COUNT=$(wc -l < "$TRAIN_DATA" | tr -d ' ')
if [ "$TRAIN_COUNT" -lt 5 ]; then
  echo "[auto-train] Too few parseable examples ($TRAIN_COUNT). Skipping."
  exit 0
fi

echo ""
echo "=== Step 2: Train LoRA adapter ==="
"$SCRIPT_DIR/train.sh"

echo ""
echo "=== Step 3: Benchmark ==="
"$SCRIPT_DIR/benchmark.sh"

BASE_LOSS=$(grep -oP 'Test loss: \K[0-9.]+' "$SCRIPT_DIR/benchmark-results/base-"*.txt 2>/dev/null | tail -1 || echo "999")
TUNED_LOSS=$(grep -oP 'Test loss: \K[0-9.]+' "$SCRIPT_DIR/benchmark-results/finetuned-"*.txt 2>/dev/null | tail -1 || echo "999")

echo ""
echo "Base loss:      $BASE_LOSS"
echo "Fine-tuned loss: $TUNED_LOSS"

IMPROVED="false"
if [ "$(echo "$TUNED_LOSS < $BASE_LOSS" | bc -l 2>/dev/null || echo 0)" = "1" ]; then
  IMPROVED="true"
fi

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

if [ "$IMPROVED" = "false" ]; then
  echo ""
  echo "[auto-train] DEGRADED — fine-tuned model is worse. Rolling back."
  "$SCRIPT_DIR/rollback.sh"
fi

if [ "$IMPROVED" = "true" ]; then
  echo ""
  echo "=== Step 4: Deploy to ollama ==="
  MODELFILE="$SCRIPT_DIR/Modelfile"
  cat > "$MODELFILE" << EOF
FROM qwen3:8b
ADAPTER $SCRIPT_DIR/adapters/latest
EOF

  ollama create "$OLLAMA_MODEL" -f "$MODELFILE" 2>/dev/null && {
    echo "[auto-train] Deployed as ollama model: $OLLAMA_MODEL"
  } || {
    echo "[auto-train] WARNING: ollama create failed. Adapter saved but not deployed."
  }
fi

echo "$EXPERIENCE_COUNT" > "$STATE_FILE"

mkdir -p "$(dirname "$HISTORY_FILE")"
if [ ! -f "$HISTORY_FILE" ]; then
  echo '{"runs":[],"totalRuns":0,"improved":0}' > "$HISTORY_FILE"
fi

python3 -c "
import json, sys
h = json.load(open('$HISTORY_FILE'))
h['runs'].append({
  'timestamp': '$TIMESTAMP',
  'baseLoss': $BASE_LOSS,
  'tunedLoss': $TUNED_LOSS,
  'improved': $IMPROVED,
  'examples': $TRAIN_COUNT
})
h['runs'] = h['runs'][-50:]
h['totalRuns'] = h.get('totalRuns', 0) + 1
h['improved'] = h.get('improved', 0) + (1 if $IMPROVED else 0)
json.dump(h, open('$HISTORY_FILE', 'w'), indent=2)
" 2>/dev/null || echo "[auto-train] WARNING: failed to update history file"

echo ""
echo "=== Pipeline complete ==="
if [ "$IMPROVED" = "true" ]; then
  echo "Result: IMPROVED (loss $BASE_LOSS -> $TUNED_LOSS)"
else
  echo "Result: DEGRADED (loss $BASE_LOSS -> $TUNED_LOSS) — rolled back"
fi
