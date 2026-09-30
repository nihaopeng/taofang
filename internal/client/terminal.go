// Package client implements the psess CLI side: launching sessions, attaching,
// listing, killing and reading logs.
package client

import (
	"golang.org/x/term"
)

// termState captures the terminal state so it can always be restored.
type termState struct {
	fd    int
	state *term.State
	saved bool
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
	return &termState{fd: fd, state: old, saved: true}, nil
}

// restore returns the terminal to its saved state. It is idempotent.
func (t *termState) restore() {
	if t == nil || !t.saved {
		return
	}
	_ = term.Restore(t.fd, t.state)
	t.saved = false
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
