#!/bin/sh
# Resolve the QA sandbox home and refuse the user's real harnessd home (MET-239).
#
# Sourced by scripts/qa/start.sh and scripts/qa/seed.sh after they set ROOT. It sets
# SANDBOX_HOME. A caller's HARNESSD_HOME names a real home here, never the sandbox: only
# start.sh exports HARNESSD_HOME, and only for the sandbox daemon.

# The caller's own HARNESSD_HOME is the home a daemon in this shell would use.
caller_home=${HARNESSD_HOME:-}

# HARNESSD_QA_HOME picks the sandbox. Otherwise one scratch folder per worktree, the
# same key seed and start already agreed on, so the loop passes no value (D-051).
if [ -n "${HARNESSD_QA_HOME:-}" ]; then
  SANDBOX_HOME=$HARNESSD_QA_HOME
else
  tmp=${TMPDIR:-/tmp}
  while [ "${tmp%/}" != "$tmp" ]; do tmp=${tmp%/}; done
  [ -n "$tmp" ] || tmp=/
  key=$(printf '%s' "$ROOT" | cksum | awk '{print $1}')
  SANDBOX_HOME="$tmp/harnessd-qa-$key"
fi

# A relative HARNESSD_QA_HOME resolves against the caller's cwd, before start.sh cds to ROOT.
case $SANDBOX_HOME in
  /*) ;;
  *) SANDBOX_HOME="$(pwd)/$SANDBOX_HOME" ;;
esac

# Strip trailing slashes, then resolve a path that exists, so /var and /private/var agree
# on macOS. A path that does not exist stays an absolute string.
normalize_home() {
  _home=$1
  while [ "${_home%/}" != "$_home" ]; do _home=${_home%/}; done
  [ -n "$_home" ] || _home=/
  if [ -d "$_home" ]; then
    _home=$(cd "$_home" && pwd -P)
  fi
  printf '%s' "$_home"
}

guard_home() {
  [ -n "$1" ] || return 0
  if [ "$(normalize_home "$1")" = "$sandbox_home" ]; then
    echo "scripts/qa/$(basename "$0"): the sandbox home $sandbox_home is the real harnessd home; set HARNESSD_QA_HOME to a scratch folder" >&2
    exit 1
  fi
}

sandbox_home=$(normalize_home "$SANDBOX_HOME")

if [ -n "${HOME:-}" ]; then
  guard_home "$HOME/.harnessd"
fi

# The service home, when launchd runs harnessd as an agent. renderPlist writes a fixed
# layout, so plain sed and awk read it on every CI runner; a missing plist adds no home.
if [ -n "${HOME:-}" ]; then
  plist="$HOME/Library/LaunchAgents/dev.harnessd.daemon.plist"
  if [ -f "$plist" ]; then
    service_home=$(awk '
      /<key>HARNESSD_HOME<\/key>/ { found = 1; next }
      found && /<string>/ {
        line = $0
        sub(/^.*<string>/, "", line)
        sub(/<\/string>.*$/, "", line)
        print line
        exit
      }
    ' "$plist")
    service_home=$(printf '%s' "$service_home" | sed -e 's/&lt;/</g' -e 's/&gt;/>/g' -e 's/&quot;/"/g' -e 's/&amp;/\&/g')
    guard_home "$service_home"
  fi
fi

guard_home "$caller_home"
