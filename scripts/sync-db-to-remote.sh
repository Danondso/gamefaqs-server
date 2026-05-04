#!/usr/bin/env bash
# Snapshot the local SQLite DB and atomically swap it on a remote
# gamefaqs-server. The remote DB is wiped — there is NO backup. Run this only
# when you don't care about the remote's bookmarks/notes/achievements.
#
# Usage:
#   ./scripts/sync-db-to-remote.sh <ssh-target> [remote-compose-dir]
#
# Example:
#   ./scripts/sync-db-to-remote.sh user@host /opt/gamefaqs-server
#
# Defaults: remote compose dir = /opt/gamefaqs-server
# Requires: zstd, rsync, ssh on local; sudo + docker on local AND remote.

set -euo pipefail

if [ $# -lt 1 ]; then
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi

REMOTE="$1"
REMOTE_DIR="${2:-/opt/gamefaqs-server}"
CONTAINER="gamefaqs-server"
VOLUME="gamefaqs-server_gamefaqs-data"
LOCAL_VOL_PATH="/var/lib/docker/volumes/${VOLUME}/_data"

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> [1/5] checkpointing WAL into the main DB"
docker exec "$CONTAINER" node -e "
  const D = require('better-sqlite3');
  const d = new D('/data/db/gamefaqs.db');
  console.log('checkpoint:', JSON.stringify(d.pragma('wal_checkpoint(TRUNCATE)')));
  d.close();
"

echo "==> [2/5] stopping local container so the file is quiet"
docker compose stop "$CONTAINER" >/dev/null

DB_SIZE="$(sudo du -h "$LOCAL_VOL_PATH/gamefaqs.db" | awk '{print $1}')"
echo "==> [3/5] streaming + zstd-compressing DB (${DB_SIZE})"
sudo cat "$LOCAL_VOL_PATH/gamefaqs.db" | zstd -T0 -q > "$TMP/gamefaqs.db.zst"
echo "    compressed: $(du -h "$TMP/gamefaqs.db.zst" | awk '{print $1}')"

echo "==> [4/5] restarting local container + uploading"
docker compose start "$CONTAINER" >/dev/null
rsync -avhP --inplace "$TMP/gamefaqs.db.zst" "$REMOTE:/tmp/gamefaqs.db.zst"

echo "==> [5/5] swapping on $REMOTE"
ssh "$REMOTE" bash <<EOF
set -euo pipefail
cd "$REMOTE_DIR"
docker compose stop "$CONTAINER"
VOL_PATH="\$(docker volume inspect "$VOLUME" --format '{{.Mountpoint}}')"
sudo rm -f "\$VOL_PATH/gamefaqs.db" "\$VOL_PATH/gamefaqs.db-wal" "\$VOL_PATH/gamefaqs.db-shm"
sudo zstd -d /tmp/gamefaqs.db.zst -o "\$VOL_PATH/gamefaqs.db"
rm -f /tmp/gamefaqs.db.zst
docker compose start "$CONTAINER"
EOF

echo
echo "Done. Tail logs with:"
echo "  ssh $REMOTE 'docker logs -f $CONTAINER'"
