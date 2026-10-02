package client

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/nihaopeng/psess/internal/daemon"
	"github.com/nihaopeng/psess/internal/protocol"
	"github.com/nihaopeng/psess/internal/runtime"
)

func socketPathFor(name string) (string, error) {
	return runtime.SocketPath(name)
}

// New creates and starts a session. When attach is true it immediately
// attaches; otherwise it returns once the session is ready.
func New(name string, argv []string, detach bool) error {
	if err := runtime.ValidateName(name); err != nil {
		return err
	}
	if len(argv) == 0 {
		return errors.New("no command given; usage: psess new NAME COMMAND [ARGS...]")
	}

	sockPath, err := runtime.SocketPath(name)
	if err != nil {
		return err
	}
	// Detect an existing live session.
	if conn, derr := net.Dial("unix", sockPath); derr == nil {
		_ = conn.Close()
		return fmt.Errorf("session %q already exists", name)
	}
	// Remove a stale socket if present.
	if _, serr := os.Stat(sockPath); serr == nil {
		fmt.Fprintf(os.Stderr, "psess: removed stale session socket %q\n", name)
		_ = os.Remove(sockPath)
	}

	rows, cols := uint16(24), uint16(80)
	if isTerminal(int(os.Stdout.Fd())) {
		if r, c, gerr := terminalSize(int(os.Stdout.Fd())); gerr == nil {
			rows, cols = r, c
		}
	}

	// Pipe used by the daemon to signal readiness.
	pr, pw, err := os.Pipe()
	if err != nil {
		return err
	}
	defer pr.Close()

	exe, err := os.Executable()
	if err != nil {
		pw.Close()
		return err
	}

	argvStr := make([]string, 0, len(argv)+4)
	argvStr = append(argvStr, "__daemon")
	argvStr = append(argvStr, "--name", name)
	argvStr = append(argvStr, fmt.Sprintf("--rows=%d", rows))
	argvStr = append(argvStr, fmt.Sprintf("--cols=%d", cols))
	argvStr = append(argvStr, "--")
	argvStr = append(argvStr, argv...)

	cmd := exec.Command(exe, argvStr...)
	cmd.Stdin = nil
	cmd.Stdout = nil

	// The daemon must not inherit the launching process's stdout/stderr:
	// those may be pipes owned by the caller, and holding them open would
	// block the caller's Wait() forever. Startup errors are reported over the
	// readiness pipe instead.
	devnull, derr := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if derr == nil {
		defer devnull.Close()
		cmd.Stderr = devnull
	} else {
		cmd.Stderr = nil
	}
	cmd.ExtraFiles = []*os.File{pw} // becomes fd 3 in the child
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Env = os.Environ()

	if err := cmd.Start(); err != nil {
		pw.Close()
		return fmt.Errorf("start daemon: %w", err)
	}
	// Parent no longer needs the write end.
	pw.Close()

	// Wait for READY byte, with a timeout. First byte 0x01 means ready,
	// 0x00 means failure followed by a message.
	readyCh := make(chan error, 1)
	go func() {
		buf := make([]byte, 1)
		n, rerr := pr.Read(buf)
		if rerr != nil {
			readyCh <- rerr
			return
		}
		if n != 1 {
			readyCh <- errors.New("daemon did not signal readiness")
			return
		}
		if buf[0] == 0x01 {
			readyCh <- nil
			return
		}
		msg, _ := io.ReadAll(pr)
		readyCh <- fmt.Errorf("daemon startup failed: %s", strings.TrimSpace(string(msg)))
	}()

	select {
	case err := <-readyCh:
		if err != nil {
			return fmt.Errorf("daemon failed to become ready: %w", err)
		}
	case <-time.After(10 * time.Second):
		return errors.New("timed out waiting for daemon to become ready")
	}

	// Reap the daemon in the background so we do not leave zombies if it dies
	// while we are still attached.
	go func() { _ = cmd.Wait() }()

	if detach {
		fmt.Printf("[psess: created session %s]\n", name)
		return nil
	}

	code, exited, err := Attach(name, true)
	if err != nil {
		return err
	}
	if exited {
		fmt.Fprintf(os.Stderr, "[psess: session %s exited with code %d]\n", name, code)
	} else {
		fmt.Printf("[psess: detached from %s]\n", name)
	}
	return nil
}

// List prints all known sessions.
func List() error {
	dir, err := runtime.Dir()
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}

	var statuses []daemon.Status
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".sock") {
			continue
		}
		name := strings.TrimSuffix(e.Name(), ".sock")
		sockPath := filepath.Join(dir, e.Name())
		st, err := queryStatus(sockPath)
		if err != nil {
			// Stale socket: remove it.
			if _, serr := os.Stat(sockPath); serr == nil {
				fmt.Fprintf(os.Stderr, "psess: removed stale session socket %q\n", name)
				_ = os.Remove(sockPath)
			}
			continue
		}
		statuses = append(statuses, st)
	}

	sort.Slice(statuses, func(i, j int) bool { return statuses[i].Name < statuses[j].Name })

	fmt.Printf("%-16s %-8s %-10s %-9s %s\n", "NAME", "PID", "STATUS", "ATTACHED", "COMMAND")
	for _, st := range statuses {
		status := "running"
		if st.Exited {
			status = fmt.Sprintf("exited(%d)", st.ExitCode)
		}
		attached := "no"
		if st.Attached {
			attached = "yes"
		}
		fmt.Printf("%-16s %-8d %-10s %-9s %s\n", st.Name, st.PID, status, attached, st.Command)
	}
	return nil
}

