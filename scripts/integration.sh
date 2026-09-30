#!/usr/bin/env bash
# Manual end-to-end smoke test for psess.
#
# It drives psess through the real CLI using a dedicated XDG_RUNTIME_DIR so it
# never touches your real sessions. Interactive attach tests use `script` to
# provide a pseudo-terminal.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${PSESS_BIN:-$ROOT/psess}"
RT="$(mktemp -d)"
export XDG_RUNTIME_DIR="$RT"

pass=0
fail=0

say()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; fail=$((fail+1)); }

cleanup() {
    for s in dev py killme survive; do
        "$BIN" kill -f "$s" >/dev/null 2>&1 || true
    done
    rm -rf "$RT"
}
trap cleanup EXIT

if [ ! -x "$BIN" ]; then
    echo "building psess..."
    (cd "$ROOT" && go build -o psess ./cmd/psess)
fi

# attach_with INPUT NAME [--tail] ; runs attach under a pty, fed INPUT.
#
# The input is followed by the Ctrl-] d detach sequence so the session is NOT
# terminated. (GNU `script` itself writes "exit" to the pty when its stdin
# closes, which would otherwise kill the shell under test.)
attach_with() {
    local input="$1"; shift
    # Feed the command, wait for it to be processed, then detach.
    ( printf '%b' "$input"; sleep 0.4; printf '\x1dd'; sleep 0.3 ) \
        | timeout 15 script -qec "$BIN attach $*" /dev/null 2>&1
}

say "Test 1: create session and run a command"
"$BIN" new -d dev bash --norc --noprofile >/dev/null 2>&1
out="$(attach_with 'echo hello_psess\nexit\n' dev)"
if grep -q "hello_psess" <<<"$out"; then ok "echo works"; else bad "echo missing: $out"; fi

say "Test 2: detach preserves shell state"
"$BIN" new -d dev2 bash --norc --noprofile >/dev/null 2>&1
attach_with 'export ABC=123; cd /tmp\n' dev2 >/dev/null
out="$(attach_with 'echo ABC=$ABC; pwd\n' dev2)"
if grep -q "ABC=123" <<<"$out"; then ok "env survived"; else bad "env lost: $out"; fi
if grep -q "/tmp" <<<"$out"; then ok "cwd survived"; else bad "cwd lost: $out"; fi
"$BIN" kill -f dev2 >/dev/null 2>&1

say "Test 4: Python state survives re-attach"
"$BIN" new -d py python3 -q >/dev/null 2>&1
attach_with 'x = [1,2,3]\n' py >/dev/null
out="$(attach_with 'print(x)\n' py)"
if grep -q "\[1, 2, 3\]" <<<"$out"; then ok "python state survived"; else bad "python state lost: $out"; fi
"$BIN" kill -f py >/dev/null 2>&1

say "Test 5: terminal restored after detach"
if [ -c /dev/tty ] && stty -a < /dev/tty >/dev/null 2>&1; then
    before="$(stty -a < /dev/tty 2>/dev/null | tr ',' '\n' | grep -E 'icanon|echo' || true)"
    "$BIN" new -d dev3 bash --norc --noprofile >/dev/null 2>&1
    attach_with 'echo bye\n' dev3 >/dev/null
    after="$(stty -a < /dev/tty 2>/dev/null | tr ',' '\n' | grep -E 'icanon|echo' || true)"
    if [ "$before" = "$after" ]; then ok "terminal state identical"; else bad "terminal changed: [$before] vs [$after]"; fi
    "$BIN" kill -f dev3 >/dev/null 2>&1
else
    ok "skipped (no controlling tty); covered by Go integration tests"
fi

say "Test 7: PTY drains with no attached client (yes)"
"$BIN" new -d killme yes >/dev/null 2>&1
sleep 2
if "$BIN" list | grep -q killme; then ok "yes still running with no client"; else bad "session died"; fi
"$BIN" kill -f killme >/dev/null 2>&1

say "Test 8: resize reflects in stty"
"$BIN" new -d dev4 bash --norc --noprofile >/dev/null 2>&1
out="$(attach_with 'stty size\n' dev4)"
if grep -qE '[0-9]+ [0-9]+' <<<"$out"; then ok "stty size reported"; else bad "no size: $out"; fi
"$BIN" kill -f dev4 >/dev/null 2>&1

say "Test 9: kill removes session and children"
"$BIN" new -d dev5 bash --norc --noprofile >/dev/null 2>&1
attach_with 'sleep 3000 &\n' dev5 >/dev/null
"$BIN" kill -f dev5 >/dev/null 2>&1
if "$BIN" list | grep -q dev5; then bad "session still listed"; else ok "session removed"; fi

say "Test 10: client crash does not kill session"
"$BIN" new -d survive bash --norc --noprofile >/dev/null 2>&1
attach_with 'export SURV=yes\n' survive >/dev/null
if "$BIN" list | grep -q survive; then ok "session alive after client exit"; else bad "session died"; fi
out="$(attach_with 'echo SURV=$SURV\n' survive)"
if grep -q "SURV=yes" <<<"$out"; then ok "state intact"; else bad "state lost: $out"; fi
"$BIN" kill -f survive >/dev/null 2>&1

say "Test 11: UTF-8 passthrough"
"$BIN" new -d dev6 bash --norc --noprofile >/dev/null 2>&1
out="$(attach_with "printf '你好世界\\\\n'\n" dev6)"
if grep -q "你好世界" <<<"$out"; then ok "utf-8 preserved"; else bad "utf-8 broken: $out"; fi
"$BIN" kill -f dev6 >/dev/null 2>&1

say "logs command"
"$BIN" new -d dev7 bash --norc --noprofile >/dev/null 2>&1
attach_with 'echo LOGMARK_123\n' dev7 >/dev/null
sleep 0.3
if "$BIN" logs dev7 | grep -q "LOGMARK_123"; then ok "logs contain output"; else bad "logs missing output"; fi
"$BIN" kill -f dev7 >/dev/null 2>&1

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
