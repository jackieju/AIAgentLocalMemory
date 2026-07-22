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

# Pre-compile the Solid TSX sidebar into tui-compiled/ with runtime-module imports.
# Raw TSX relies on opencode's regex-based import rewriter which fails silently for us;
# the compiled form uses explicit opentui:runtime-module:* specifiers (see magic-context).
bun packages/adapter-opencode/scripts/build-tui.ts

for CACHE_DIR in "$HOME/.cache/opencode/packages/ai-agent-local-memory"*"/node_modules/ai-agent-local-memory"; do
  [ -d "$CACHE_DIR" ] || continue
  cp packages/adapter-opencode/dist/index.js "$CACHE_DIR/index.js" 2>/dev/null
  cp packages/adapter-opencode/dist/index.js "$CACHE_DIR/plugin.js" 2>/dev/null
  mkdir -p "$CACHE_DIR/src/tui" "$CACHE_DIR/src/tui-compiled" 2>/dev/null
  cp packages/adapter-opencode/src/tui/index.tsx "$CACHE_DIR/src/tui/index.tsx" 2>/dev/null
  cp packages/adapter-opencode/src/tui/entry.mjs "$CACHE_DIR/src/tui/entry.mjs" 2>/dev/null
  cp packages/adapter-opencode/src/tui-compiled/index.tsx "$CACHE_DIR/src/tui-compiled/index.tsx" 2>/dev/null
  # Rewrite deployed package.json exports to point at entry.mjs (host-runtime-aware loader)
  node -e '
    const fs = require("fs");
    const p = process.argv[1] + "/package.json";
    if (!fs.existsSync(p)) process.exit(0);
    const pkg = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (pkg.exports && pkg.exports["./tui"]) {
      pkg.exports["./tui"] = { import: "./src/tui/entry.mjs" };
      fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
    }
  ' "$CACHE_DIR" 2>/dev/null
done
echo "Build #$BN deployed (server + tui)"
