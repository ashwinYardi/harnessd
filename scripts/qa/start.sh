#!/bin/sh
# The product a QA review runs for harnessd (MET-181, D-051).
#
# HARNESSD_QA_AREA picks the product:
#   frontend  the demo app, served with synthetic data
#   backend   a sandbox daemon in setup (D-026) on the port harnessd picked
#
# The sandbox has its own HARNESSD_HOME and no secrets, so it never starts the loop and
# never touches the main harnessd service or its port.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
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

# One scratch home per worktree, so seed and start agree without harnessd passing it.
if [ -z "${HARNESSD_HOME:-}" ]; then
  key=$(printf '%s' "$ROOT" | cksum | awk '{print $1}')
  tmp=${TMPDIR:-/tmp}
  HARNESSD_HOME="${tmp%/}/harnessd-qa-$key"
fi
export HARNESSD_HOME
mkdir -p "$HARNESSD_HOME"

# D-026: no secret reaches the sandbox, so the daemon stays in setup.
unset LINEAR_API_KEY HARNESSD_SLACK_WEBHOOK_URL GH_TOKEN GITHUB_TOKEN
rm -rf "$HARNESSD_HOME/secrets"

# The port harnessd picked. self_update is off: this daemon is never a service.
cat > "$HARNESSD_HOME/config.toml" <<EOF
# The QA sandbox (MET-181): one scratch port, no secrets, never a service.
[daemon]
port = $PORT
self_update = false
EOF

exec node packages/cli/dist/bin.js run "$ROOT"
