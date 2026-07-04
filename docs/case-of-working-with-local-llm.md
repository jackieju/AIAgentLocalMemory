# Case of Working with Local LLM

## Hardware & Environment

- Machine: Apple Silicon Mac
- RAM: 64GB+
- OS: macOS
- Runtime: Bun

## Installation

```bash
# Install ollama
brew install ollama

# Pull models
ollama pull qwen3:8b          # 5.2GB, Q4_K_M quantization
ollama pull nomic-embed-text  # 274MB, F16

# Start ollama
ollama serve
```

## Current Configuration

`~/.config/opencode/neural-context.json`:

```json
{
  "injectSystemPrompt": true,
  "coexistWithMagicContext": false,
  "syncRepo": "git@github.com:jackieju/myaimemorystore.git",
  "llm": {
    "provider": "ollama",
    "model": "qwen3:8b"
  },
  "embedding": {
    "provider": "ollama",
    "model": "nomic-embed-text"
  }
}
```

## Models

| Model | Size | Quantization | Context | Capabilities |
|---|---|---|---|---|
| qwen3:8b | 5.2GB | Q4_K_M | 40960 | completion, tools, thinking |
| nomic-embed-text | 274MB | F16 | 2048 | embedding |

## Tool Calling Test Results

Tested Qwen3 8B's ability to correctly parse tool descriptions and generate valid tool call JSON using our plugin's actual tool schemas.

### Test 1: Store Memory (neural_remember)

**Input**: "I want to remember that the project uses Bun runtime and TypeScript. Please save this as a memory."

**Result**: ✓ PASS

```json
{
  "name": "neural_remember",
  "arguments": {
    "content": "The project uses Bun runtime and TypeScript.",
    "importance": 0.8,
    "type": "fact"
  }
}
```

Observations:
- Correctly selected `neural_remember` over `neural_recall` and `neural_ask_server`
- Generated valid JSON arguments
- Chose appropriate type (`fact`) and reasonable importance (`0.8`)
- Internal reasoning showed understanding of parameter semantics

### Test 2: Recall Memory (neural_recall)

**Input**: "What do you know about our authentication module? I remember we discussed it before."

**Result**: ✓ PASS

```json
{
  "name": "neural_recall",
  "arguments": {
    "query": "authentication module",
    "maxResults": 10
  }
}
```

Observations:
- Correctly chose `neural_recall` (retrieval, not storage)
- Extracted appropriate search query from natural language
- Did not hallucinate or call wrong tool

### Test 3: Escalation (neural_ask_server)

**Input**: "How do I implement a zero-knowledge proof system for our authentication? We need it to be quantum-resistant."

**System prompt**: Student mode with confidence threshold 0.5

**Result**: ✓ PASS

```json
{
  "name": "neural_ask_server",
  "arguments": {
    "problem": "Implementing a quantum-resistant zero-knowledge proof system for authentication",
    "context": "...",
    "learnFrom": "both"
  }
}
```

Observations:
- Correctly assessed low confidence on advanced cryptography topic
- Chose to escalate rather than attempt an answer
- Formulated clear problem description for the server LLM

## Conclusions

| Capability | Qwen3 8B |
|---|---|
| Single tool selection | ✓ Reliable |
| Multi-tool disambiguation | ✓ Correct tool chosen in all tests |
| JSON argument generation | ✓ Valid, well-structured |
| Enum parameter adherence | ✓ Respects allowed values |
| Confidence self-assessment | ✓ Escalates appropriately on hard problems |
| Internal reasoning (thinking) | ✓ Shows chain-of-thought before tool calls |

**Qwen3 8B is fully capable of operating as the local LLM in all three modes (observer, student, primary).** Tool calling works reliably for our plugin's tool schemas.

## Three Modes Available

Switch modes via script:

```bash
~/use-ai-agent-local-memory.sh        # No local LLM
~/use-ai-agent-local-memory.sh ob     # Observer: Claude works, local LLM learns silently
~/use-ai-agent-local-memory.sh st     # Student: local LLM works, auto-escalates when unsure
~/use-ai-agent-local-memory.sh ask    # Primary: local LLM fully autonomous
```

## Remote Deployment

The local LLM can run on another machine in the network:

```json
{
  "localLlm": {
    "provider": "ollama",
    "endpoint": "http://192.168.1.100:11434",
    "model": "qwen3:32b"
  }
}
```

On the remote machine: `OLLAMA_HOST=0.0.0.0 ollama serve`
