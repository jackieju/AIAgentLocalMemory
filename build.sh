#!/bin/bash
cd "$(dirname "$0")"
BN_FILE="packages/adapter-opencode/BUILD_NUMBER"
BN=$(($(cat "$BN_FILE" 2>/dev/null || echo 0) + 1))
echo "$BN" > "$BN_FILE"
bun build packages/adapter-opencode/src/index.ts --outdir packages/adapter-opencode/dist --target bun --external "@opencode-ai/plugin"
cp packages/adapter-opencode/dist/index.js ~/.cache/opencode/packages/ai-agent-local-memory@latest/node_modules/ai-agent-local-memory/index.js 2>/dev/null
echo "Build #$BN deployed"
