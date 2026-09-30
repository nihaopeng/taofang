# psess — Persistent PTY Session Manager

`psess` is a **lightweight persistent PTY supervisor**. It keeps an
interactive process (and its PTY) alive independently of the terminal or SSH
connection that started it, so you can detach and re-attach later.

## psess is NOT tmux

This is the single most important thing to understand about this project.

| tmux / screen / zellij | psess |
| --- | --- |
| Persistent **virtual terminal** | Persistent **PTY owner** |
| Maintains a simulated screen buffer | Transparent raw byte stream |
| Parses ANSI / VT / CSI / OSC | Parses nothing |
| Owns scrollback, copy mode, mouse | Owns none of those |
| Changes `TERM` (e.g. `tmux-256color`) | Leaves `TERM` untouched |
| Panes / windows / layouts | None |

The real terminal emulator always stays in charge of rendering, scrolling,
selection, the system clipboard, IME and mouse handling. `psess` never
interprets or rewrites the byte stream.

### What psess does **not** guarantee

- **No terminal screen restoration.** After re-attaching you may see an
  incomplete screen. This is expected. Press `Ctrl-L` or the application's
  own redraw key.
- **No persistent terminal state.** Cursor position, colors and alternate
  screen are not saved.
- **No reboot survival.** "Persistent" means "beyond the terminal/SSH
  lifecycle", not across a machine reboot.
- **Multiple simultaneous clients are allowed**, but they share one PTY:
  output is mirrored to all of them and all of their input is merged into the
  same session. There is no per-window screen. A new attach replays up to
  4 MiB of recent raw output (disable with `--no-replay`), which works well for
  line-oriented programs (shells, REPLs, log streams) and may look garbled for
  full-screen TUIs, which need a `Ctrl-L` redraw.

What *does* survive a detach: the process, its PTY, the shell's `cwd`,
environment, in-memory shell history and child processes, plus up to 4 MiB of
recent raw output.

---

## Install

Requires Go 1.24+.

```sh
git clone https://github.com/nihaopeng/taofang.git
cd taofang
git checkout psess
go build -o psess ./cmd/psess
install -m755 psess "$HOME/.local/bin/psess"
```

Or use the helper script:

```sh
./scripts/install.sh
```

### Single static binary

`psess` compiles to **one self-contained executable** — all Go sources and
dependencies (`creack/pty`, `x/term`) are linked in; there is no runtime data
directory of scripts or libraries to install. To produce a fully static,
portable binary (no libc dependency at all):

```sh
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o psess ./cmd/psess
```

This yields a single ~2.7 MB `psess` binary that can be copied to any machine
with the same OS/architecture and run directly. Cross-compile with `GOOS`/`GOARCH`
as usual.

> Note: the hidden `psess __daemon` process is **the same binary** re-executed.
> When `psess new` starts a session it re-runs its own executable path, so do
> not delete or move the binary while sessions are running.

## Usage

```sh
psess new <name> [command...]     # create a session (attaches by default)
psess new -d <name> <command>     # create without attaching
psess attach <name>               # attach to a session (replays recent output)
psess attach --no-replay <name>   # attach without replaying recent output
psess list                        # list sessions (alias: ls)
psess kill <name>                 # terminate a session
psess kill -f <name>              # terminate immediately (SIGKILL)
psess logs <name>                 # dump the in-memory recent-output buffer
```

If no command is given, `psess new <name>` starts `$SHELL` (falling back to
`/bin/sh`).

Any number of clients may attach to the same session at the same time. Output
is mirrored to all attached clients and input from all of them is written to
the same PTY, so multiple windows act as views onto one session.

A new attach replays up to 4 MiB of recent raw output before the live stream,
so you land back in context. Because this is a raw byte replay and not a screen
restore, full-screen programs (vim, htop, less) may need a `Ctrl-L` to redraw.
Use `--no-replay` for a clean empty screen.

`psess attach` requires an interactive terminal on stdin; running it with
redirected or closed stdin fails fast with an error instead of occupying the
session.

### Telling whether you are inside a session

For processes started by a session, `psess` sets two environment variables
(mirroring how tmux sets `$TMUX`):

```sh
echo "$PSESS_SESSION"   # session name, e.g. "dev"; empty outside a session
echo "$PSESS"           # "1" inside a session; empty outside
```

Your `TERM`, prompt and other environment are left untouched, so at a plain
shell prompt the two look identical. To make the distinction visible,
`scripts/install.sh` appends an idempotent snippet to `~/.bashrc` so the
session name appears in the prompt:

