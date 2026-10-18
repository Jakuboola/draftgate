#!/bin/sh
# Record the terminal scene from a real Claude Code session: `sh record/record.sh <out.cast>`.
#
# Claude Code runs with ONLY the stand-in Slack server (`--strict-mcp-config`), registered under the
# real connector's name, so the tool call renders as the real one does and your draftgate gate
# matches it exactly: a real review window opens, and someone clicks Approve. Nothing reaches Slack.
# The review is logged to a scratch file, not your review log. Then `bun terminal.ts <out.cast>`.
#
# The session is yours (your login, plan, status line); the cast is never committed, and
# `terminal.ts` scrubs those rows from what is.
set -eu
out=${1:?usage: sh record/record.sh <out.cast>}
# Absolute before the cd below, so a relative path lands where the caller meant.
case $out in /*) ;; *) out="$PWD/$out" ;; esac
here=$(cd "$(dirname "$0")" && pwd)
# The system prompt and the prompts typed, from draft.json: the copy the video reads too.
system=$(bun -e 'const d = require(process.argv[1]); let s = require("fs").readFileSync(process.argv[2], "utf8"); for (const [k, v] of Object.entries({ ...d.tool_input, reply: d.reply })) s = s.replaceAll(`{{${k}}}`, v); process.stdout.write(s)' "$here/../draft.json" "$here/system.txt")
# Each turn ends after this many quiet seconds; the last one holds the review, so it may wait long.
prompts=$(bun -e 'const d = require(process.argv[1]); const n = d.prompts.length; process.stdout.write(JSON.stringify(d.prompts.map((text, i) => (i < n - 1 ? { text, quiet: 6, timeout: 120 } : { text, quiet: 8, timeout: 420 }))))' "$here/../draft.json")
work=$(mktemp -d)
cat > "$work/mcp.json" <<EOF
{ "mcpServers": { "claude_ai_Slack": { "command": "bun", "args": ["$here/fake-slack.ts"], "env": { "FAKE_SLACK_LOG": "$work/fake-slack.log" } } } }
EOF
mkdir "$work/shop"
cd "$work/shop"
PROMPTS=$prompts \
DRAFTGATE_AUDIT_LOG="$work/audit.jsonl" COLS=100 ROWS=30 \
  python3 "$here/record.py" "$out" claude --strict-mcp-config --mcp-config "$work/mcp.json" \
    --append-system-prompt "$system" \
    --disallowedTools Bash Read Glob Grep Edit Write WebFetch WebSearch Agent NotebookEdit
echo "demo-video: tool calls the stand-in received: $(grep -c tools/call "$work/fake-slack.log" || true)" >&2
