package daemon

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/nihaopeng/psess/internal/protocol"
	"github.com/nihaopeng/psess/internal/ring"
)

// ringSize is the in-memory recent-output buffer size per session.
const ringSize = 4 << 20 // 4 MiB

// maxClientQueue bounds how much undelivered output may accumulate for a slow
// client before it is disconnected. This keeps the PTY reader unblocked.
const maxClientQueue = 8 << 20 // 8 MiB

// replayLimit caps how much recent output is replayed to a newly attached
// client. It matches the ring buffer size (4 MiB), so a fresh attach sees
// everything still buffered.
const replayLimit = ringSize // 4 MiB

// exitGrace is how long the daemon waits after the child exits before the
// session is considered finished, allowing final output to drain.
const exitGrace = 250 * time.Millisecond

// Status is a point-in-time snapshot of a session, reported over the protocol
// and used by `psess list`.
type Status struct {
	Name       string
	PID        int
	Command    string
	StartTime  time.Time
	Attached   bool
	Exited     bool
	ExitCode   int32
	Rows       uint16
	Cols       uint16
	BufferSize int
}

// session owns a single PTY + child process and serves any number of
// simultaneously attached clients.
type session struct {
	name    string
	argv    []string
	cmd     *exec.Cmd
	ptmx    *os.File
	ring    *ring.Buffer
	started time.Time

	mu       sync.Mutex
	clients  map[*clientConn]struct{}
	exited   bool
	exitCode int32
	rows     uint16
	cols     uint16

	// writeMu serializes writes to the PTY master. Every attached client may
	// write input concurrently, and `psess send` adds more writers; without
	// this lock two payloads could interleave byte-for-byte.
	writeMu sync.Mutex

	done   chan struct{} // closed when the child has exited and output drained
	closed bool
}

// newSession creates the PTY and starts the child process.
func newSession(name string, argv []string, rows, cols uint16) (*session, error) {
	if len(argv) == 0 {
		return nil, errors.New("no command given")
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = sessionEnv(name)

	ptmx, err := startPTY(cmd, rows, cols)
	if err != nil {
		return nil, fmt.Errorf("start command: %w", err)
	}

	return &session{
		name:    name,
		argv:    argv,
		cmd:     cmd,
		ptmx:    ptmx,
		ring:    ring.New(ringSize),
		started: time.Now(),
		clients: make(map[*clientConn]struct{}),
		rows:    rows,
		cols:    cols,
		done:    make(chan struct{}),
	}, nil
}

// pid returns the child process id.
func (s *session) pid() int {
	if s.cmd.Process == nil {
		return 0
	}
	return s.cmd.Process.Pid
}

// pgid returns the child process group id. With Setsid the child becomes the
// leader of a new session and process group whose id equals its pid.
func (s *session) pgid() int {
	return s.pid()
}

// readLoop continuously drains the PTY master, appends to the ring buffer and
// broadcasts to all attached clients. It must be the only reader of ptmx.
//
// The ring append and the client broadcast happen under the same lock so that
// a client attaching concurrently either sees a chunk in its replay snapshot
// or receives it live -- never both, never neither.
func (s *session) readLoop() {
	buf := make([]byte, 32*1024)
	for {
		n, err := s.ptmx.Read(buf)
		if n > 0 {
			// Copy the chunk: buf is reused on the next read.
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			s.broadcast(chunk)
		}
		if err != nil {
			return
		}
	}
}

// broadcast appends p to the ring buffer and enqueues it to every attached
// client without blocking. Slow clients are disconnected so the PTY reader
// never stalls.
func (s *session) broadcast(p []byte) {
	s.mu.Lock()
	_, _ = s.ring.Write(p)
	slow := make([]*clientConn, 0)
	for c := range s.clients {
		if !c.enqueue(p) {
			slow = append(slow, c)
		}
	}
	s.mu.Unlock()

	for _, c := range slow {
		s.detachClient(c)
	}
}

// waitLoop waits for the child to exit, records the code, drains briefly and
// finishes the session.
func (s *session) waitLoop() {
	err := s.cmd.Wait()

	code := int32(0)
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			code = int32(ee.ExitCode())
		} else {
			code = -1
		}
	}

	// Give the PTY a moment to deliver the child's final output.
	time.Sleep(exitGrace)

	s.mu.Lock()
	s.exited = true
	s.exitCode = code
	clients := make([]*clientConn, 0, len(s.clients))
	for c := range s.clients {
		clients = append(clients, c)
	}
	s.clients = make(map[*clientConn]struct{})
	s.mu.Unlock()

	// Flush any pending output to each client, then emit EXIT and close.
	for _, c := range clients {
		c.queueExit(code)
	}
	for _, c := range clients {
		c.waitDrained(exitGrace)
	}

	close(s.done)
}

// status returns a snapshot of the session.
func (s *session) status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return Status{
		Name:       s.name,
		PID:        s.pid(),
		Command:    joinArgv(s.argv),
		StartTime:  s.started,
		Attached:   s.attachedLocked(),
		Exited:     s.exited,
		ExitCode:   s.exitCode,
		Rows:       s.rows,
		Cols:       s.cols,
		BufferSize: s.ring.Len(),
	}
}

// attachedLocked reports whether at least one client is attached. Callers must
// hold s.mu.
func (s *session) attachedLocked() bool { return len(s.clients) > 0 }

// attachClient registers c as an attached client. Any number of clients may be
// attached simultaneously; output is broadcast to all of them.
func (s *session) attachClient(c *clientConn) {
	s.mu.Lock()
	s.clients[c] = struct{}{}
	s.mu.Unlock()
}

