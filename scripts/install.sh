#!/bin/sh
# harnessd installer. Installs Node 24 when needed, then runs `harnessd init` (docs/INSTALL.md).
#
#   curl -fsSL https://raw.githubusercontent.com/ashwinYardi/harnessd/main/scripts/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --yes --no-service     # arguments go to init
#
# Safe to re-run: a Node 24+ already on PATH is used as is, and init is idempotent.
set -eu

NODE_MAJOR=24
NODE_DIST="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"

say() { printf 'harnessd: %s\n' "$*"; }
die() {
  printf 'harnessd: %s\n' "$*" >&2
  exit 1
}
# Prints a command, then runs it.
run() {
  printf '+ %s\n' "$*"
  "$@"
}
has() { command -v "$1" >/dev/null 2>&1; }

YES=0
for arg in "$@"; do
  case $arg in --yes | -y) YES=1 ;; esac
done

# Under `curl | sh` stdin is the script itself, so questions go to the terminal.
TTY=""
if (: </dev/tty) 2>/dev/null; then TTY=/dev/tty; fi

# ask "question": yes with --yes, else asks on the terminal; no terminal means no.
ask() {
  [ "$YES" = 1 ] && return 0
  [ -n "$TTY" ] || return 1
  printf '%s [y/N] ' "$1" >"$TTY"
  read -r answer <"$TTY" || return 1
  case $answer in [yY] | [yY][eE][sS]) return 0 ;; esac
  return 1
}

# The major version of the node on PATH; 0 when there is none.
node_major() {
  v=0
  if has node; then v=$(node -v 2>/dev/null || echo v0); fi
  v=${v#v}
  v=${v%%.*}
  case $v in '' | *[!0-9]*) v=0 ;; esac
  echo "$v"
}

install_with_brew() {
  run brew install "node@$NODE_MAJOR"
  # node@24 is keg-only; link it so new shells (and the launchd service) find it.
  run brew link --overwrite --force "node@$NODE_MAJOR" || say "brew link failed; continuing"
  if [ "$(node_major)" -lt "$NODE_MAJOR" ]; then
    # An older node comes first on PATH (nvm, an old pkg): use the keg for this run.
    PATH="$(brew --prefix "node@$NODE_MAJOR")/bin:$PATH"
    export PATH
  fi
}

install_with_pkg() {
  has curl || die "curl is needed to download Node $NODE_MAJOR."
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  run curl -fsSL "$NODE_DIST/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  line=$(grep ' node-v[0-9.]*\.pkg$' "$tmp/SHASUMS256.txt" | head -n 1)
  [ -n "$line" ] || die "no .pkg listed in $NODE_DIST/SHASUMS256.txt"
  sum=${line%% *}
  pkg=${line##* }
  run curl -fsSL "$NODE_DIST/$pkg" -o "$tmp/$pkg"
  actual=$(shasum -a 256 "$tmp/$pkg")
  [ "${actual%% *}" = "$sum" ] || die "checksum mismatch for $pkg; nothing installed."
  say "Installing $pkg needs sudo. It will run:"
  say "  sudo installer -pkg $tmp/$pkg -target /"
  ask "Run it with sudo?" ||
    die "Node not installed. Re-run with --yes, or install Node $NODE_MAJOR from https://nodejs.org and re-run."
  run sudo installer -pkg "$tmp/$pkg" -target /
  if [ "$(node_major)" -lt "$NODE_MAJOR" ] && [ -x /usr/local/bin/node ]; then
    PATH="/usr/local/bin:$PATH"
    export PATH
  fi
}

major=$(node_major)
if [ "$major" -ge "$NODE_MAJOR" ]; then
  say "node $(node -v) found"
else
  if [ "$major" = 0 ]; then
    say "node not found; installing Node $NODE_MAJOR"
  else
    say "node $(node -v) is older than $NODE_MAJOR; installing Node $NODE_MAJOR"
  fi
  if has brew; then
    install_with_brew
  elif [ "$(uname -s)" = Darwin ]; then
    install_with_pkg
  else
    die "Install Node $NODE_MAJOR (https://nodejs.org or your package manager), then re-run."
  fi
  [ "$(node_major)" -ge "$NODE_MAJOR" ] || die "Node $NODE_MAJOR is still not first on PATH."
  say "node $(node -v) ready"
fi

has npx || die "npx not found next to node; reinstall Node $NODE_MAJOR."
if [ -n "$TTY" ]; then
  run npx -y @harnessd/cli@latest init "$@" <"$TTY"
else
  run npx -y @harnessd/cli@latest init "$@"
fi
