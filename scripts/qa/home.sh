#!/bin/sh
# Resolve the QA sandbox home and refuse the user's real harnessd home (MET-239).
#
# Sourced by scripts/qa/start.sh and scripts/qa/seed.sh after they set ROOT. It sets
# SANDBOX_HOME. A caller's HARNESSD_HOME names a real home here, never the sandbox: only
# start.sh exports HARNESSD_HOME, and only for the sandbox daemon.

# Resolve relative values against the caller's cwd, before start.sh cds to ROOT.
caller_cwd=$(pwd -P)

# The daemon trims HARNESSD_HOME, so the guard and the handoff compare the trimmed value.
trim_home() {
  printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

# The caller's own HARNESSD_HOME is the home a daemon in this shell would use.
caller_home=${HARNESSD_HOME:-}

# HARNESSD_QA_HOME picks the sandbox. Otherwise one scratch folder per worktree, the
# same key seed and start already agreed on, so the loop passes no value (D-051).
qa_home=$(trim_home "${HARNESSD_QA_HOME:-}")
if [ -n "$qa_home" ]; then
  SANDBOX_HOME=$qa_home
else
  tmp=${TMPDIR:-/tmp}
  while [ "${tmp%/}" != "$tmp" ]; do tmp=${tmp%/}; done
  [ -n "$tmp" ] || tmp=/
  key=$(printf '%s' "$ROOT" | cksum | awk '{print $1}')
  SANDBOX_HOME="$tmp/harnessd-qa-$key"
fi

case $SANDBOX_HOME in
  /*) ;;
  *) SANDBOX_HOME="$caller_cwd/$SANDBOX_HOME" ;;
esac

# Every candidate becomes absolute, loses trailing slashes, and resolves physically with
# cd -P when it exists: /var and /private/var agree, and /var/.. is not read as /.
normalize_home() {
  _home=$1
  case $_home in
    /*) ;;
    *) _home="$caller_cwd/$_home" ;;
  esac
  while [ "${_home%/}" != "$_home" ]; do _home=${_home%/}; done
  [ -n "$_home" ] || _home=/
  if [ -d "$_home" ]; then
    _resolved=$(cd -P "$_home" 2>/dev/null && pwd -P) || _resolved=$_home
    _home=$_resolved
  fi
  printf '%s' "$_home"
}

# The daemon trims every HARNESSD_HOME, so a padded value still names that home.
guard_home() {
  _candidate=$(trim_home "$1")
  [ -n "$_candidate" ] || return 0
  if [ "$(normalize_home "$_candidate")" = "$sandbox_home" ]; then
    echo "scripts/qa/$(basename "$0"): the sandbox home $sandbox_home is the real harnessd home; set HARNESSD_QA_HOME to a scratch folder" >&2
    exit 1
  fi
}

sandbox_home=$(normalize_home "$SANDBOX_HOME")

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
