#!/bin/bash
# Publish the OpenCode plugin to npm as `ai-agent-local-memory` (unscoped, public).
#
# WHY THIS SCRIPT EXISTS
# ----------------------
# The npm package `ai-agent-local-memory` is NOT published straight from
# packages/adapter-opencode/package.json (that manifest is scoped + points at
# dist/). The real published package is a FLAT layout: index.js at the root,
# main=index.js, plus the TUI sources. Historically this manifest lived outside
# git and was published by hand, which is why "how do I republish?" kept getting
# lost. This script fixes that: the publish manifest now lives in
# scripts/publish/package.json (version-controlled) and this script assembles a
# clean staging dir that mirrors the live 0.3.0 layout exactly.
#
# USAGE
#   ./scripts/publish/publish.sh            # build + stage + dry-run (safe, no publish)
#   ./scripts/publish/publish.sh --publish  # build + stage + actually `npm publish`
#
# You must `npm login` first (publishing uses YOUR npm credentials — this script
# never handles them). Bump the version in scripts/publish/package.json before
# a real publish.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STAGE="$ROOT/scripts/publish/.staging"
MANIFEST="$ROOT/scripts/publish/package.json"
ADAPTER="$ROOT/packages/adapter-opencode"
DO_PUBLISH=0
[ "${1:-}" = "--publish" ] && DO_PUBLISH=1

VERSION="$(node -e 'console.log(require("'"$MANIFEST"'").version)')"
echo "==> Publishing ai-agent-local-memory@$VERSION  (publish=$DO_PUBLISH)"

# 1. Build the latest bundle (updates dist/index.js + tui-compiled)
echo "==> Building..."
( cd "$ROOT" && ./build.sh )

# 2. Assemble a clean staging dir mirroring the live flat layout
echo "==> Staging into $STAGE"
rm -rf "$STAGE"
mkdir -p "$STAGE/src/tui" "$STAGE/src/tui-compiled"
cp "$MANIFEST"                           "$STAGE/package.json"
cp "$ADAPTER/dist/index.js"              "$STAGE/index.js"
cp "$ADAPTER/src/tui/index.tsx"          "$STAGE/src/tui/index.tsx"
cp "$ADAPTER/src/tui/entry.mjs"          "$STAGE/src/tui/entry.mjs"
cp "$ADAPTER/src/tui-compiled/index.tsx" "$STAGE/src/tui-compiled/index.tsx"
[ -f "$ROOT/README.md" ] && cp "$ROOT/README.md" "$STAGE/README.md"

# 3. Sanity checks — fail loudly rather than publish a broken package
echo "==> Verifying staged package"
node -e '
  const fs = require("fs");
  const d = process.argv[1];
  const pkg = JSON.parse(fs.readFileSync(d + "/package.json", "utf8"));
  if (pkg.name !== "ai-agent-local-memory") throw new Error("name must be unscoped ai-agent-local-memory, got " + pkg.name);
  if (pkg.main !== "index.js") throw new Error("main must be index.js, got " + pkg.main);
  for (const f of ["index.js","src/tui/index.tsx","src/tui/entry.mjs","src/tui-compiled/index.tsx"])
    if (!fs.existsSync(d + "/" + f)) throw new Error("missing staged file: " + f);
  console.log("    ok: name=" + pkg.name + " version=" + pkg.version + " main=" + pkg.main);
' "$STAGE"

echo "==> npm pack dry-run (file list that would ship):"
( cd "$STAGE" && npm pack --dry-run 2>&1 | sed 's/^/    /' )

if [ "$DO_PUBLISH" -eq 1 ]; then
  echo "==> npm whoami:"; npm whoami || { echo "!! Not logged in. Run 'npm login' first."; exit 1; }
  echo "==> Publishing for real..."
  ( cd "$STAGE" && npm publish )   # unscoped + public by default, no --access needed
  echo "==> Done. Verify: npm view ai-agent-local-memory version"
else
  echo ""
  echo "==> DRY RUN complete. Nothing published."
  echo "    To publish for real: npm login  &&  ./scripts/publish/publish.sh --publish"
fi
