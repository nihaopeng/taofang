package runtime

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateName(t *testing.T) {
	valid := []string{"dev", "a", "my-session", "a.b_c-1", strings.Repeat("x", 64)}
	for _, n := range valid {
		if err := ValidateName(n); err != nil {
			t.Errorf("expected %q valid: %v", n, err)
		}
	}
	invalid := []string{"", ".", "..", "a/b", "a\\b", "../etc", "héllo", "a b", strings.Repeat("x", 65)}
	for _, n := range invalid {
		if err := ValidateName(n); err == nil {
			t.Errorf("expected %q invalid", n)
		}
	}
}

func TestDirPermissions(t *testing.T) {
	dir, err := Dir()
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("dir perm = %o, want 0700", info.Mode().Perm())
	}
}

func TestSocketPath(t *testing.T) {
	p, err := SocketPath("dev")
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(p) != "dev.sock" {
		t.Fatalf("got %s", p)
	}
	if _, err := SocketPath("../evil"); err == nil {
		t.Fatal("expected error for path traversal")
	}
}
