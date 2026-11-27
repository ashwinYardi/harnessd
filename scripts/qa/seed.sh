#!/bin/sh
# Seed harnessd's QA sandbox (MET-181, D-051).
#
# Copies harnessd's own test fixtures into the sandbox home, so the sandbox's data comes
# from this repo. It runs before the port is picked, so it gets no PORT. It never reads or
# exports HARNESSD_HOME: the sandbox home comes from home.sh (MET-239).
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)

# MET-239: resolve the sandbox home and refuse a real harnessd home before any write.
. "$ROOT/scripts/qa/home.sh"

FIXTURES="$SANDBOX_HOME/fixtures"
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
rm -rf "$SANDBOX_HOME/secrets"
rm -f "$SANDBOX_HOME/state/paused.json"

echo "seeded $FIXTURES"
