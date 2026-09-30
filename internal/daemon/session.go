package daemon

import (
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
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

// tailReplayLimit caps how much history --tail replays at once.
const tailReplayLimit = 1 << 20 // 1 MiB

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

// session owns a single PTY + child process and serves an optional client.
type session struct {
	name    string
	argv    []string
	cmd     *exec.Cmd
	ptmx    *os.File
	ring    *ring.Buffer
	started time.Time

	mu       sync.Mutex
	client   *clientConn
	exited   bool
	exitCode int32
	rows     uint16
	cols     uint16

	done   chan struct{} // closed when the child has exited and output drained
	closed bool
}

// newSession creates the PTY and starts the child process.
func newSession(name string, argv []string, rows, cols uint16) (*session, error) {
	if len(argv) == 0 {
		return nil, errors.New("no command given")
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = os.Environ()

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
// forwards to the attached client if any. It must be the only reader of ptmx.
func (s *session) readLoop() {
	buf := make([]byte, 32*1024)
	for {
		n, err := s.ptmx.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			_, _ = s.ring.Write(chunk)
			s.forward(chunk)
		}
		if err != nil {
			return
		}
	}
}

// forward queues output for the current client without blocking.
func (s *session) forward(p []byte) {
	s.mu.Lock()
	c := s.client
	s.mu.Unlock()
	if c == nil {
		return
	}
	if !c.enqueue(p) {
		// Slow client: disconnect it rather than blocking the PTY reader.
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
	c := s.client
	s.client = nil
	s.mu.Unlock()

	if c != nil {
		// Flush any pending output, then emit EXIT and close. Wait briefly
		// for the writer to drain so the client sees final output and the
		// exit code rather than a truncated stream.
		c.queueExit(code)
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
		Attached:   s.client != nil,
		Exited:     s.exited,
		ExitCode:   s.exitCode,
		Rows:       s.rows,
		Cols:       s.cols,
		BufferSize: s.ring.Len(),
	}
}

// attachClient registers c as the active client. It returns false if another
// client is already attached.
func (s *session) attachClient(c *clientConn) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.client != nil {
		return false
	}
	s.client = c
	return true
}

// detachClient removes c if it is still the active client.
func (s *session) detachClient(c *clientConn) {
	s.mu.Lock()
	if s.client == c {
		s.client = nil
	}
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

// writeStdin forwards client input to the PTY master.
func (s *session) writeStdin(p []byte) error {
	_, err := s.ptmx.Write(p)
	return err
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
	c := s.client
	s.client = nil
	s.mu.Unlock()

	if c != nil {
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
