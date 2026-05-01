#!/usr/bin/env bash
# Helper for the /api/admin/ai/index/* endpoints. Kick off, pause (stop), check
# progress, or follow the SSE stream against a running gamefaqs-server.
#
# Defaults to localhost:3000 with the placeholder admin token. For the
# Mac mini deployment (or any remote host) override either or both:
#
#   GAMEFAQS_HOST=http://your-host.local:3000 ADMIN_TOKEN=hunter2 ./scripts/rag-index.sh status
#
# Or export them once per shell:
#
#   export GAMEFAQS_HOST=http://your-host.local:3000
#   export ADMIN_TOKEN=hunter2
#   ./scripts/rag-index.sh start
#
# Subcommands:
#   start [--limit N] [--force]    Kick off indexing (or resume if interrupted)
#   stop                           Request graceful stop; resumes from same place
#   status                         Snapshot of progress as JSON
#   watch [interval=5]             Poll status every N seconds until Ctrl-C
#   stream                         Follow the SSE progress stream until Ctrl-C
#
# Stop is functionally a pause: each guide's indexed_at is checkpointed
# transactionally, so a subsequent `start` skips everything already indexed.

set -euo pipefail

HOST="${GAMEFAQS_HOST:-http://localhost:3000}"
TOKEN="${ADMIN_TOKEN:-your-secret-token}"
AUTH=(-H "Authorization: Bearer ${TOKEN}")

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

cmd_start() {
  local query=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --limit)  query+="${query:+&}limit=$2"; shift 2 ;;
      --force)  query+="${query:+&}force=true"; shift ;;
      *)        echo "unknown flag: $1" >&2; exit 2 ;;
    esac
  done
  local url="${HOST}/api/admin/ai/index/start"
  [ -n "$query" ] && url="${url}?${query}"
  curl -sS -X POST "${url}" "${AUTH[@]}" | jq .
}

cmd_stop() {
  curl -sS -X POST "${HOST}/api/admin/ai/index/stop" "${AUTH[@]}" | jq .
}

cmd_status() {
  curl -sS "${HOST}/api/admin/ai/index/status" "${AUTH[@]}" | jq .
}

cmd_watch() {
  local interval="${1:-5}"
  while true; do
    clear
    date
    curl -sS "${HOST}/api/admin/ai/index/status" "${AUTH[@]}" \
      | jq '.progress | {status, processed: .processedGuides, succeeded: .succeededGuides, failed: .failedGuides, chunks: .totalChunks, current: .currentGuideTitle, message}'
    sleep "${interval}"
  done
}

cmd_stream() {
  # SSE — token via query param so curl doesn't reuse a stale auth header on reconnect.
  curl -N "${HOST}/api/admin/ai/index/stream?token=${TOKEN}"
}

case "${1:-}" in
  start)   shift; cmd_start "$@" ;;
  stop)    cmd_stop ;;
  status)  cmd_status ;;
  watch)   shift; cmd_watch "$@" ;;
  stream)  cmd_stream ;;
  ""|-h|--help) usage ;;
  *) echo "unknown command: $1" >&2; usage ;;
esac
