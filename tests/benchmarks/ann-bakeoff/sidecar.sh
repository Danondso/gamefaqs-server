#!/usr/bin/env bash
# Run a bake-off step inside a sidecar container that mounts the live DB
# read-only. Designed for the gamefaqs-server docker-compose project; the
# data volume name is gamefaqs-server_gamefaqs-data per docker-compose.yml.
#
# Usage:
#   tests/benchmarks/ann-bakeoff/sidecar.sh snapshot --pilot
#   tests/benchmarks/ann-bakeoff/sidecar.sh snapshot
#   tests/benchmarks/ann-bakeoff/sidecar.sh usearch build
#   tests/benchmarks/ann-bakeoff/sidecar.sh libsql build i8
#   tests/benchmarks/ann-bakeoff/sidecar.sh run query
#   tests/benchmarks/ann-bakeoff/sidecar.sh run query --capped
#
# The first positional arg picks the script under tests/benchmarks/ann-bakeoff/
# (snapshot | usearch | libsql | run); remaining args are forwarded.

set -euo pipefail

SCRIPT="${1:-}"
shift || true

if [[ -z "$SCRIPT" ]]; then
  echo "usage: sidecar.sh <snapshot|usearch|libsql|run> [args...]" >&2
  exit 64
fi

case "$SCRIPT" in
  snapshot|usearch|libsql|run) ;;
  *) echo "unknown script: $SCRIPT" >&2; exit 64 ;;
esac

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
DB_VOLUME="gamefaqs-server_gamefaqs-data"
# Match the host's Node ABI so the host-built node_modules native bindings
# (better-sqlite3, usearch, libsql) load without a rebuild. The production
# server runs Node 20; the bake-off doesn't need prod parity since we're
# measuring the index, not the runtime.
IMAGE="${SIDECAR_IMAGE:-node:23-bookworm-slim}"

# Memory cap (Step 3). Forwarded as `--capped` to the runner; here we ALSO
# enforce it at the container level so RSS measurements reflect a real cap.
DOCKER_MEM_ARGS=()
if [[ " $* " == *" --capped "* ]]; then
  DOCKER_MEM_ARGS=(--memory=13g --memory-swap=13g --cpus=8)
  echo "[sidecar] memory cap: 13g, cpus: 8 (matches prod target)"
fi

# Bind /work to the repo so node_modules and the bake-off scripts are present.
# Bind /scratch separately so ann/ writes go to the host (volume-clean if you
# nuke the container).
mkdir -p "$REPO_ROOT/scratch/ann"

exec docker run --rm \
  -v "$DB_VOLUME":/data/db:ro \
  -v "$REPO_ROOT":/work \
  -v "$REPO_ROOT/scratch":/work/scratch \
  -w /work \
  --add-host=host.docker.internal:host-gateway \
  -e DB_PATH=/data/db/gamefaqs.db \
  -e OLLAMA_HOST="${OLLAMA_HOST:-http://host.docker.internal:11434}" \
  -e EMBEDDING_OLLAMA_HOST="${EMBEDDING_OLLAMA_HOST:-http://host.docker.internal:11434}" \
  -e EMBEDDING_MODEL="${EMBEDDING_MODEL:-nomic-embed-text}" \
  -e EMBEDDING_DIM="${EMBEDDING_DIM:-768}" \
  -e RAG_BENCH=1 \
  "${DOCKER_MEM_ARGS[@]}" \
  "$IMAGE" \
  node_modules/.bin/ts-node tests/benchmarks/ann-bakeoff/"$SCRIPT".ts "$@"
