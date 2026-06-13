#!/bin/bash
cd "$(dirname "$0")"
BN_FILE="packages/adapter-opencode/BUILD_NUMBER"
BN=$(($(cat "$BN_FILE" 2>/dev/null || echo 0) + 1))
echo "$BN" > "$BN_FILE"
bun build packages/adapter-opencode/src/index.ts --outdir packages/adapter-opencode/dist --target bun --external "@opencode-ai/plugin"
CACHE_DIR="$HOME/.cache/opencode/packages/ai-agent-local-memory@latest/node_modules/ai-agent-local-memory"
cp packages/adapter-opencode/dist/index.js "$CACHE_DIR/index.js" 2>/dev/null
mkdir -p "$CACHE_DIR/src/tui" 2>/dev/null
cp packages/adapter-opencode/src/tui/index.tsx "$CACHE_DIR/src/tui/index.tsx" 2>/dev/null
echo "Build #$BN deployed (server + tui)"
