# psess architecture

This document explains *how* `psess` fulfils the promise described in
`README.md`: persistent PTY lifetime with an opaque byte stream and no terminal
emulation.

## 1. Two processes, one session

```
 psess new ──spawn──► psess __daemon ──fork/exec──► child (bash/python/...)
     │                       │
     │ attach                │ owns PTY master
     ▼                       │
 psess attach ──socket──►  daemon
```

- `psess new` forks a **daemon** (`psess __daemon`) and waits for a readiness
  byte, so by the time the command returns the session is attachable.
- The daemon creates the PTY, starts the child on it, then serves a Unix socket.
- `psess attach` is a **temporary client**. It can be killed at any time; the
  daemon and child are unaffected.

## 2. Package layout

```
cmd/psess/main.go              CLI dispatch, hidden __daemon entrypoint
internal/runtime/paths.go      XDG runtime dir, socket paths, name validation
internal/protocol/             framed wire format, message/type definitions
internal/ring/                 fixed-size byte ring buffer
internal/daemon/               session owner: PTY, child, socket server
internal/client/               CLI operations: new/attach/list/kill/logs
```

## 3. The daemon

A daemon is created per session. It runs four concerns concurrently:

```
main goroutine ── accept loop ──► per-connection handlers
     │
     ├── PTY reader goroutine   (single reader of the PTY master)
     ├── child wait goroutine   (reaps the child, records exit code)
     └── client writer goroutine (drains per-client output queue)
```

- **PTY reader** is the *only* reader of the PTY master. Under a single lock
  it appends every chunk to the ring buffer and enqueues it to every attached
  client. This goroutine runs for the entire lifetime of the session, so a
  child that writes lots of output never blocks on a full PTY kernel buffer.
- **Child waiter** calls `cmd.Wait()`, records the exit code, briefly drains
  remaining output, notifies all clients with an EXIT frame and closes the
  session.
- **Client writers** each own their socket write side. A client pulls from its
  own byte queue. If the queue would exceed 8 MiB the client is disconnected,
  which protects the PTY reader from a slow client.

Any number of clients may be attached simultaneously. Output is broadcast to
all of them and input from all of them is written to the same PTY. Writes to
the PTY master are serialized by a single mutex, so a payload from one client
(or from `psess send`) is never interleaved byte-for-byte with another's.

### Attach ordering (no duplicates, no gaps)

A new client must receive recent history *and* the live stream without seeing
any byte twice or missing one. This is achieved by performing the ring-buffer
append + client broadcast and the replay-snapshot + client-registration under
the **same lock**:

1. The PTY reader takes `s.mu`, appends the chunk to the ring and enqueues it
   to all registered clients.
2. A new client takes `s.mu`, snapshots up to 4 MiB from the ring into its own
   queue, and registers itself.

Because both use `s.mu`, a chunk lands either wholly in the replay snapshot or
wholly in the live queue -- never both, never neither.

## 4. Lifetime and signals

- The child is launched with `setsid` (new session + process group leader), so
  the daemon's controlling terminal going away cannot SIGHUP it, and
  `psess kill` can signal the whole group.
- `psess kill` connects to the daemon and asks it to terminate the child's
  process group: `SIGTERM`, then `SIGKILL` after a grace period (or immediately
  with `-f`). Descendants are included because the signal targets `-pgid`.
- The daemon treats `SIGTERM`/`SIGINT`/`SIGHUP` as "end the session" and kills
  the child group before exiting, preventing orphans.

### Child environment

The child inherits the daemon's environment (which is the environment of
`psess new`) with two additions, so processes can detect that they run under
psess:

- `PSESS_SESSION=<name>`
- `PSESS=1`

Any inherited value of these two variables is replaced. Everything else --
notably `TERM` -- is left exactly as the user's terminal set it; psess never
masquerades as `tmux-256color` or `screen`, because there is no virtual
terminal.

## 5. Wire protocol

```
1 byte type | 4 bytes big-endian payload length | payload
```

| type | direction | purpose |
| --- | --- | --- |
| `0x01` HELLO | client → daemon | `[version, mode]` |
| `0x02` HELLO_OK | daemon → client | handshake accepted |
| `0x10` STDIN | client → daemon | raw bytes → PTY master |
| `0x11` STDOUT | daemon → client | raw PTY bytes → stdout |
| `0x20` RESIZE | client → daemon | `[uint16 rows, uint16 cols]` |
| `0x30` DETACH | client → daemon | graceful detach |
| `0x40` SESSION_INFO | daemon → client | status blob |
| `0x41` EXIT | daemon → client | `int32 exit code` |
| `0x50` REQUEST_LOG | client → daemon | request ring buffer |
| `0x51` LOG_DATA | daemon → client | ring buffer bytes |
| `0x52` KILL | client → daemon | `[force]` |
| `0x60` ERROR | daemon → client | human-readable error |

Modes: attach, attach-with-replay, status, log, kill, send.

The `send` mode reuses the `STDIN` frame: the client streams zero or more
`STDIN` frames and then half-closes its side of the socket. The daemon writes
each frame to the PTY master and replies with `HELLO_OK` to acknowledge that
the bytes were handed to the PTY (it does not know whether the program acted on
them). It never parses the payload and never checks what is running in the
session, so the bytes land wherever typed input would.

## 6. Terminal safety

The attach client:

1. Saves the termios state with `term.GetState`.
2. Enters raw mode with `term.MakeRaw`.
3. `defer`s `term.Restore`.
4. On restore, also writes a fixed escape sequence that turns off the
   terminal-wide input modes a full-screen program may have enabled: mouse
   tracking (`?1000/1002/1003/1005/1006/1015`), focus reporting (`?1004`),
   bracketed paste (`?2004`) and the kitty keyboard protocol (`CSI < u`).

Step 4 matters because those DECSET/kitty escapes live in the **real** terminal
emulator, not in the PTY. psess forwards them untouched; `term.Restore` only
resets termios and cannot clear them, so an app that crashes or is killed
before disabling them would otherwise leave the terminal injecting mouse
events and key-release reports into the next shell (see `terminalModeResets`
in `internal/client/terminal.go`).

Additionally a signal handler for `SIGINT`/`SIGTERM`/`SIGHUP` restores the
terminal and exits, so an externally killed client cannot leave the terminal in
raw mode. `restore` is guarded by a `sync.Once`, so the deferred path and the
signal path cannot race. On the normal detach path the terminal is restored
before any status line is printed.

## 7. Detach state machine

The client, not the daemon, interprets detach keys:

```
NORMAL  --Ctrl-]-->  ESCAPE
ESCAPE  --d------->  detach
ESCAPE  --Ctrl-]-->  send literal Ctrl-]
ESCAPE  --other----> send Ctrl-] then the byte
```

This is not a terminal parser — it recognises exactly two byte values and
otherwise forwards bytes untouched.

## 8. Ring buffer

A `sync.Mutex`-guarded fixed-size circular byte buffer (4 MiB). It is
byte-oriented; it never aligns writes to UTF-8, line or ANSI boundaries.
`attach-with-replay` replays at most the last 4 MiB on attach (the whole ring
buffer). Replay is explicitly
best-effort and is not a screen restoration.

## 9. Runtime layout

```
$XDG_RUNTIME_DIR/psess/
├── dev.sock      (0600)
└── claude.sock   (0600)
```

The directory is `0700`. `psess list` scans `*.sock`, queries each daemon, and
removes sockets that cannot be connected to (stale sockets left by a crashed
daemon). PID files are deliberately not used, because PIDs can be recycled.
