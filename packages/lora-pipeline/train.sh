#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL="${MODEL:-Qwen/Qwen3-14B}"
ADAPTER_DIR="${SCRIPT_DIR}/adapters/$(date +%Y%m%d-%H%M%S)"
TRAIN_DATA="${SCRIPT_DIR}/training-data/train.jsonl"
VALID_DATA="${SCRIPT_DIR}/training-data/valid.jsonl"
ITERS="${ITERS:-200}"
BATCH_SIZE="${BATCH_SIZE:-4}"
LORA_RANK="${LORA_RANK:-8}"
LEARNING_RATE="${LR:-1e-5}"

if [ ! -f "$TRAIN_DATA" ]; then
  echo "No training data found. Run export first:"
  echo "  bun run ${SCRIPT_DIR}/export-training-data.ts"
  exit 1
fi

TRAIN_COUNT=$(wc -l < "$TRAIN_DATA" | tr -d ' ')
echo "Training data: ${TRAIN_COUNT} examples"

if [ "$TRAIN_COUNT" -lt 5 ]; then
  echo "Too few examples (${TRAIN_COUNT}). Need at least 5 for meaningful LoRA training."
  echo "Use neural_ask_server more to accumulate experience data."
  exit 1
fi

mkdir -p "$ADAPTER_DIR"

echo "=== LoRA Fine-tune ==="
echo "Model:    $MODEL"
echo "Adapter:  $ADAPTER_DIR"
echo "Iters:    $ITERS"
echo "Batch:    $BATCH_SIZE"
echo "Rank:     $LORA_RANK"
echo "LR:       $LEARNING_RATE"
echo ""

python -m mlx_lm.lora \
  --model "$MODEL" \
  --train \
  --data "$SCRIPT_DIR/training-data" \
  --adapter-path "$ADAPTER_DIR" \
  --iters "$ITERS" \
  --batch-size "$BATCH_SIZE" \
  --lora-layers 16 \
  --lora-rank "$LORA_RANK" \
  --learning-rate "$LEARNING_RATE" \
  --seed 42

echo ""
echo "=== Training complete ==="
echo "Adapter saved to: $ADAPTER_DIR"

LATEST_LINK="${SCRIPT_DIR}/adapters/latest"
rm -f "$LATEST_LINK"
ln -s "$ADAPTER_DIR" "$LATEST_LINK"
echo "Symlinked: adapters/latest -> $(basename "$ADAPTER_DIR")"
