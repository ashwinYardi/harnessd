#!/bin/sh
# Resolve the QA sandbox home and refuse the user's real harnessd home (MET-239).
#
# Sourced by scripts/qa/start.sh and scripts/qa/seed.sh after they set ROOT. It sets
# SANDBOX_HOME to one resolved path: the guard, every cleanup command and the backend's
# HARNESSD_HOME export all use it. A caller's HARNESSD_HOME names a real home here, never
# the sandbox.

# Resolve relative values against the caller's cwd, before start.sh cds to ROOT.
caller_cwd=$(pwd -P)

# The daemon's own home resolution lives in one Node helper, so this script never copies
# it: String.trim(), path.resolve(), and the real folder, repeated until stable.
resolve_home() {
  node "$ROOT/scripts/qa/resolve-home.mjs" "$caller_cwd" "$1"
}

# The caller's own HARNESSD_HOME is the home a daemon in this shell would use.
caller_home=${HARNESSD_HOME:-}

# HARNESSD_QA_HOME picks the sandbox. Otherwise one scratch folder per worktree, the
# same key seed and start already agreed on, so the loop passes no value (D-051).
if [ -n "${HARNESSD_QA_HOME:-}" ]; then
  SANDBOX_HOME=$(resolve_home "$HARNESSD_QA_HOME")
fi
if [ -z "${SANDBOX_HOME:-}" ]; then
  tmp=${TMPDIR:-/tmp}
  while [ "${tmp%/}" != "$tmp" ]; do tmp=${tmp%/}; done
  [ -n "$tmp" ] || tmp=/
  key=$(printf '%s' "$ROOT" | cksum | awk '{print $1}')
  SANDBOX_HOME=$(resolve_home "$tmp/harnessd-qa-$key")
fi

sandbox_home=$SANDBOX_HOME

# Compare the helper's output for a real home with the sandbox output, nothing else.
guard_home() {
  [ -n "$1" ] || return 0
  _resolved=$(resolve_home "$1")
  [ -n "$_resolved" ] || return 0
  if [ "$_resolved" = "$sandbox_home" ]; then
    echo "scripts/qa/$(basename "$0"): the sandbox home $sandbox_home is the real harnessd home; set HARNESSD_QA_HOME to a scratch folder" >&2
    exit 1
  fi
}

if [ -n "${HOME:-}" ]; then
  guard_home "$HOME/.harnessd"
fi

# The service home, when launchd runs harnessd as an agent. renderPlist writes a fixed
# layout, so plain sed and awk read it on every CI runner; a missing or unreadable plist
# adds no home and never stops the other checks.
if [ -n "${HOME:-}" ]; then
  plist="$HOME/Library/LaunchAgents/dev.harnessd.daemon.plist"
  if [ -f "$plist" ] && [ -r "$plist" ]; then
    service_home=$(awk '
      /<key>HARNESSD_HOME<\/key>/ { found = 1; next }
      found && /<string>/ {
        line = $0
        sub(/^.*<string>/, "", line)
        sub(/<\/string>.*$/, "", line)
        print line
        exit
      }
    ' "$plist" 2>/dev/null) || service_home=
    service_home=$(printf '%s' "$service_home" | sed -e 's/&lt;/</g' -e 's/&gt;/>/g' -e 's/&quot;/"/g' -e 's/&amp;/\&/g')
    guard_home "$service_home"
  fi
fi

guard_home "$caller_home"
