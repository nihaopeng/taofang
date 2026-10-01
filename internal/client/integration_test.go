package client_test

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/creack/pty"
)

// buildBinary compiles psess once per test run into a temp dir.
var (
	binOnce sync.Once
	binPath string
	binErr  error
)

func psessBin(t *testing.T) string {
	t.Helper()
	binOnce.Do(func() {
		dir, err := os.MkdirTemp("", "psess-bin-")
		if err != nil {
			binErr = err
			return
		}
		binPath = filepath.Join(dir, "psess")
		cmd := exec.Command("go", "build", "-o", binPath, "github.com/nihaopeng/psess/cmd/psess")
		cmd.Env = os.Environ()
		out, err := cmd.CombinedOutput()
		if err != nil {
			binErr = fmt.Errorf("build failed: %v\n%s", err, out)
		}
	})
	if binErr != nil {
		t.Fatal(binErr)
	}
	return binPath
}

// testEnv sets an isolated XDG_RUNTIME_DIR so tests do not collide.
func testEnv(t *testing.T) []string {
	t.Helper()
	dir := t.TempDir()
	return append(os.Environ(), "XDG_RUNTIME_DIR="+dir)
}

// ptySession represents a running attach client attached to a PTY.
type ptySession struct {
	t    *testing.T
	cmd  *exec.Cmd
	ptmx *os.File
	buf  *safeBuffer
	done chan struct{}
}

type safeBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *safeBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *safeBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// startAttach runs `psess attach NAME` under a PTY. When replay is false the
// --no-replay flag is passed.
func startAttach(t *testing.T, bin, name string, env []string, replay bool) *ptySession {
	t.Helper()
	args := []string{"attach"}
	if !replay {
		args = append(args, "--no-replay")
	}
	args = append(args, name)
	cmd := exec.Command(bin, args...)
	cmd.Env = env
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 24, Cols: 80})
	if err != nil {
		t.Fatalf("start attach: %v", err)
	}
	ps := &ptySession{t: t, cmd: cmd, ptmx: ptmx, buf: &safeBuffer{}, done: make(chan struct{})}
	go func() {
		b := make([]byte, 4096)
		for {
			n, err := ptmx.Read(b)
			if n > 0 {
				ps.buf.Write(b[:n])
			}
			if err != nil {
				close(ps.done)
				return
			}
		}
	}()
	return ps
}

func (p *ptySession) write(s string) {
	p.t.Helper()
	if _, err := p.ptmx.Write([]byte(s)); err != nil {
		p.t.Fatalf("pty write: %v", err)
	}
}

// waitFor polls until the accumulated output contains want.
func (p *ptySession) waitFor(want string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if strings.Contains(p.buf.String(), want) {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

// detach sends the Ctrl-] d sequence.
func (p *ptySession) detach() {
	p.write("\x1dd")
	if err := p.cmd.Wait(); err != nil {
		// A detach normally exits 0; do not fail on non-zero here.
		p.t.Logf("attach exited: %v", err)
	}
}

func runCmd(t *testing.T, env []string, bin string, args ...string) (string, int) {
	t.Helper()
	cmd := exec.Command(bin, args...)
	cmd.Env = env
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	code := 0
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
		} else {
			t.Fatalf("run %v: %v", args, err)
		}
	}
	return out.String(), code
}

// cleanKill force-kills a session if still present.
func cleanKill(t *testing.T, env []string, bin, name string) {
	_, _ = runCmd(t, env, bin, "kill", "-f", name)
}

