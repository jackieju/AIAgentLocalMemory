#!/bin/bash
# Replay historical OpenCode sessions in headless mode to harvest sub-agent reasoning
# for local LLM training.
#
# SAFETY (default: tool-shortcircuit mode):
# Uses the forked opencode binary at ~/.local/bin/opencode-fork (branch
# replay-shortcircuit). Every tool call is intercepted by the plugin's
# tool.execute.before hook, which looks up the historical tool_result in
# opencode.db and returns it directly — the real Read/Write/Edit/Bash/etc.
# is never executed. Result: full sisyphus agent runs the whole reasoning
# path, but nothing on the local filesystem is modified.
#
# Fallback (--agent oracle etc):
# If the forked binary is missing, script falls back to running the stock
# opencode with a read-only agent (oracle/plan/etc). Reasoning fidelity is
# lower but local filesystem is still guaranteed safe.
#
# For each historical session:
#   1. Extract the user message sequence (in time order)
#   2. Create a NEW opencode session
#   3. Feed each user message through `opencode run` in the new session
#   4. All tool calls short-circuit to historical results (fork mode) OR
#      run under a read-only agent (fallback mode)
#   5. The plugin's session.idle handler harvests every reply + every
#      sub-agent call into ~/.local/share/ai-agent-local-memory/training-pairs/pairs.jsonl
#
# Usage:
#   ./replay-history.sh                       # replay all historical sessions (oldest first)
#   ./replay-history.sh --limit 10            # replay 10 oldest sessions
#   ./replay-history.sh --recent --limit 10   # replay 10 most recent sessions instead
#   ./replay-history.sh --min-messages 5      # only sessions with >=5 messages
#   ./replay-history.sh --since 2026-06-01    # only sessions after this date
#   ./replay-history.sh --parallel 4          # run up to 4 sessions concurrently
#   ./replay-history.sh --agent oracle        # force fallback read-only agent mode
#   ./replay-history.sh --stock-opencode      # skip fork, use system opencode
#
# Order: sessions replay OLDEST FIRST by default so later sessions can build on
# any state established by earlier ones. Use --recent to reverse.
#
# Parallelism: default 1 (serial). All concurrent workers share ONE isolated
# opencode.db under /tmp/replay-opencode-isolated/db — same pattern as running
# 5-6 live opencode sessions concurrently. SQLite WAL handles the write locks.
# The shared pairs.jsonl is safe for concurrent line-appends because Node's
# appendFileSync is atomic for small writes. Watch API rate limits — 5 is
# capped as the hard maximum.
#
# Isolation: replay runs against isolated opencode.db instances under
# /tmp/replay-opencode-isolated-*/db so your live ~/.local/share/opencode/opencode.db
# is never modified.
#
# Cost: replays consume LLM API tokens like real conversations. Budget accordingly.
set -euo pipefail

DB="${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db"
LIMIT=""
MIN_MESSAGES=3
SINCE=""
AGENT=""
FORK_BIN="$HOME/.local/bin/opencode-fork"
STOCK_OPENCODE=""
SESSION_ORDER="ASC"
PARALLEL=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit) LIMIT="$2"; shift 2 ;;
    --min-messages) MIN_MESSAGES="$2"; shift 2 ;;
    --since) SINCE="$2"; shift 2 ;;
    --agent) AGENT="$2"; shift 2 ;;
    --stock-opencode) STOCK_OPENCODE=1; shift ;;
    --recent) SESSION_ORDER="DESC"; shift ;;
    --parallel) PARALLEL="$2"; shift 2 ;;
    -h|--help)
      grep '^#' "$0" | head -40
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ ! -f "$DB" ]; then
  echo "opencode.db not found at $DB" >&2
  exit 1
fi

if [ -n "$AGENT" ]; then
  case "$AGENT" in
    oracle|plan|explore|librarian|metis|momus|multimodal-looker) ;;
    *)
      echo "SAFETY REJECT: --agent must be a read-only agent (oracle, plan, explore, librarian, metis, momus, multimodal-looker)." >&2
      echo "Got: $AGENT" >&2
      exit 1
      ;;
  esac
