#!/bin/sh
# Resolve the QA sandbox home and refuse the user's real harnessd home (MET-239).
#
# Sourced by scripts/qa/start.sh and scripts/qa/seed.sh after they set ROOT. It sets
# SANDBOX_HOME to one canonical path: the guard, every cleanup command and the backend's
# HARNESSD_HOME export all use it. A caller's HARNESSD_HOME names a real home here, never
# the sandbox.

# Resolve relative values against the caller's cwd, before start.sh cds to ROOT.
caller_cwd=$(pwd -P)

# String.trim() exactly, so Unicode padding such as U+00A0 cannot hide a real home.
trim_home() {
  HOME_TO_TRIM=$1 node -e 'process.stdout.write((process.env.HOME_TO_TRIM ?? "").trim())'
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

# Absolute, without trailing slashes; a path that does not exist stays a plain string.
absolute_home() {
  _home=$1
  case $_home in
    /*) ;;
    *) _home="$caller_cwd/$_home" ;;
  esac
  while [ "${_home%/}" != "$_home" ]; do _home=${_home%/}; done
  [ -n "$_home" ] || _home=/
  printf '%s' "$_home"
}

# Collapse . and .. without touching the filesystem, as Node's path.resolve() does.
lexical_home() {
  P=$1 awk 'BEGIN {
    n = split(ENVIRON["P"], seg, "/")
    depth = 0
    for (i = 1; i <= n; i++) {
      if (seg[i] == "" || seg[i] == ".") continue
      if (seg[i] == "..") { if (depth > 0) depth--; continue }
      keep[++depth] = seg[i]
    }
    out = ""
    for (i = 1; i <= depth; i++) out = out "/" keep[i]
    print (out == "" ? "/" : out)
  }'
}

# The on-disk directory a path reaches: cd -P follows a symlink where it appears.
physical_home() {
  _home=$1
  if [ -d "$_home" ]; then
    _resolved=$(cd -P "$_home" 2>/dev/null && pwd -P) || _resolved=$_home
    _home=$_resolved
  fi
  printf '%s' "$_home"
}

# The daemon's resolution, in order: trim, path.resolve() lexically, trim again, then the
# physical folder. Sets _canonical and _canonical_changed. A second trim that changes the
# path would let the daemon's own trim land elsewhere, so that value is refused, never used.
canonical_home() {
  _path=$(trim_home "$1")
  if [ -z "$_path" ]; then
    _canonical=
    _canonical_changed=0
    return 0
  fi
  _path=$(lexical_home "$(absolute_home "$_path")")
  _strip=$(trim_home "$_path")
  if [ "$_strip" = "$_path" ]; then
    _canonical_changed=0
  else
    _canonical_changed=1
  fi
  _canonical=$(physical_home "$_strip")
}

refuse_home() {
  echo "scripts/qa/$(basename "$0"): the sandbox home $sandbox_home is the real harnessd home; set HARNESSD_QA_HOME to a scratch folder" >&2
  exit 1
}

# The daemon trims HARNESSD_HOME, so a padded or space-revealing value still names that home.
guard_home() {
  canonical_home "$1"
  [ -n "$_canonical" ] || return 0
  if [ "$_canonical_changed" = 1 ] || [ "$_canonical" = "$sandbox_home" ]; then
    refuse_home
  fi
}

canonical_home "$SANDBOX_HOME"
SANDBOX_HOME=$_canonical
sandbox_home=$_canonical
if [ "$_canonical_changed" = 1 ]; then
  refuse_home
fi

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
