#!/bin/sh
# The product a QA review runs for harnessd (MET-181, D-051).
#
# HARNESSD_QA_AREA picks the product:
#   frontend  the demo app, served with synthetic data
#   backend   a sandbox daemon in setup (D-026) on the port harnessd picked
#
# The sandbox has its own home and no secrets, so it never starts the loop and never touches
# the main harnessd service or its port (MET-239).
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)

# MET-239: resolve the sandbox home and refuse a real harnessd home before any write.
. "$ROOT/scripts/qa/home.sh"

cd "$ROOT"

PORT=${PORT:?PORT is required}
AREA=${HARNESSD_QA_AREA:-backend}

if [ "$AREA" = "frontend" ]; then
  if [ ! -f packages/ui/dist/app/index.html ]; then
    echo "scripts/qa/start.sh: packages/ui/dist/app is missing; run pnpm build" >&2
    exit 1
  fi
  exec node packages/ui/scripts/demo.ts --port "$PORT"
fi

if [ "$AREA" != "backend" ]; then
  echo "scripts/qa/start.sh: unknown HARNESSD_QA_AREA '$AREA'; expected backend or frontend" >&2
  exit 1
fi

if [ ! -f packages/cli/dist/bin.js ]; then
  echo "scripts/qa/start.sh: packages/cli/dist is missing; run pnpm build" >&2
  exit 1
fi

mkdir -p "$SANDBOX_HOME"

# D-026: no secret reaches the sandbox, so the daemon stays in setup.
unset LINEAR_API_KEY HARNESSD_SLACK_WEBHOOK_URL GH_TOKEN GITHUB_TOKEN
rm -rf "$SANDBOX_HOME/secrets"

# The port harnessd picked. self_update is off: this daemon is never a service.
cat > "$SANDBOX_HOME/config.toml" <<EOF
# The QA sandbox (MET-181): one scratch port, no secrets, never a service.
[daemon]
port = $PORT
self_update = false
EOF

# Only the sandbox daemon gets HARNESSD_HOME; the caller's value never picks the sandbox.
export HARNESSD_HOME=$SANDBOX_HOME
exec node packages/cli/dist/bin.js run "$ROOT"