func TestNewDetachReattachPreservesState(t *testing.T) {
	bin := psessBin(t)
	env := testEnv(t)
	name := "t1"
	defer cleanKill(t, env, bin, name)

	// Create detached, running bash.
	out, code := runCmd(t, env, bin, "new", "-d", name, "bash", "--norc", "--noprofile")
	if code != 0 {
		t.Fatalf("new failed (%d): %s", code, out)
	}

	// Attach, set state, detach.
	ps := startAttach(t, bin, name, env, false)
	time.Sleep(300 * time.Millisecond)
	ps.write("export ABC=123; cd /tmp; echo MARK_A_SET\n")
	if !ps.waitFor("MARK_A_SET", 5*time.Second) {
		t.Fatalf("did not see MARK_A_SET; output=%q", ps.buf.String())
	}
	ps.detach()

	// Re-attach and verify the state survived.
	ps2 := startAttach(t, bin, name, env, false)
	defer ps2.detach()
	time.Sleep(300 * time.Millisecond)
	ps2.write("echo \"ABC=$ABC\"; pwd\n")
	if !ps2.waitFor("ABC=123", 5*time.Second) {
		t.Fatalf("state lost: %q", ps2.buf.String())
	}
	if !ps2.waitFor("/tmp", 5*time.Second) {
		t.Fatalf("cwd lost: %q", ps2.buf.String())
	}
}

func TestListShowsSession(t *testing.T) {
	bin := psessBin(t)
	env := testEnv(t)
	name := "t2"
	defer cleanKill(t, env, bin, name)

	runCmd(t, env, bin, "new", "-d", name, "sleep", "1000")
	out, code := runCmd(t, env, bin, "list")
	if code != 0 {
		t.Fatalf("list failed: %s", out)
	}
	if !strings.Contains(out, name) || !strings.Contains(out, "sleep") {
		t.Fatalf("list output missing session: %q", out)
	}
}

func TestLogsAndTail(t *testing.T) {
	bin := psessBin(t)
	env := testEnv(t)
	name := "t3"
	defer cleanKill(t, env, bin, name)

	runCmd(t, env, bin, "new", "-d", name, "bash", "--norc", "--noprofile")
	ps := startAttach(t, bin, name, env, false)
	time.Sleep(300 * time.Millisecond)
	ps.write("echo LOG_LINE_XYZ\n")
	if !ps.waitFor("LOG_LINE_XYZ", 5*time.Second) {
		t.Fatalf("output not seen: %q", ps.buf.String())
	}
	ps.detach()

	// Logs should contain the line from the ring buffer.
	deadline := time.Now().Add(3 * time.Second)
	for {
		out, _ := runCmd(t, env, bin, "logs", name)
		if strings.Contains(out, "LOG_LINE_XYZ") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("logs missing line: %q", out)
		}
		time.Sleep(50 * time.Millisecond)
	}

	// A re-attach must replay the recent output before the live stream.
	ps2 := startAttach(t, bin, name, env, true)
	defer ps2.detach()
	if !ps2.waitFor("LOG_LINE_XYZ", 5*time.Second) {
		t.Fatalf("replay missing: %q", ps2.buf.String())
	}
}

