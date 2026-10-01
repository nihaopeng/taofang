// Package client implements the psess CLI side: launching sessions, attaching,
// listing, killing and reading logs.
package client

import (
	"os"
	"sync"

	"golang.org/x/term"
)

// termState captures the terminal state so it can always be restored.
type termState struct {
	fd    int // stdin, the fd put into raw mode
	outFd int // where terminal-wide mode resets are written
	state *term.State

	// once makes restore idempotent and safe to call from both the deferred
	// path and the signal-handler goroutine.
	once sync.Once
}

// makeRaw switches stdin into raw mode, remembering the previous state.
func makeRaw(fd int) (*termState, error) {
	old, err := term.GetState(fd)
	if err != nil {
		return nil, err
	}
	if _, err := term.MakeRaw(fd); err != nil {
		return nil, err
	}
	return &termState{fd: fd, outFd: int(os.Stdout.Fd()), state: old}, nil
}

// restore returns the terminal to its saved termios state and undoes the
// terminal-wide modes a full-screen child application may have left behind.
// It is idempotent and safe to call concurrently.
func (t *termState) restore() {
	if t == nil {
		return
	}
	t.once.Do(func() {
		if t.state != nil {
			_ = term.Restore(t.fd, t.state)
		}
		t.resetModes()
	})
}

// terminalModeResets disables every terminal mode that turns the terminal's
// *input* into application traffic. A full-screen program running inside a
// session (codex, vim, htop, ...) enables these by emitting DECSET / kitty
// keyboard escapes. Normally it disables them again on exit, but if it is
// killed or crashes they stay enabled in the real terminal.
//
// psess is a transparent PTY owner: those escapes pass through it untouched to
// the real terminal emulator, which is where the modes actually live, while
// term.Restore only resets termios and cannot clear them. The result is a
// terminal that keeps injecting mouse reports, kitty key-release events and
// bracketed-paste markers into whatever is typed next -- the "garbage input"
// symptom.
//
// The sequences are harmless when the corresponding mode was never set, so
// they are sent unconditionally on every restore. The kitty keyboard flag
// stack is popped several times because we cannot know how many times a
// crashed program pushed onto it; popping past the bottom is a no-op.
var terminalModeResets = []byte(
	"\x1b[?1000l" + // mouse: normal tracking
		"\x1b[?1002l" + // mouse: button-event tracking
		"\x1b[?1003l" + // mouse: any-event tracking
		"\x1b[?1005l" + // mouse: UTF-8 extended coordinates
		"\x1b[?1006l" + // mouse: SGR extended coordinates
		"\x1b[?1015l" + // mouse: urxvt extended coordinates
		"\x1b[?1004l" + // focus in/out reporting
		"\x1b[?2004l" + // bracketed paste
		"\x1b[<u\x1b[<u\x1b[<u\x1b[<u" + // kitty keyboard: pop flags
		"\x1b[?25h", // make sure the cursor is visible again
)

// resetModes writes terminalModeResets to the terminal. It is a no-op when
// stdout is not a terminal.
func (t *termState) resetModes() {
	if t.outFd < 0 || !isTerminal(t.outFd) {
		return
	}
	_, _ = os.Stdout.Write(terminalModeResets)
}

// terminalSize returns the current rows and cols of the given fd.
func terminalSize(fd int) (rows, cols uint16, err error) {
	w, h, err := term.GetSize(fd)
	if err != nil {
		return 0, 0, err
	}
	return uint16(h), uint16(w), nil
}

// isTerminal reports whether fd refers to a terminal.
func isTerminal(fd int) bool {
	return term.IsTerminal(fd)
}
