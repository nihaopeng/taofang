package daemon

import "syscall"

// Signal constants aliased so session.go stays portable across build tags if
// ever needed.
const (
	syscallSIGKILL = syscall.SIGKILL
	syscallSIGTERM = syscall.SIGTERM
)

// signalGroup sends sig to the whole process group identified by pgid.
func signalGroup(pgid int, sig syscall.Signal) error {
	// Negative pid targets the process group.
	return syscall.Kill(-pgid, sig)
}
