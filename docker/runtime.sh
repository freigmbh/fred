#!/bin/sh
set -eu
command="${1:-worker}"
[ $# -eq 0 ] || shift
case "$command" in
  worker)
    cd /app/apps/worker
    exec node --import tsx/esm dist/main.mjs ;;
  deploy)
    exec node /app/scripts/container-deploy.mjs ;;
  convex)
    # CI keeps the Convex CLI's Sentry reporting off, the only egress it would add.
    CI=1 CONVEX_SELF_HOSTED_ADMIN_KEY="$(cat "$FRED_ADMIN_KEY_FILE")"
    export CI CONVEX_SELF_HOSTED_ADMIN_KEY
    cd /app/apps/controller
    exec node node_modules/convex/bin/main.js "$@" ;;
  *)
    exec "$command" "$@" ;;
esac
