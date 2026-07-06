#!/bin/bash
# Replay historical OpenCode sessions in headless mode to harvest sub-agent reasoning
# for local LLM training.
#
# For each historical session:
#   1. Extract the user message sequence (in time order)
#   2. Create a NEW opencode session (marked "replay-<orig_id>")
#   3. Feed each user message through `opencode run --print` in the new session
#   4. Every assistant reply + every sub-agent call in the replay session is now
#      captured by the plugin's session.idle handler (see index.ts sub-session harvest)
#   5. Training pairs land in ~/.local/share/ai-agent-local-memory/training-pairs/pairs.jsonl
#
# Usage:
#   ./replay-history.sh                       # replay all historical sessions
#   ./replay-history.sh --limit 10            # replay 10 sessions
#   ./replay-history.sh --min-messages 5      # only sessions with >=5 messages
#   ./replay-history.sh --since 2026-06-01    # only sessions after this date
#
# Cost: replays consume LLM API tokens like real conversations. Budget accordingly.
set -euo pipefail

DB="${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db"
LIMIT=""
MIN_MESSAGES=3
SINCE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit) LIMIT="$2"; shift 2 ;;
    --min-messages) MIN_MESSAGES="$2"; shift 2 ;;
    --since) SINCE="$2"; shift 2 ;;
    -h|--help)
      grep '^#' "$0" | head -30
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ ! -f "$DB" ]; then
  echo "opencode.db not found at $DB" >&2
  exit 1
fi

if ! command -v opencode >/dev/null; then
  echo "opencode CLI not found in PATH" >&2
  exit 1
fi

WHERE="parent_id IS NULL"
if [ -n "$SINCE" ]; then
  SINCE_MS=$(date -j -f "%Y-%m-%d" "$SINCE" "+%s")000
  WHERE="$WHERE AND time_created >= $SINCE_MS"
fi

QUERY="
SELECT s.id, s.title, s.directory, (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id AND json_extract(m.data, '\$.role') = 'user') as user_msgs
FROM session s
WHERE $WHERE
  AND (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) >= $MIN_MESSAGES
ORDER BY s.time_created DESC
${LIMIT:+LIMIT $LIMIT}"

echo "Discovering historical sessions..."
sessions=$(sqlite3 -readonly "$DB" -separator $'\t' "$QUERY")
count=$(echo "$sessions" | wc -l | tr -d ' ')
echo "Found $count historical sessions to replay"
echo ""

replayed=0
skipped=0
while IFS=$'\t' read -r sid title dir user_msgs; do
  [ -z "$sid" ] && continue

  if [ ! -d "$dir" ]; then
    echo "  SKIP $sid — directory gone: $dir"
    skipped=$((skipped+1))
    continue
  fi

  echo ""
  echo "=== REPLAY [$((replayed+1))/$count] $sid ==="
  echo "  title: $title"
  echo "  dir:   $dir"
  echo "  user messages: $user_msgs"

  user_msg_file="/tmp/replay-msgs-$sid.txt"
  sqlite3 -readonly "$DB" -separator $'\x1f' "
    SELECT json_extract(p.data, '\$.text')
    FROM message m JOIN part p ON m.id = p.message_id
    WHERE m.session_id = '$sid'
      AND json_extract(m.data, '\$.role') = 'user'
      AND json_extract(p.data, '\$.type') = 'text'
      AND length(json_extract(p.data, '\$.text')) > 5
      AND length(json_extract(p.data, '\$.text')) < 8000
    ORDER BY p.time_created;
  " > "$user_msg_file"

  msg_count=$(grep -c . "$user_msg_file" || true)
  if [ "$msg_count" -lt 1 ]; then
    echo "  SKIP — no valid user messages"
    rm -f "$user_msg_file"
    skipped=$((skipped+1))
    continue
  fi

  new_session_dir="/tmp/replay-$sid"
  mkdir -p "$new_session_dir"

  while IFS= read -r line; do
    [ -z "$line" ] && continue
    echo "  → prompt: ${line:0:80}..."
    (cd "$new_session_dir" && opencode run --print "$line" 2>/dev/null || true)
  done < "$user_msg_file"

  rm -f "$user_msg_file"
  rm -rf "$new_session_dir"
  replayed=$((replayed+1))
done <<< "$sessions"

echo ""
echo "=== REPLAY DONE ==="
echo "Replayed: $replayed sessions"
echo "Skipped:  $skipped sessions"
echo ""
echo "New training pairs (main + sub-agents) collected at:"
echo "  ~/.local/share/ai-agent-local-memory/training-pairs/pairs.jsonl"
echo ""
echo "When enough pairs accumulate, LoRA auto-train fires automatically."