fi

REPLAY_MODE=""
OPENCODE_BIN=""
if [ -n "$AGENT" ]; then
  REPLAY_MODE="agent"
  OPENCODE_BIN=$(command -v opencode)
  if [ -z "$OPENCODE_BIN" ]; then
    echo "opencode CLI not found in PATH" >&2
    exit 1
  fi
elif [ -x "$FORK_BIN" ] && [ -z "$STOCK_OPENCODE" ]; then
  REPLAY_MODE="shortcircuit"
  OPENCODE_BIN="$FORK_BIN"
elif [ -x "$FORK_BIN" ] && [ -n "$STOCK_OPENCODE" ]; then
  echo "SAFETY REJECT: --stock-opencode requires --agent to guarantee safety." >&2
  echo "Either drop --stock-opencode (use fork with shortcircuit), or pass e.g. --agent oracle." >&2
  exit 1
else
  echo "SAFETY REJECT: fork opencode binary not found at $FORK_BIN." >&2
  echo "Either build the fork (packages/opencode from jackieju/opencode branch replay-shortcircuit)" >&2
  echo "or run with --agent oracle to use a read-only agent." >&2
  exit 1
fi

echo "Replay mode: $REPLAY_MODE"
echo "Binary:      $OPENCODE_BIN"
[ -n "$AGENT" ] && echo "Agent:       $AGENT (opencode-enforced read-only)"
[ "$REPLAY_MODE" = "shortcircuit" ] && echo "Interception: plugin.tool.execute.before -> historical result replay (zero side effects)"
echo ""

REPLAY_ISOLATED_DIR="/tmp/replay-opencode-isolated"
mkdir -p "$REPLAY_ISOLATED_DIR/db" "$REPLAY_ISOLATED_DIR/config"
if [ ! -f "$REPLAY_ISOLATED_DIR/config/opencode.jsonc" ]; then
  cp "$HOME/.config/opencode/opencode.jsonc" "$REPLAY_ISOLATED_DIR/config/opencode.jsonc" 2>/dev/null || true
  cp "$HOME/.config/opencode/tui.json" "$REPLAY_ISOLATED_DIR/config/tui.json" 2>/dev/null || true
  cp "$HOME/.config/opencode/neural-context.json" "$REPLAY_ISOLATED_DIR/config/neural-context.json" 2>/dev/null || true
fi

REPLAY_OPENCODE_DB="$REPLAY_ISOLATED_DIR/db/opencode.db"
export OPENCODE_DB="$REPLAY_OPENCODE_DB"
export OPENCODE_CONFIG_DIR="$REPLAY_ISOLATED_DIR/config"
export NEURAL_REPLAY_HISTORY_DB="$DB"

echo "Isolated DB:     $OPENCODE_DB"
echo "Isolated config: $OPENCODE_CONFIG_DIR"
echo "History source:  $NEURAL_REPLAY_HISTORY_DB (read-only, for shortcircuit lookup)"
echo "(Your live opencode session at ~/.local/share/opencode/opencode.db is not touched)"
echo ""

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
ORDER BY s.time_created ${SESSION_ORDER}
${LIMIT:+LIMIT $LIMIT}"

echo "Discovering historical sessions..."
sessions=$(sqlite3 -readonly "$DB" -separator $'\t' "$QUERY")
count=$(echo "$sessions" | wc -l | tr -d ' ')
echo "Found $count historical sessions to replay"
echo ""

if [ "$PARALLEL" -lt 1 ] || [ "$PARALLEL" -gt 5 ]; then
  echo "SAFETY REJECT: --parallel must be between 1 and 5 (got: $PARALLEL)." >&2
  echo "5 is capped to avoid overwhelming the LLM API or SQLite WAL." >&2
  exit 1