// attachWithReplay registers c and, when replay is true, seeds its output
// queue with up to maxReplay most recent bytes from the ring buffer.
//
// The snapshot and the registration happen under s.mu, and broadcast() appends
// to the ring and enqueues to clients under the same lock, so a chunk is
// delivered exactly once: either in the replay snapshot or live, never both.
func (s *session) attachWithReplay(c *clientConn, replay bool, maxReplay int) {
	s.mu.Lock()
	if replay {
		if data := s.ring.Tail(maxReplay); len(data) > 0 {
			// Seed directly; the writer goroutine has not started yet.
			c.mu.Lock()
			c.out = append(c.out, data...)
			c.mu.Unlock()
		}
	}
	s.clients[c] = struct{}{}
	s.mu.Unlock()
}

// detachClient removes c and closes its connection.
func (s *session) detachClient(c *clientConn) {
	s.mu.Lock()
	delete(s.clients, c)
	s.mu.Unlock()
	c.close()
}

// resize applies a new window size to the PTY.
func (s *session) resize(rows, cols uint16) {
	s.mu.Lock()
	s.rows = rows
	s.cols = cols
	s.mu.Unlock()
	_ = resizePTY(s.ptmx, rows, cols)
}

// writeStdin forwards input to the PTY master. Writes are serialized so a
// payload from one client is never interleaved with another's mid-payload, and
// a short write is retried. It blocks while the PTY's input buffer is full.
func (s *session) writeStdin(p []byte) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	for len(p) > 0 {
		n, err := s.ptmx.Write(p)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		p = p[n:]
	}
	return nil
}

// terminate signals the entire child process group, escalating to SIGKILL
// after a grace period. It is used by `psess kill`.
func (s *session) terminate(force bool) {
	pgid := s.pgid()
	if pgid <= 0 {
		return
	}
	if force {
		_ = signalGroup(pgid, syscallSIGKILL)
		return
	}
	_ = signalGroup(pgid, syscallSIGTERM)

	select {
	case <-s.done:
		return
	case <-time.After(3 * time.Second):
		_ = signalGroup(pgid, syscallSIGKILL)
	}
}

// closeFinal releases PTY and socket resources. Safe to call once.
func (s *session) closeFinal() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	clients := make([]*clientConn, 0, len(s.clients))
	for c := range s.clients {
		clients = append(clients, c)
	}
	s.clients = make(map[*clientConn]struct{})
	s.mu.Unlock()

	for _, c := range clients {
		c.close()
	}
	_ = s.ptmx.Close()
}

// clientConn is a connected interactive or one-shot client.
type clientConn struct {
	conn net.Conn
	mu   sync.Mutex
	out  []byte
	sig  chan struct{}
	dead bool

	// exit, when >= 0 and set before the queue is drained, causes the writer
	// to emit an EXIT frame after all pending output.
	exit    int32
	hasExit bool
}

func newClientConn(conn net.Conn) *clientConn {
	return &clientConn{conn: conn, sig: make(chan struct{}, 1)}
}

// enqueue appends output to the client's pending queue. It returns false if
// the queue would exceed maxClientQueue (slow client) or the client is dead.
func (c *clientConn) enqueue(p []byte) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.dead {
		return false
	}
	if len(c.out)+len(p) > maxClientQueue {
		return false
	}
	c.out = append(c.out, p...)
	select {
	case c.sig <- struct{}{}:
	default:
	}
	return true
}

// writer drains the pending queue to the socket. When an exit code has been
// queued it emits an EXIT frame after flushing all pending output.
func (c *clientConn) writer() {
	for {
		c.mu.Lock()
		if len(c.out) == 0 {
			if c.hasExit {
				code := c.exit
				c.hasExit = false
				c.mu.Unlock()
				_ = protocol.WriteFrame(c.conn, protocol.TypeExit, protocol.EncodeExit(code))
				c.close()
				return
			}
			if c.dead {
				c.mu.Unlock()
				return
			}
			c.mu.Unlock()
			<-c.sig
			continue
		}
		chunk := c.out
		c.out = nil
		c.mu.Unlock()

		if err := protocol.WriteFrame(c.conn, protocol.TypeStdout, chunk); err != nil {
			c.close()
			return
		}
	}
}

// queueExit schedules an EXIT frame to be sent after pending output.
func (c *clientConn) queueExit(code int32) {
	c.mu.Lock()
	c.exit = code
	c.hasExit = true
	c.mu.Unlock()
	select {
	case c.sig <- struct{}{}:
	default:
	}
}

func (c *clientConn) close() {
	c.mu.Lock()
	if c.dead {
		c.mu.Unlock()
		return
	}
	c.dead = true
	c.mu.Unlock()
	_ = c.conn.Close()
	select {
	case c.sig <- struct{}{}:
	default:
	}
}

func (c *clientConn) isDead() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.dead
}

// waitDrained blocks until the client socket has been closed by the writer or
// the timeout elapses.
func (c *clientConn) waitDrained(timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if c.isDead() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func joinArgv(argv []string) string {
	out := ""
	for i, a := range argv {
		if i > 0 {
			out += " "
		}
		out += a
	}
	return out
}

// sessionEnv builds the environment for the session's child process. It starts
// from the daemon's environment and adds PSESS_SESSION and PSESS so processes
// inside the session can tell that they are running under psess (mirroring how
// tmux sets $TMUX). Any inherited value of these variables is replaced.
func sessionEnv(name string) []string {
	base := os.Environ()
	env := make([]string, 0, len(base)+2)
	for _, kv := range base {
		if strings.HasPrefix(kv, "PSESS_SESSION=") || strings.HasPrefix(kv, "PSESS=") {
			continue
		}
		env = append(env, kv)
	}
	env = append(env, "PSESS_SESSION="+name, "PSESS=1")
	return env
}
