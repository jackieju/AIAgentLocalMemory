# LoRA Fine-tune Pipeline

Trains a local LLM (Qwen3 14B) on accumulated experience data from `neural_ask_server` consultations.

## Prerequisites

```bash
pip install mlx-lm
ollama pull qwen3:14b
```

## Workflow

### 1. Export training data

```bash
bun run packages/lora-pipeline/export-training-data.ts
```

Exports `experience` nodes from graph.db → `training-data/train.jsonl` + `valid.jsonl`

### 2. Train

```bash
cd packages/lora-pipeline
chmod +x train.sh
./train.sh
```

Environment overrides:
- `MODEL=Qwen/Qwen3-14B` — base model (HuggingFace ID)
- `ITERS=200` — training iterations
- `BATCH_SIZE=4`
- `LORA_RANK=8`
- `LR=1e-5`

### 3. Benchmark

```bash
./benchmark.sh
```

Compares test loss: base model vs fine-tuned. If fine-tuned is worse → rollback.

### 4. Rollback

```bash
./rollback.sh
```

Reverts `adapters/latest` symlink to previous version (or removes it entirely to use base model).

## Using the fine-tuned model with ollama

After training, create an ollama Modelfile:

```
FROM qwen3:14b
ADAPTER ./adapters/latest
```

Then:
```bash
ollama create qwen3-experience -f Modelfile
```

Update `neural-context.json`:
```json
{ "llm": { "provider": "ollama", "model": "qwen3-experience" } }
```

## Data format

Training data is JSONL with fields:
- `instruction`: system role (fixed)
- `input`: the problem/question
- `output`: server LLM's response (reasoning + solution)
