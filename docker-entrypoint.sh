#!/bin/sh
set -e

# When started as root, make sure the data dir (bind mount or volume) is writable
# by the unprivileged "node" user, then drop privileges.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  find "$DATA_DIR" \! -user node -exec chown node:node {} +
  exec su-exec node "$@"
fi

exec "$@"
