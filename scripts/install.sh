#!/usr/bin/env bash
# Build and install psess.
set -euo pipefail

PREFIX="${PREFIX:-$HOME/.local}"
BINDIR="$PREFIX/bin"

cd "$(dirname "$0")/.."

echo "building psess..."
# CGO_ENABLED=0 produces a fully static, self-contained binary.
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o psess ./cmd/psess

mkdir -p "$BINDIR"
install -m755 psess "$BINDIR/psess"
echo "installed $BINDIR/psess"

# --- prompt prefix in ~/.bashrc ---------------------------------------------
#
# Make interactive bash show the psess session name in the prompt, e.g.
#   <dev> user@host:~$
# This is a one-time idempotent edit: the snippet is wrapped in markers and is
# only appended when those markers are not already present. psess itself needs
# no special handling -- every new shell reads ~/.bashrc and sees $PSESS_SESSION
# which the session daemon injects.
BASHRC="$HOME/.bashrc"
START_MARKER="# >>> psess prompt >>>"
END_MARKER="# <<< psess prompt <<<"

inject_prompt() {
    if [ ! -e "$BASHRC" ]; then
        : > "$BASHRC"
    fi
    if grep -qF "$START_MARKER" "$BASHRC"; then
        echo "prompt prefix already present in $BASHRC (skipped)"
        return
    fi
    {
        printf '\n%s\n' "$START_MARKER"
        printf '%s\n' '[ -n "$PSESS_SESSION" ] && PS1="<$PSESS_SESSION> $PS1"'
        printf '%s\n' "$END_MARKER"
    } >> "$BASHRC"
    echo "added psess prompt prefix to $BASHRC"
    echo "  (remove the lines between $START_MARKER and $END_MARKER to undo)"
}

inject_prompt

if ! echo "$PATH" | tr ':' '\n' | grep -qx "$BINDIR"; then
    echo
    echo "note: $BINDIR is not on your PATH."
    echo "add this to your shell profile:"
    echo "  export PATH=\"$BINDIR:\$PATH\""
fi
