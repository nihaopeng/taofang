package client

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"syscall"

	"github.com/nihaopeng/psess/internal/protocol"
)

// Detach keys. Ctrl-] (0x1d) enters an escape state; pressing 'd' detaches and
// pressing Ctrl-] again sends a literal Ctrl-] to the remote program.
const (
	keyCtrlBracket = 0x1d
	keyD           = 'd'
)

// ErrDetached is returned by Attach when the user requested a detach.
var ErrDetached = errors.New("detached")

// Attach connects to the named session and proxies the terminal until the user
// detaches, the session exits, or the connection fails.
//
// It returns the child's exit code and whether the session has exited.
func Attach(name string, tail bool) (exitCode int, exited bool, err error) {
	// attach requires an interactive terminal: without one there is no way to
	// forward keystrokes and the session would be occupied for nothing.
	if !isTerminal(int(os.Stdin.Fd())) {
		return 0, false, errors.New("stdin is not a terminal; attach requires an interactive terminal")
	}

	sockPath, err := socketPathFor(name)
	if err != nil {
		return 0, false, err
	}
	conn, err := net.Dial("unix", sockPath)
	if err != nil {
		return 0, false, fmt.Errorf("session %q does not exist", name)
	}
	defer conn.Close()

	mode := protocol.ModeAttach
	if tail {
		mode = protocol.ModeAttachWithTail
	}
	if err := protocol.WriteFrame(conn, protocol.TypeHello, protocol.EncodeHello(mode)); err != nil {
		return 0, false, err
	}

	// Wait for the daemon's HELLO_OK (or ERROR).
	frame, err := protocol.ReadFrame(conn)
	if err != nil {
		return 0, false, err
	}
	switch frame.Type {
	case protocol.TypeError:
		return 0, false, errors.New(string(frame.Payload))
	case protocol.TypeHelloOK:
	default:
		return 0, false, fmt.Errorf("unexpected frame from daemon: %#x", frame.Type)
	}

	fmt.Printf("[psess] attached to session %q — detach with Ctrl-] then d\r\n", name)

	// Enter raw mode.
	ts, err := makeRaw(int(os.Stdin.Fd()))
	if err != nil {
		return 0, false, fmt.Errorf("failed to set raw mode: %w", err)
	}
	// Guarantee terminal restoration on every exit path.
	defer ts.restore()

	if rows, cols, serr := terminalSize(int(os.Stdout.Fd())); serr == nil {
		_ = protocol.WriteFrame(conn, protocol.TypeResize, protocol.EncodeResize(rows, cols))
	}

	// Forward SIGWINCH as RESIZE frames.
	sigCh := make(chan os.Signal, 4)
	signal.Notify(sigCh, syscall.SIGWINCH)
	defer signal.Stop(sigCh)
	go func() {
		for range sigCh {
			if rows, cols, serr := terminalSize(int(os.Stdout.Fd())); serr == nil {
				_ = protocol.WriteFrame(conn, protocol.TypeResize, protocol.EncodeResize(rows, cols))
			}
		}
	}()

	// Forward SIGINT/SIGTERM/SIGHUP to a clean detach instead of dying
	// abruptly (terminal restore is still deferred).
	termCh := make(chan os.Signal, 4)
	signal.Notify(termCh, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(termCh)
	go func() {
		<-termCh
		ts.restore()
		os.Exit(0)
	}()

	// Daemon -> stdout.
	outErr := make(chan error, 1)
	go func() {
		outErr <- pumpOutput(conn)
	}()

	// stdin -> daemon, with detach sequence detection.
	inErr := make(chan error, 1)
	go func() {
		inErr <- pumpInput(conn)
	}()

	select {
	case err := <-outErr:
		if errors.Is(err, io.EOF) {
			// Daemon closed: session probably exited. Read is done.
			return 0, true, nil
		}
		if err != nil {
			return 0, false, err
		}
	case err := <-inErr:
		if errors.Is(err, ErrDetached) {
			_ = protocol.WriteFrame(conn, protocol.TypeDetach, nil)
			return 0, false, nil
		}
		if err != nil {
			return 0, false, err
		}
		// stdin reached EOF (terminal closed or input redirected away).
		// Treat it as a detach so the daemon releases the client slot
		// immediately instead of waiting for the socket to be reaped.
		_ = protocol.WriteFrame(conn, protocol.TypeDetach, nil)
		return 0, false, nil
	}
	return 0, false, nil
}

// pumpOutput reads STDOUT/EXIT/ERROR frames and writes them to stdout.
func pumpOutput(conn net.Conn) error {
	for {
		frame, err := protocol.ReadFrame(conn)
		if err != nil {
			return err
		}
		switch frame.Type {
		case protocol.TypeStdout:
			if _, werr := os.Stdout.Write(frame.Payload); werr != nil {
				return werr
			}
		case protocol.TypeExit:
			code, _ := protocol.DecodeExit(frame.Payload)
			fmt.Fprintf(os.Stderr, "\r\n[psess: session exited with code %d]\r\n", code)
			return io.EOF
		case protocol.TypeError:
			fmt.Fprintf(os.Stderr, "\r\n[psess: %s]\r\n", string(frame.Payload))
			return io.EOF
		}
	}
}

// pumpInput reads stdin, applies the detach state machine and forwards input.
func pumpInput(conn net.Conn) error {
	buf := make([]byte, 32*1024)
	escaped := false
	for {
		n, err := os.Stdin.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			out := make([]byte, 0, n)
			for _, b := range chunk {
				if escaped {
					escaped = false
					switch b {
					case keyD:
						return ErrDetached
					case keyCtrlBracket:
						out = append(out, keyCtrlBracket)
					default:
						out = append(out, keyCtrlBracket, b)
					}
					continue
				}
				if b == keyCtrlBracket {
					escaped = true
					continue
				}
				out = append(out, b)
			}
			if len(out) > 0 {
				if werr := protocol.WriteFrame(conn, protocol.TypeStdin, out); werr != nil {
					return werr
				}
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}