```
<dev> user@host:~/project$
```

The snippet is wrapped in the markers `# >>> psess prompt >>>` and
`# <<< psess prompt <<<`; remove the lines between them to undo. If you prefer
to add it yourself (or use another shell), the equivalent line is:

```sh
[ -n "$PSESS_SESSION" ] && PS1="<$PSESS_SESSION> $PS1"
```

### Detaching

Press **`Ctrl-]` then `d`**. To send a literal `Ctrl-]` to the program inside
the session, press **`Ctrl-]` then `Ctrl-]`**. Closing the terminal or losing
SSH is equivalent to detaching: the session survives.

Detach from an attached session with **`Ctrl-]` then `d`**. Pressing
`Ctrl-] Ctrl-]` sends a literal `Ctrl-]` to the remote program instead.

### Examples

```sh
psess new dev bash
psess new claude claude --dangerously-skip-permissions
psess new py python
psess new -d server ./run-server
```

### Example session

```
$ psess new dev bash
[psess] attached to session "dev" — detach with Ctrl-] then d

user@host:~$ echo hello
hello
user@host:~$ <Ctrl-] d>
[psess: detached from dev]
$
```

---

## Architecture

```
 terminal client
       │
       ▼
  psess attach          (temporary client, may die at any time)
       │  Unix domain socket (framed binary protocol)
       ▼
  session daemon        (owns the PTY and child process)
       │
       ▼
     PTY master
       │
       ▼
     command
```

- **One session = one daemon process.** There is no master daemon, no global
  state database. A crash in one session cannot affect another.
- **The daemon owns the PTY.** The attach client is disposable; killing it
  (even `kill -9`) does not disturb the session.
- **The daemon always drains the PTY**, even with no client attached.
  Output is appended to a 4 MiB byte ring buffer, so a child that produces
  lots of output never blocks on a full PTY buffer.
- **Backpressure:** a slow client whose pending queue exceeds 8 MiB is
  disconnected rather than blocking the PTY reader.

### Runtime files

Sockets live under `$XDG_RUNTIME_DIR/psess/` (falling back to
`/tmp/psess-$UID/`). The directory is `0700` and each socket is `0600`, so
only the owning user can attach. `psess` never listens on TCP.

### Client/daemon protocol

A minimal framed protocol: `1 byte type | 4 byte big-endian length | payload`.
No gRPC, HTTP, JSON or protobuf. See `internal/protocol`.

### Process model & signals

The child is started with `setsid`, becoming the leader of a fresh session and
process group. This means:

- closing the terminal or killing the launching shell does not SIGHUP the
  session;
- `psess kill` signals the whole process group, so descendants (`node`,
  `python`, background jobs) are terminated too.

The daemon escalates `SIGTERM` → `SIGKILL` after a grace period.

---

## Terminal safety

This is the most reliability-critical part of the project. The attach client:

- saves the terminal state and switches to raw mode only when stdin is a TTY;
- restores the terminal on **every** exit path via `defer`: normal detach,
  daemon disconnect, EOF, socket error, `SIGINT`/`SIGTERM`/`SIGHUP`, and
  command exit.

It must never leave the terminal in `-echo` / `-icanon` state.

Detach sequences are handled entirely by the client, never by the daemon, so
the remote program never sees the detach key press.

---

## Scope

`psess` deliberately does **not** implement, and will not accept:
panes, windows, layouts, splits, terminal rendering, copy mode, scrollback UI,
mouse support, keymap configuration, **screen restore**, ANSI parsing,
network/TCP attach, authentication, encryption, cross-host attach, daemon crash
recovery, session migration or a web UI.

(Sharing a PTY between multiple attached clients is supported, but that is
mirroring a byte stream -- not a virtual terminal and not screen restore.)

If a future change cannot be described by this sentence, it is scope creep:

> `psess` is a lightweight persistent PTY supervisor. It lets interactive
> processes outlive the terminal/SSH connection that started them and be
> re-attached later; it does not emulate a terminal, maintain screen state, or
> take over the clipboard or terminal UI.

---

## Testing

```sh
go test ./...          # unit + end-to-end integration tests
./scripts/integration.sh   # manual end-to-end smoke test
```

The integration tests exercise: create/detach/re-attach state persistence,
listing, ring-buffer logs and default replay, multiple clients receiving the
same broadcast output, process-group kill, survival of
a `kill -9`'d client, exit-code propagation, duplicate-session rejection,
UTF-8 pass-through, resize, PTY draining with no client, and daemon survival
after the launcher dies.

## License

MIT
