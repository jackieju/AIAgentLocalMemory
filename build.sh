#!/bin/bash
cd "$(dirname "$0")"
BN_FILE="packages/adapter-opencode/BUILD_NUMBER"
BN=$(($(cat "$BN_FILE" 2>/dev/null || echo 0) + 1))
echo "$BN" > "$BN_FILE"

# Inject build number into server source before build
SRC="packages/adapter-opencode/src/index.ts"
sed -i '' "s/__BUILD_NUMBER__/$BN/g" "$SRC"

bun build packages/adapter-opencode/src/index.ts --outdir packages/adapter-opencode/dist --target bun --external "@opencode-ai/plugin"

# Restore placeholder in source
sed -i '' "s/\"$BN\"/\"__BUILD_NUMBER__\"/g" "$SRC"

CACHE_DIR="$HOME/.cache/opencode/packages/ai-agent-local-memory@latest/node_modules/ai-agent-local-memory"
cp packages/adapter-opencode/dist/index.js "$CACHE_DIR/index.js" 2>/dev/null
cp packages/adapter-opencode/dist/index.js "$CACHE_DIR/plugin.js" 2>/dev/null
mkdir -p "$CACHE_DIR/src/tui" 2>/dev/null
cp packages/adapter-opencode/src/tui/index.tsx "$CACHE_DIR/src/tui/index.tsx" 2>/dev/null
echo "Build #$BN deployed (server + tui)"
