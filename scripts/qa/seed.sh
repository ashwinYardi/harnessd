#!/bin/sh
# Seed harnessd's QA sandbox (MET-181, D-051).
#
# Copies harnessd's own test fixtures into the sandbox HARNESSD_HOME, so the sandbox's data
# comes from this repo. It runs before the port is picked, so it gets no PORT.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)

if [ -z "${HARNESSD_HOME:-}" ]; then
  key=$(printf '%s' "$ROOT" | cksum | awk '{print $1}')
  tmp=${TMPDIR:-/tmp}
  HARNESSD_HOME="${tmp%/}/harnessd-qa-$key"
fi

FIXTURES="$HARNESSD_HOME/fixtures"
rm -rf "$FIXTURES"
mkdir -p "$FIXTURES"

copy() {
  src="$ROOT/$1"
  dest="$FIXTURES/$2"
  if [ -d "$src" ]; then
    mkdir -p "$dest"
    cp -R "$src/." "$dest/"
  fi
}

copy packages/daemon/test/fixtures daemon-test
copy packages/daemon/src/coordinator/fixtures coordinator
copy packages/daemon/src/linear/fixtures linear

# D-026: the sandbox never runs the loop, so it holds no secret and no pause.
rm -rf "$HARNESSD_HOME/secrets"
rm -f "$HARNESSD_HOME/state/paused.json"

echo "seeded $FIXTURES"
