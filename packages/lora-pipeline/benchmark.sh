#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL="${MODEL:-Qwen/Qwen3-8B}"
ADAPTER_DIR="${SCRIPT_DIR}/adapters/latest"
BENCHMARK_FILE="${SCRIPT_DIR}/training-data/valid.jsonl"
RESULTS_DIR="${SCRIPT_DIR}/benchmark-results"

if [ ! -d "$ADAPTER_DIR" ]; then
  echo "No trained adapter found at $ADAPTER_DIR"
  echo "Run train.sh first."
  exit 1
fi

if [ ! -f "$BENCHMARK_FILE" ]; then
  echo "No validation data at $BENCHMARK_FILE"
  exit 1
fi

mkdir -p "$RESULTS_DIR"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

echo "=== Benchmark: Base Model vs Fine-tuned ==="
echo ""

echo "--- Base model (no adapter) ---"
python -m mlx_lm.lora \
  --model "$MODEL" \
  --test \
  --data "$SCRIPT_DIR/training-data" \
  --adapter-path "" 2>&1 | tee "${RESULTS_DIR}/base-${TIMESTAMP}.txt" || true

echo ""
echo "--- Fine-tuned model (with adapter) ---"
python -m mlx_lm.lora \
  --model "$MODEL" \
  --test \
  --data "$SCRIPT_DIR/training-data" \
  --adapter-path "$ADAPTER_DIR" 2>&1 | tee "${RESULTS_DIR}/finetuned-${TIMESTAMP}.txt" || true

echo ""
echo "=== Results saved to ${RESULTS_DIR}/ ==="
echo ""
echo "Compare test loss between base and fine-tuned."
echo "If fine-tuned loss is HIGHER than base, the model degraded — run rollback.sh"
