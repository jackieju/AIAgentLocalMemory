#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADAPTER_DIR="${SCRIPT_DIR}/adapters/latest"

if [ ! -L "$ADAPTER_DIR" ]; then
  echo "No 'latest' symlink found — nothing to rollback."
  exit 1
fi

CURRENT=$(readlink "$ADAPTER_DIR")
echo "Current adapter: $CURRENT"

ADAPTERS=($(ls -dt "${SCRIPT_DIR}/adapters"/20* 2>/dev/null))

if [ ${#ADAPTERS[@]} -lt 2 ]; then
  echo "Only one adapter version exists. Removing latest link (reverting to base model)."
  rm -f "$ADAPTER_DIR"
  echo "Rolled back to base model (no adapter)."
  exit 0
fi

PREVIOUS="${ADAPTERS[1]}"
echo "Rolling back to: $(basename "$PREVIOUS")"
rm -f "$ADAPTER_DIR"
ln -s "$PREVIOUS" "$ADAPTER_DIR"
echo "Done. adapters/latest -> $(basename "$PREVIOUS")"
echo ""
echo "To fully remove the bad adapter: rm -rf $CURRENT"