func TestKillTerminatesProcessGroup(t *testing.T) {
	bin := psessBin(t)
	env := testEnv(t)
	name := "t4"

	runCmd(t, env, bin, "new", "-d", name, "bash", "--norc", "--noprofile")
	ps := startAttach(t, bin, name, env, false)
	time.Sleep(300 * time.Millisecond)
	// Start a background child that would survive a naive kill.
	ps.write("sleep 3000 & echo CHILD_STARTED\n")
	if !ps.waitFor("CHILD_STARTED", 5*time.Second) {
		t.Fatalf("child not started: %q", ps.buf.String())
	}
	ps.detach()

	out, code := runCmd(t, env, bin, "kill", name)
	if code != 0 {
		t.Fatalf("kill failed: %s", out)
	}

	// Session must disappear from list.
	deadline := time.Now().Add(5 * time.Second)
	for {
		out, _ := runCmd(t, env, bin, "list")
		if !strings.Contains(out, name) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("session still listed: %q", out)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func TestSessionSurvivesClientCrash(t *testing.T) {
	bin := psessBin(t)
	env := testEnv(t)
	name := "t5"
	defer cleanKill(t, env, bin, name)

	runCmd(t, env, bin, "new", "-d", name, "bash", "--norc", "--noprofile")
	ps := startAttach(t, bin, name, env, false)
	time.Sleep(300 * time.Millisecond)
	ps.write("export SURVIVE=yes; echo READY_SURVIVE\n")
	if !ps.waitFor("READY_SURVIVE", 5*time.Second) {
		t.Fatalf("not ready: %q", ps.buf.String())
	}

	// Kill -9 the attach client process.
	_ = ps.cmd.Process.Kill()
	_ = ps.ptmx.Close()
	<-ps.done

	// Give the daemon a moment to notice the disconnect.
	time.Sleep(500 * time.Millisecond)

	ps2 := startAttach(t, bin, name, env, false)
	defer ps2.detach()
	time.Sleep(300 * time.Millisecond)
	ps2.write("echo \"SURVIVE=$SURVIVE\"\n")
	if !ps2.waitFor("SURVIVE=yes", 5*time.Second) {
		t.Fatalf("session did not survive client crash: %q", ps2.buf.String())
	}
}

func TestExitPropagates(t *testing.T) {
	bin := psessBin(t)
	env := testEnv(t)
	name := "t6"

	runCmd(t, env, bin, "new", "-d", name, "bash", "--norc", "--noprofile")
	ps := startAttach(t, bin, name, env, false)
	time.Sleep(300 * time.Millisecond)
	ps.write("exit 7\n")
	if !ps.waitFor("exited with code 7", 5*time.Second) {
		t.Fatalf("exit not reported: %q", ps.buf.String())
	}
	_ = ps.cmd.Wait()

	// Session should be gone from list.
	deadline := time.Now().Add(5 * time.Second)
	for {
		out, _ := runCmd(t, env, bin, "list")
		if !strings.Contains(out, name) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("exited session still listed: %q", out)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func TestDuplicateSessionRejected(t *testing.T) {
	bin := psessBin(t)
	env := testEnv(t)
	name := "t7"
	defer cleanKill(t, env, bin, name)

	runCmd(t, env, bin, "new", "-d", name, "sleep", "1000")
	out, code := runCmd(t, env, bin, "new", "-d", name, "sleep", "1000")
	if code == 0 || !strings.Contains(out, "already exists") {
		t.Fatalf("expected already exists, got code=%d out=%q", code, out)
	}
}

func TestUnicodePassThrough(t *testing.T) {
	bin := psessBin(t)
	env := testEnv(t)
	name := "t8"
	defer cleanKill(t, env, bin, name)

	runCmd(t, env, bin, "new", "-d", name, "bash", "--norc", "--noprofile")
	ps := startAttach(t, bin, name, env, false)
	time.Sleep(300 * time.Millisecond)
	ps.write("printf '你好世界\\n'\n")
	if !ps.waitFor("你好世界", 5*time.Second) {
		t.Fatalf("utf-8 not preserved: %q", ps.buf.String())
	}
}

func TestResize(t *testing.T) {
	bin := psessBin(t)
	env := testEnv(t)
	name := "t9"
	defer cleanKill(t, env, bin, name)

	runCmd(t, env, bin, "new", "-d", name, "bash", "--norc", "--noprofile")
	ps := startAttach(t, bin, name, env, false)
	time.Sleep(300 * time.Millisecond)
	ps.write("stty size\n")
	if !ps.waitFor("24 80", 5*time.Second) {
		t.Fatalf("initial size wrong: %q", ps.buf.String())
	}

	_ = pty.Setsize(ps.ptmx, &pty.Winsize{Rows: 40, Cols: 120})

	// Trigger a re-query after resize.
	time.Sleep(300 * time.Millisecond)
	ps.write("stty size\n")
	if !ps.waitFor("40 120", 5*time.Second) {
		t.Fatalf("resize not applied: %q", ps.buf.String())
	}
}

// TestPTYDrainsWithoutClient ensures the daemon keeps consuming PTY output
// when no client is attached, so the child never blocks on a full PTY buffer.
func TestPTYDrainsWithoutClient(t *testing.T) {
	bin := psessBin(t)
	env := testEnv(t)
	name := "t10"
	defer cleanKill(t, env, bin, name)

	runCmd(t, env, bin, "new", "-d", name, "yes")
	// Let it produce far more output than the ring buffer and the PTY buffer.
	time.Sleep(2 * time.Second)

	// The process must still be alive and the ring buffer must be capped.
	out, _ := runCmd(t, env, bin, "list")
	if !strings.Contains(out, name) {
		t.Fatalf("session vanished while draining: %q", out)
	}
	_, _ = runCmd(t, env, bin, "logs", name)
}

// TestDaemonSurvivesLauncherDeath starts a session from a short-lived parent
// and verifies the session persists after that parent is gone.
func TestDaemonSurvivesLauncherDeath(t *testing.T) {
	bin := psessBin(t)
	env := testEnv(t)
	name := "t11"
	defer cleanKill(t, env, bin, name)

	// Start `psess new -d` as a child, then kill the launcher.
	launcher := exec.Command(bin, "new", "-d", name, "bash", "--norc", "--noprofile")
	launcher.Env = env
	if err := launcher.Run(); err != nil {
		t.Fatalf("launch: %v", err)
	}

	time.Sleep(500 * time.Millisecond)
	out, _ := runCmd(t, env, bin, "list")
	if !strings.Contains(out, name) {
		t.Fatalf("session missing before launcher death: %q", out)
	}

	// Attach and confirm interactivity still works afterwards.
	ps := startAttach(t, bin, name, env, false)
	defer ps.detach()
	time.Sleep(300 * time.Millisecond)
	ps.write("echo STILL_ALIVE\n")
	if !ps.waitFor("STILL_ALIVE", 5*time.Second) {
		t.Fatalf("session unresponsive: %q", ps.buf.String())
	}
}

// TestMultipleClientsBroadcast verifies that two clients can be attached at the
// same time and both receive the same output, and that input from either client
// reaches the session.
func TestMultipleClientsBroadcast(t *testing.T) {
	bin := psessBin(t)
	env := testEnv(t)
	name := "t12"
	defer cleanKill(t, env, bin, name)

	runCmd(t, env, bin, "new", "-d", name, "bash", "--norc", "--noprofile")

	c1 := startAttach(t, bin, name, env, false)
	defer c1.detach()
	time.Sleep(400 * time.Millisecond)

	// Second client attaches while the first is still attached.
	c2 := startAttach(t, bin, name, env, false)
	defer c2.detach()
	time.Sleep(400 * time.Millisecond)

	// Both clients must still be alive (not rejected).
	if c1.cmd.ProcessState != nil {
		t.Fatalf("first client exited unexpectedly")
	}

	// Output from the shared session is broadcast to both.
	c1.write("echo BROADCAST_XYZ\n")
	if !c1.waitFor("BROADCAST_XYZ", 5*time.Second) {
		t.Fatalf("client 1 did not see output: %q", c1.buf.String())
	}
	if !c2.waitFor("BROADCAST_XYZ", 5*time.Second) {
		t.Fatalf("client 2 did not receive broadcast: %q", c2.buf.String())
	}

	// Input from the second client also reaches the session, and is visible
	// to the first.
	c2.write("echo FROM_CLIENT2\n")
	if !c1.waitFor("FROM_CLIENT2", 5*time.Second) {
		t.Fatalf("client 1 did not see client 2 input: %q", c1.buf.String())
	}
	if !c2.waitFor("FROM_CLIENT2", 5*time.Second) {
		t.Fatalf("client 2 did not see its own output: %q", c2.buf.String())
	}
}

// TestAttachReplayByDefault verifies that a freshly attached client receives
// recent output produced while it was not attached.
func TestAttachReplayByDefault(t *testing.T) {
	bin := psessBin(t)
	env := testEnv(t)
	name := "t13"
	defer cleanKill(t, env, bin, name)

	runCmd(t, env, bin, "new", "-d", name, "bash", "--norc", "--noprofile")

	// Produce output while no client is attached.
	c1 := startAttach(t, bin, name, env, false)
	time.Sleep(300 * time.Millisecond)
	c1.write("echo REPLAY_MARKER_42\n")
	if !c1.waitFor("REPLAY_MARKER_42", 5*time.Second) {
		t.Fatalf("setup output missing: %q", c1.buf.String())
	}
	c1.detach()
	time.Sleep(300 * time.Millisecond)

	// A default attach must replay the marker.
	c2 := startAttach(t, bin, name, env, true)
	defer c2.detach()
	if !c2.waitFor("REPLAY_MARKER_42", 5*time.Second) {
		t.Fatalf("default attach did not replay history: %q", c2.buf.String())
	}

	// A --no-replay attach must NOT replay it (starts from an empty screen).
	c3 := startAttach(t, bin, name, env, false)
	defer c3.detach()
	time.Sleep(400 * time.Millisecond)
	if strings.Contains(c3.buf.String(), "REPLAY_MARKER_42") {
		t.Fatalf("--no-replay should not replay history: %q", c3.buf.String())
	}
}

// TestDetachResetsTerminalModes reproduces the "garbage input" bug: a
// full-screen program inside the session enables mouse tracking / bracketed
// paste / the kitty keyboard protocol, then the client exits without the
// program disabling them. The attach client must clear those terminal-wide
// modes on its way out, because termios restoration alone cannot: the modes
// live in the real terminal emulator, not in the PTY.
func TestDetachResetsTerminalModes(t *testing.T) {
	bin := psessBin(t)
	env := testEnv(t)
	name := "t15"
	defer cleanKill(t, env, bin, name)

	runCmd(t, env, bin, "new", "-d", name, "bash", "--norc", "--noprofile")
	ps := startAttach(t, bin, name, env, false)
	time.Sleep(300 * time.Millisecond)

	// Simulate a TUI turning on every input-reporting mode.
	ps.write("printf '\\033[?1000h\\033[?1003h\\033[?2004h\\033[>1u'\n")
	if !ps.waitFor("\x1b[?1000h", 5*time.Second) {
		t.Fatalf("mode-enable sequence not seen: %q", ps.buf.String())
	}

	ps.detach()

	// The client writes the reset sequence as it restores the terminal, just
	// before exiting, so give the reader a moment to drain it.
	want := []string{"\x1b[?1000l", "\x1b[?1003l", "\x1b[?2004l", "\x1b[<u"}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		out := ps.buf.String()
		all := true
		for _, w := range want {
			if !strings.Contains(out, w) {
				all = false
				break
			}
		}
		if all {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("terminal modes not reset on detach: %q", ps.buf.String())
}

// TestSessionExitResetsTerminalModes covers the other exit path: the session's
// own process exits (it is not the user detaching). Attach returns on the EXIT
// frame, so the deferred restore must still clear the input modes before the
// client prints its final status line.
func TestSessionExitResetsTerminalModes(t *testing.T) {
	bin := psessBin(t)
	env := testEnv(t)
	name := "t16"

	// Enable the modes, then exit on our own a moment later.
	runCmd(t, env, bin, "new", "-d", name, "sh", "-c",
		`printf '\033[?1000h\033[?1003h\033[?2004h\033[>1u'; sleep 1`)
	ps := startAttach(t, bin, name, env, false)

	if !ps.waitFor("exited with code", 8*time.Second) {
		t.Fatalf("session exit not reported: %q", ps.buf.String())
	}
	_ = ps.cmd.Wait()

	want := []string{"\x1b[?1000l", "\x1b[?1003l", "\x1b[?2004l", "\x1b[<u"}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		out := ps.buf.String()
		all := true
		for _, w := range want {
			if !strings.Contains(out, w) {
				all = false
				break
			}
		}
		if all {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("terminal modes not reset on session exit: %q", ps.buf.String())
}

// TestSessionEnv verifies that processes inside a session see PSESS_SESSION and
// PSESS, while the launching process does not.
func TestSessionEnv(t *testing.T) {
	bin := psessBin(t)
	env := testEnv(t)
	name := "t14"
	defer cleanKill(t, env, bin, name)

	// The outer environment must not carry the marker.
	if os.Getenv("PSESS_SESSION") != "" {
		t.Fatalf("outer environment unexpectedly has PSESS_SESSION")
	}

	runCmd(t, env, bin, "new", "-d", name, "bash", "--norc", "--noprofile")
	ps := startAttach(t, bin, name, env, false)
	defer ps.detach()
	time.Sleep(300 * time.Millisecond)
	ps.write("echo \"ENV:[$PSESS_SESSION][$PSESS]\"\n")
	if !ps.waitFor("ENV:["+name+"][1]", 5*time.Second) {
		t.Fatalf("session env not injected: %q", ps.buf.String())
	}
}
