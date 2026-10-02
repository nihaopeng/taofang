package daemon

import (
	"fmt"
	"net"
	"os"
	"os/signal"
	"syscall"

	"github.com/nihaopeng/psess/internal/protocol"
	"github.com/nihaopeng/psess/internal/runtime"
)

// Params configures a daemon run.
type Params struct {
	Name string
	Argv []string
	Rows uint16
	Cols uint16

	// ReadyFD, when >= 0, is a pipe write end the daemon signals once the
	// session is listening and attachable. It is used by `psess new`.
	ReadyFD int
}

// Run starts a session daemon. It blocks until the child exits or the daemon
// is signalled, then performs cleanup and returns the child exit code.
func Run(p Params) (int, error) {
	sockPath, err := runtime.SocketPath(p.Name)
	if err != nil {
		p.signalReadyErr(err)
		return 1, err
	}

	// Refuse to clobber a live session.
	if conn, derr := net.Dial("unix", sockPath); derr == nil {
		_ = conn.Close()
		err := fmt.Errorf("session %q already exists", p.Name)
		p.signalReadyErr(err)
		return 1, err
	}
	_ = os.Remove(sockPath)

	sess, err := newSession(p.Name, p.Argv, p.Rows, p.Cols)
	if err != nil {
		p.signalReadyErr(err)
		return 1, err
	}

	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		sess.closeFinal()
		err = fmt.Errorf("listen on socket: %w", err)
		p.signalReadyErr(err)
		return 1, err
	}
	if err := os.Chmod(sockPath, runtime.SocketPerm()); err != nil {
		_ = ln.Close()
		_ = os.Remove(sockPath)
		sess.closeFinal()
		err = fmt.Errorf("chmod socket: %w", err)
		p.signalReadyErr(err)
		return 1, err
	}
	defer func() {
		_ = ln.Close()
		_ = os.Remove(sockPath)
	}()

	// Start the PTY reader and child waiter.
	go sess.readLoop()
	go sess.waitLoop()

	// Signal readiness to the parent.
	if p.ReadyFD >= 0 {
		f := os.NewFile(uintptr(p.ReadyFD), "ready")
		if f != nil {
			_, _ = f.Write([]byte{1})
			_ = f.Close()
		}
	}
	// Handle signals: forward termination to the child process group.
	// Any signal sent to the daemon is treated as a request to end the
	// session, so the child group is killed to avoid orphans.
	sigCh := make(chan os.Signal, 4)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	go func() {
		for range sigCh {
			sess.terminate(true)
		}
	}()

	// Accept loop.
	acceptErr := make(chan error, 1)
	go func() {
		acceptErr <- acceptLoop(ln, sess)
	}()

	select {
	case <-sess.done:
		// Child exited naturally; clean shutdown.
	case err := <-acceptErr:
		if err != nil {
			sess.closeFinal()
			return 1, err
		}
	}

	sess.closeFinal()
	return int(sess.status().ExitCode), nil
}

// acceptLoop serves incoming client connections until the listener closes.
func acceptLoop(ln net.Listener, sess *session) error {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return nil // listener closed during shutdown
		}
		go handleConn(conn, sess)
	}
}

// handleConn performs the handshake and then dispatches by mode.
func handleConn(conn net.Conn, sess *session) {
	frame, err := protocol.ReadFrame(conn)
	if err != nil {
		_ = conn.Close()
		return
	}
	if frame.Type != protocol.TypeHello {
		_ = protocol.WriteFrame(conn, protocol.TypeError, protocol.EncodeError("expected HELLO"))
		_ = conn.Close()
		return
	}
	version, mode, err := protocol.DecodeHello(frame.Payload)
	if err != nil || version != protocol.Version {
		_ = protocol.WriteFrame(conn, protocol.TypeError, protocol.EncodeError("protocol version mismatch"))
		_ = conn.Close()
		return
	}

	switch mode {
	case protocol.ModeStatus:
		handleStatus(conn, sess)
	case protocol.ModeLog:
		handleLog(conn, sess)
	case protocol.ModeKill:
		handleKill(conn, sess)
	case protocol.ModeSend:
		handleSend(conn, sess)
	case protocol.ModeAttach, protocol.ModeAttachWithTail:
		handleAttach(conn, sess, mode == protocol.ModeAttachWithTail)
	default:
		_ = protocol.WriteFrame(conn, protocol.TypeError, protocol.EncodeError("unknown mode"))
		_ = conn.Close()
	}
}

func handleStatus(conn net.Conn, sess *session) {
	defer conn.Close()
	if err := writeStatus(conn, sess); err != nil {
		return
	}
}

func handleLog(conn net.Conn, sess *session) {
	defer conn.Close()
	data := sess.ring.Bytes()
	if err := protocol.WriteFrame(conn, protocol.TypeLogData, data); err != nil {
		return
	}
}

// handleKill asks the session to terminate itself. The client sends a
// TypeKill frame whose first payload byte is 1 to request SIGKILL immediately.
func handleKill(conn net.Conn, sess *session) {
	defer conn.Close()
	force := false
	if f, err := protocol.ReadFrame(conn); err == nil && f.Type == protocol.TypeKill {
		force = len(f.Payload) > 0 && f.Payload[0] == 1
	}
	sess.terminate(force)
}