// Kill terminates a session. The daemon forwards the request to the child's
// process group, escalating to SIGKILL after a grace period unless force is
// requested.
func Kill(name string, force bool) error {
	sockPath, err := runtime.SocketPath(name)
	if err != nil {
		return err
	}
	conn, err := net.Dial("unix", sockPath)
	if err != nil {
		return fmt.Errorf("session %q does not exist", name)
	}
	defer conn.Close()

	if err := protocol.WriteFrame(conn, protocol.TypeHello, protocol.EncodeHello(protocol.ModeKill)); err != nil {
		return err
	}
	flag := byte(0)
	if force {
		flag = 1
	}
	if err := protocol.WriteFrame(conn, protocol.TypeKill, []byte{flag}); err != nil {
		return err
	}

	// Wait briefly for the daemon to clean up its socket.
	waitSocketGone(sockPath, 5*time.Second)
	fmt.Printf("[psess: killed session %s]\n", name)
	return nil
}

// Logs writes the session's recent output to stdout.
func Logs(name string) error {
	sockPath, err := runtime.SocketPath(name)
	if err != nil {
		return err
	}
	conn, err := net.Dial("unix", sockPath)
	if err != nil {
		return fmt.Errorf("session %q does not exist", name)
	}
	defer conn.Close()

	if err := protocol.WriteFrame(conn, protocol.TypeHello, protocol.EncodeHello(protocol.ModeLog)); err != nil {
		return err
	}
	frame, err := protocol.ReadFrame(conn)
	if err != nil {
		return err
	}
	if frame.Type != protocol.TypeLogData {
		return fmt.Errorf("unexpected response from session %q", name)
	}
	_, err = os.Stdout.Write(frame.Payload)
	return err
}

// sendChunkSize bounds each STDIN frame sent by Send. It is well below
// protocol.MaxPayload and large enough to keep the frame count low.
const sendChunkSize = 64 << 10

// Send injects data into a session's PTY without attaching. It is the client
// half of `psess send`.
//
// The bytes reach exactly the same place as keystrokes typed while attached:
// Send has no idea what is running in the session, and does not wait for the
// program to consume the input. A nil error means the daemon wrote the bytes
// to the PTY master and acknowledged it, not that the program acted on them.
func Send(name string, data []byte) error {
	sockPath, err := runtime.SocketPath(name)
	if err != nil {
		return err
	}
	conn, err := net.Dial("unix", sockPath)
	if err != nil {
		return fmt.Errorf("session %q does not exist", name)
	}
	defer conn.Close()

	if err := protocol.WriteFrame(conn, protocol.TypeHello, protocol.EncodeHello(protocol.ModeSend)); err != nil {
		return err
	}

	// Stream the payload in bounded frames.
	for len(data) > 0 {
		n := len(data)
		if n > sendChunkSize {
			n = sendChunkSize
		}
		if err := protocol.WriteFrame(conn, protocol.TypeStdin, data[:n]); err != nil {
			return err
		}
		data = data[n:]
	}

	// Half-close so the daemon knows the payload is complete; it treats EOF as
	// "done sending". Failing to half-close would leave the daemon waiting.
	if uc, ok := conn.(*net.UnixConn); ok {
		_ = uc.CloseWrite()
	}

	// Wait for the daemon's acknowledgement (HELLO_OK) or an error.
	for {
		frame, rerr := protocol.ReadFrame(conn)
		if rerr != nil {
			if errors.Is(rerr, io.EOF) || errors.Is(rerr, io.ErrUnexpectedEOF) {
				return errors.New("session closed before acknowledging the input")
			}
			return rerr
		}
		if frame.Type == protocol.TypeError {
			return errors.New(string(frame.Payload))
		}
		if frame.Type == protocol.TypeHelloOK {
			return nil
		}
	}
}

// queryStatus connects and requests a one-shot status.
func queryStatus(sockPath string) (daemon.Status, error) {
	var st daemon.Status
	conn, err := net.Dial("unix", sockPath)
	if err != nil {
		return st, err
	}
	defer conn.Close()
	if err := protocol.WriteFrame(conn, protocol.TypeHello, protocol.EncodeHello(protocol.ModeStatus)); err != nil {
		return st, err
	}
	frame, err := protocol.ReadFrame(conn)
	if err != nil {
		return st, err
	}
	if frame.Type != protocol.TypeSessionInfo {
		return st, fmt.Errorf("unexpected status frame")
	}
	return daemon.DecodeStatus(frame.Payload)
}

func waitSocketGone(path string, timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); os.IsNotExist(err) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}