fi

replay_one() {
  local sid="$1"
  local title="$2"
  local dir="$3"
  local user_msgs="$4"
  local slot="$5"

  if [ ! -d "$dir" ]; then
    echo "[slot $slot] SKIP $sid — directory gone: $dir"
    return 1
  fi

  echo ""
  echo "[slot $slot] === REPLAY $sid ==="
  echo "[slot $slot]   title: $title"
  echo "[slot $slot]   dir:   $dir"
  echo "[slot $slot]   user messages: $user_msgs"

  local user_msg_file="/tmp/replay-msgs-$sid.jsonl"
  sqlite3 -readonly "$DB" "
    SELECT json_object('text', json_extract(p.data, '\$.text'))
    FROM message m JOIN part p ON m.id = p.message_id
    WHERE m.session_id = '$sid'
      AND json_extract(m.data, '\$.role') = 'user'
      AND json_extract(p.data, '\$.type') = 'text'
      AND length(json_extract(p.data, '\$.text')) > 5
      AND length(json_extract(p.data, '\$.text')) < 8000
    ORDER BY p.time_created;
  " > "$user_msg_file"

  local msg_count=$(grep -c . "$user_msg_file" || true)
  if [ "$msg_count" -lt 1 ]; then
    echo "[slot $slot]   SKIP — no valid user messages"
    rm -f "$user_msg_file"
    return 1
  fi

  local new_session_dir="/tmp/replay-$sid"
  mkdir -p "$new_session_dir"

  while IFS= read -r json_line; do
    [ -z "$json_line" ] && continue
    local prompt=$(echo "$json_line" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).text)}catch{}})')
    [ -z "$prompt" ] && continue
    echo "[slot $slot]   → prompt: ${prompt:0:80}..."
    if [ "$REPLAY_MODE" = "shortcircuit" ]; then
      (cd "$new_session_dir" && NEURAL_REPLAY_ORIG_SESSION_ID="$sid" "$OPENCODE_BIN" run -m anthropic/claude-sonnet-4-6 "$prompt" 2>/dev/null || true)
    else
      (cd "$new_session_dir" && "$OPENCODE_BIN" run --agent "$AGENT" -m anthropic/claude-sonnet-4-6 "$prompt" 2>/dev/null || true)
    fi
  done < "$user_msg_file"

  rm -f "$user_msg_file"
  rm -rf "$new_session_dir"
  return 0
}

replayed=0
skipped=0
launched=0
while IFS=$'\t' read -r sid title dir user_msgs; do
  [ -z "$sid" ] && continue
  launched=$((launched+1))
  slot=$(( (launched - 1) % PARALLEL + 1 ))

  if [ "$PARALLEL" -eq 1 ]; then
    if replay_one "$sid" "$title" "$dir" "$user_msgs" "$slot"; then
      replayed=$((replayed+1))
    else
      skipped=$((skipped+1))
    fi
  else
    while [ "$(jobs -rp | wc -l)" -ge "$PARALLEL" ]; do
      wait -n 2>/dev/null || sleep 1
    done
    replay_one "$sid" "$title" "$dir" "$user_msgs" "$slot" &
  fi
done <<< "$sessions"

if [ "$PARALLEL" -gt 1 ]; then
  echo ""
  echo "waiting for remaining $PARALLEL parallel workers to finish..."
  wait
  replayed=$launched
fi

echo ""
echo "=== REPLAY DONE ==="
echo "Launched: $launched sessions"
echo "Serial replay count: $replayed (parallel mode reports launched count)"
echo "Skipped:  $skipped sessions (serial mode)"
echo "Mode:     $REPLAY_MODE"
echo "Parallel: $PARALLEL"
echo ""
echo "New training pairs (main + sub-agents) collected at:"
echo "  ~/.local/share/ai-agent-local-memory/training-pairs/pairs.jsonl"
echo ""
echo "When enough pairs accumulate, LoRA auto-train fires automatically."
