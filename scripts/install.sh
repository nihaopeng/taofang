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

if ! echo "$PATH" | tr ':' '\n' | grep -qx "$BINDIR"; then
    echo
    echo "note: $BINDIR is not on your PATH."
    echo "add this to your shell profile:"
    echo "  export PATH=\"$BINDIR:\$PATH\""
fi
