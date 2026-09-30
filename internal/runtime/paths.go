// Package runtime resolves filesystem paths used by psess.
//
// psess keeps all runtime metadata (unix sockets) inside a per-user runtime
// directory. The directory follows the XDG Base Directory specification and
// falls back to /tmp/psess-$UID when XDG_RUNTIME_DIR is not available.
package runtime

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

// socketPerm is the permission bit set applied to each session socket.
// Only the owning user should be able to attach.
const socketPerm = 0o600

// dirPerm is the permission bit set applied to the runtime directory.
const dirPerm = 0o700

// sessionNameRe matches the allowed session name alphabet.
var sessionNameRe = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)

// MaxSessionNameLen is the maximum accepted session name length.
const MaxSessionNameLen = 64

// Dir returns the runtime directory used to store session sockets.
// It is created with 0700 permissions if it does not yet exist.
func Dir() (string, error) {
	dir := os.Getenv("XDG_RUNTIME_DIR")
	if dir == "" {
		dir = fmt.Sprintf("/tmp/psess-%d", os.Getuid())
	} else {
		dir = filepath.Join(dir, "psess")
	}

	if err := os.MkdirAll(dir, dirPerm); err != nil {
		return "", fmt.Errorf("create runtime dir %s: %w", dir, err)
	}
	// MkdirAll honors umask, so enforce the mode explicitly.
	if err := os.Chmod(dir, dirPerm); err != nil {
		return "", fmt.Errorf("chmod runtime dir %s: %w", dir, err)
	}
	return dir, nil
}

// SocketPath returns the unix socket path for the given session name.
func SocketPath(name string) (string, error) {
	if err := ValidateName(name); err != nil {
		return "", err
	}
	dir, err := Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, name+".sock"), nil
}

// ValidateName verifies a session name is safe to use as a socket filename.
func ValidateName(name string) error {
	if name == "" {
		return fmt.Errorf("session name must not be empty")
	}
	if len(name) > MaxSessionNameLen {
		return fmt.Errorf("session name too long (max %d characters)", MaxSessionNameLen)
	}
	if name == "." || name == ".." {
		return fmt.Errorf("invalid session name %q", name)
	}
	if !sessionNameRe.MatchString(name) {
		return fmt.Errorf("invalid session name %q: allowed characters are [a-zA-Z0-9._-]", name)
	}
	return nil
}

// SocketPerm is the permission used for session sockets.
func SocketPerm() os.FileMode { return socketPerm }
