package daemon

import (
	"os"
	"os/exec"
	"syscall"

	"github.com/creack/pty"
)

// startPTY launches cmd attached to a new PTY and returns the PTY master.
//
// The child is placed in its own session and process group (Setsid) so that:
//   - the daemon's controlling terminal going away does not signal the child;
//   - psess kill can target the whole process group;
//   - the child is not disturbed by signals sent to the launching shell.
func startPTY(cmd *exec.Cmd, rows, cols uint16) (*os.File, error) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setsid = true
	// Put the child in a fresh process group whose id equals the child pid.
	// Setsid already does this, but being explicit is harmless and clear.
	cmd.SysProcAttr.Setpgid = false

	win := &pty.Winsize{Rows: rows, Cols: cols}
	ptmx, err := pty.StartWithSize(cmd, win)
	if err != nil {
		return nil, err
	}
	return ptmx, nil
}

// resizePTY applies a new window size to the PTY master.
func resizePTY(ptmx *os.File, rows, cols uint16) error {
	return pty.Setsize(ptmx, &pty.Winsize{Rows: rows, Cols: cols})
}