// handleSend injects raw input into the session's PTY. It is the daemon side
// of `psess send`.
//
// The client streams zero or more STDIN frames and then half-closes its side;
// EOF means "nothing more to send". The daemon writes every frame to the PTY
// master, then replies with HELLO_OK to acknowledge that the bytes were handed
// to the PTY. It deliberately does not care what is running in the session:
// the bytes go to whatever currently owns the terminal, exactly like typed
// input.
func handleSend(conn net.Conn, sess *session) {
	defer conn.Close()

	if st := sess.status(); st.Exited {
		_ = protocol.WriteFrame(conn, protocol.TypeError, protocol.EncodeError("session has exited"))
		return
	}

	for {
		frame, err := protocol.ReadFrame(conn)
		if err != nil {
			// EOF (or a read error) means the client is done sending.
			break
		}
		if frame.Type != protocol.TypeStdin {
			// Ignore anything else for forward compatibility.
			continue
		}
		if werr := sess.writeStdin(frame.Payload); werr != nil {
			_ = protocol.WriteFrame(conn, protocol.TypeError, protocol.EncodeError("write to session failed: "+werr.Error()))
			return
		}
	}

	_ = protocol.WriteFrame(conn, protocol.TypeHelloOK, []byte{protocol.Version})
}

// handleAttach runs the interactive loop for one client. Multiple clients may
// be attached at once; each receives the broadcast PTY output and all of their
// input is written to the PTY.
func handleAttach(conn net.Conn, sess *session, replay bool) {
	c := newClientConn(conn)

	// If the child already exited, report and return immediately without
	// attaching.
	if st := sess.status(); st.Exited {
		_ = protocol.WriteFrame(conn, protocol.TypeHelloOK, nil)
		_ = protocol.WriteFrame(conn, protocol.TypeExit, protocol.EncodeExit(st.ExitCode))
		_ = conn.Close()
		return
	}

	// Register the client and seed its queue with recent output (if enabled)
	// atomically with respect to the PTY reader, so nothing is duplicated or
	// lost.
	sess.attachWithReplay(c, replay, replayLimit)
	defer sess.detachClient(c)

	if err := protocol.WriteFrame(conn, protocol.TypeHelloOK, []byte{protocol.Version}); err != nil {
		return
	}

	// Start the writer goroutine. It drains whatever is queued (replay first,
	// then live output).
	go c.writer()

	// Read client input until detach/EOF.
	for {
		frame, err := protocol.ReadFrame(conn)
		if err != nil {
			return
		}
		switch frame.Type {
		case protocol.TypeStdin:
			if err := sess.writeStdin(frame.Payload); err != nil {
				return
			}
		case protocol.TypeResize:
			rows, cols, derr := protocol.DecodeResize(frame.Payload)
			if derr == nil {
				sess.resize(rows, cols)
			}
		case protocol.TypeDetach:
			return
		default:
			// Ignore unknown frames for forward compatibility.
		}
	}
}

// writeStatus encodes and sends the session status frame.
func writeStatus(conn net.Conn, sess *session) error {
	st := sess.status()
	payload := encodeStatus(st)
	return protocol.WriteFrame(conn, protocol.TypeSessionInfo, payload)
}

// encodeStatus serializes Status into a compact payload.
//
// Layout:
//
//	uint32 pid
//	uint16 rows
//	uint16 cols
//	int32  exitCode
//	u8     flags (bit0 attached, bit1 exited)
//	u32    bufferSize
//	u32    startUnix
//	u32    nameLen,  name...
//	u32    cmdLen,   cmd...
func encodeStatus(st Status) []byte {
	name := []byte(st.Name)
	cmd := []byte(st.Command)
	buf := make([]byte, 0, 32+len(name)+len(cmd))
	buf = appendU32(buf, uint32(st.PID))
	buf = appendU16(buf, st.Rows)
	buf = appendU16(buf, st.Cols)
	buf = appendU32(buf, uint32(st.ExitCode))
	var flags byte
	if st.Attached {
		flags |= 1
	}
	if st.Exited {
		flags |= 2
	}
	buf = append(buf, flags)
	buf = appendU32(buf, uint32(st.BufferSize))
	buf = appendU32(buf, uint32(st.StartTime.Unix()))
	buf = appendU32(buf, uint32(len(name)))
	buf = append(buf, name...)
	buf = appendU32(buf, uint32(len(cmd)))
	buf = append(buf, cmd...)
	return buf
}

// DecodeStatus parses a SESSION_INFO payload into a Status. It is exported for
// use by the client package.
func DecodeStatus(payload []byte) (Status, error) {
	rd := newReader(payload)
	var st Status
	var err error
	pid, err := rd.u32()
	if err != nil {
		return st, err
	}
	st.PID = int(pid)
	r, err := rd.u16()
	if err != nil {
		return st, err
	}
	col, err := rd.u16()
	if err != nil {
		return st, err
	}
	st.Rows, st.Cols = r, col
	ec, err := rd.u32()
	if err != nil {
		return st, err
	}
	st.ExitCode = int32(ec)
	flags, err := rd.byte()
	if err != nil {
		return st, err
	}
	st.Attached = flags&1 != 0
	st.Exited = flags&2 != 0
	bs, err := rd.u32()
	if err != nil {
		return st, err
	}
	st.BufferSize = int(bs)
	ts, err := rd.u32()
	if err != nil {
		return st, err
	}
	st.StartTime = timeUnix(int64(ts))
	name, err := rd.blob()
	if err != nil {
		return st, err
	}
	st.Name = string(name)
	cmd, err := rd.blob()
	if err != nil {
		return st, err
	}
	st.Command = string(cmd)
	return st, nil
}
