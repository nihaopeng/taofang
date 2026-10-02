// Command psess is a lightweight persistent PTY supervisor.
//
// It keeps an interactive process (and its PTY) alive independently of the
// terminal or SSH connection that started it, so the user can detach and
// re-attach later. It is deliberately NOT a terminal multiplexer: it does not
// emulate a terminal, keep screen state, or manage panes.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/term"

	"github.com/nihaopeng/psess/internal/client"
	"github.com/nihaopeng/psess/internal/daemon"
)

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) == 0 {
		usage()
		return 2
	}

	switch args[0] {
	case "new":
		return cmdNew(args[1:])
	case "attach":
		return cmdAttach(args[1:])
	case "list", "ls":
		return cmdList(args[1:])
	case "kill":
		return cmdKill(args[1:])
	case "logs":
		return cmdLogs(args[1:])
	case "send":
		return cmdSend(args[1:])
	case "__daemon":
		return cmdDaemon(args[1:])
	case "version", "--version", "-v":
		fmt.Println("psess 0.1.0")
		return 0
	case "help", "--help", "-h":
		usage()
		return 0
	default:
		fmt.Fprintf(os.Stderr, "psess: unknown command %q\n", args[0])
		usage()
		return 2
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `psess - persistent PTY session manager

Usage:
  psess new [-d] NAME [COMMAND [ARGS...]]   create a session
  psess attach [--no-replay] NAME           attach to a session
  psess list | ls                           list sessions
  psess kill [-f] NAME                      terminate a session
  psess logs NAME                           dump recent output
  psess send [-e|-n] NAME [--] [TEXT]       inject input into a session
  psess version                             print version

Multiple clients may attach to the same session at once; output is mirrored
to all of them. A new attach replays up to 4 MiB of recent raw output first
unless --no-replay is given (full-screen programs may need a Ctrl-L redraw).

Detach from an attached session with Ctrl-] then d.
`)
}

func cmdNew(args []string) int {
	fs := flag.NewFlagSet("new", flag.ContinueOnError)
	detach := fs.Bool("detach", false, "create without attaching")
	fs.BoolVar(detach, "d", false, "create without attaching (shorthand)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	rest := fs.Args()
	if len(rest) < 1 {
		fmt.Fprintln(os.Stderr, "psess: usage: psess new [-d] NAME [COMMAND [ARGS...]]")
		return 2
	}
	name := rest[0]
	argv := rest[1:]
	if len(argv) == 0 {
		// No command given: default to the user's login shell.
		shell := os.Getenv("SHELL")
		if shell == "" {
			shell = "/bin/sh"
		}
		argv = []string{shell}
	}
	if err := client.New(name, argv, *detach); err != nil {
		fmt.Fprintf(os.Stderr, "psess: %v\n", err)
		return 1
	}
	return 0
}

func cmdAttach(args []string) int {
	fs := flag.NewFlagSet("attach", flag.ContinueOnError)
	noReplay := fs.Bool("no-replay", false, "do not replay recent output before attaching")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	rest := fs.Args()
	if len(rest) != 1 {
		fmt.Fprintln(os.Stderr, "psess: usage: psess attach [--no-replay] NAME")
		return 2
	}
	name := rest[0]
	code, exited, err := client.Attach(name, !*noReplay)
	if err != nil {
		fmt.Fprintf(os.Stderr, "psess: %v\n", err)
		return 1
	}
	if exited {
		fmt.Fprintf(os.Stderr, "[psess: session %s exited with code %d]\n", name, code)
	} else {
		fmt.Printf("[psess: detached from %s]\n", name)
	}
	return 0
}

func cmdList(args []string) int {
	if err := client.List(); err != nil {
		fmt.Fprintf(os.Stderr, "psess: %v\n", err)
		return 1
	}
	return 0
}

func cmdKill(args []string) int {
	fs := flag.NewFlagSet("kill", flag.ContinueOnError)
	force := fs.Bool("force", false, "send SIGKILL immediately")
	fs.BoolVar(force, "f", false, "send SIGKILL immediately (shorthand)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	rest := fs.Args()
	if len(rest) != 1 {
		fmt.Fprintln(os.Stderr, "psess: usage: psess kill [-f] NAME")
		return 2
	}
	if err := client.Kill(rest[0], *force); err != nil {
		fmt.Fprintf(os.Stderr, "psess: %v\n", err)
		return 1
	}
	return 0
}

func cmdLogs(args []string) int {
	if len(args) != 1 {
		fmt.Fprintln(os.Stderr, "psess: usage: psess logs NAME")
		return 2
	}
	if err := client.Logs(args[0]); err != nil {
		fmt.Fprintf(os.Stderr, "psess: %v\n", err)
		return 1
	}
	return 0
}

// cmdSend implements `psess send`: inject raw input into a session's PTY
// without attaching.
//
// It is a generic key-injection primitive and makes no attempt to decide
// whether the session is at a shell prompt or running a full-screen program:
// the bytes go to whatever currently owns the terminal, exactly like typed
// input. TEXT is sent literally; use the shell's $'...' quoting for escape
// sequences, or pass `-` to read raw bytes from stdin.
func cmdSend(args []string) int {
	var enter, newline bool
	var pos []string

	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--":
			pos = append(pos, args[i+1:]...)
			i = len(args)
		case a == "-e" || a == "--enter":
			enter = true
		case a == "-n" || a == "--newline":
			newline = true
		case strings.HasPrefix(a, "-") && a != "-":
			fmt.Fprintf(os.Stderr, "psess send: unknown flag %q\n", a)
			fmt.Fprintln(os.Stderr, "psess: usage: psess send [-e|-n] NAME [--] [TEXT]")
			return 2
		default:
			pos = append(pos, a)
		}
	}

	if enter && newline {
		fmt.Fprintln(os.Stderr, "psess send: --enter and --newline are mutually exclusive")
		return 2
	}
	if len(pos) < 1 || len(pos) > 2 {
		fmt.Fprintln(os.Stderr, "psess: usage: psess send [-e|-n] NAME [--] [TEXT]")
		return 2
	}

	name := pos[0]
	var data []byte
	switch {
	case len(pos) == 2 && pos[1] != "-":
		data = []byte(pos[1])
	default:
		// No TEXT, or `-`: read raw bytes from stdin.
		if term.IsTerminal(int(os.Stdin.Fd())) {
			fmt.Fprintln(os.Stderr, "psess send: no input given; pass TEXT or pipe data to '-'")
			return 2
		}
		b, rerr := io.ReadAll(os.Stdin)
		if rerr != nil {
			fmt.Fprintf(os.Stderr, "psess send: reading stdin: %v\n", rerr)
			return 1
		}
		data = b
	}

	if enter {
		data = append(data, '\r')
	}
	if newline {
		data = append(data, '\n')
	}

	if err := client.Send(name, data); err != nil {
		fmt.Fprintf(os.Stderr, "psess: %v\n", err)
		return 1
	}
	return 0
}

// cmdDaemon is the hidden entrypoint executed to host a session. It is spawned
// by `psess new`; users should never call it directly.
func cmdDaemon(args []string) int {
	fs := flag.NewFlagSet("__daemon", flag.ContinueOnError)
	name := fs.String("name", "", "session name")
	rows := fs.Uint("rows", 24, "initial rows")
	cols := fs.Uint("cols", 80, "initial cols")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	argv := fs.Args()
	if *name == "" || len(argv) == 0 {
		fmt.Fprintln(os.Stderr, "psess __daemon: missing name or command")
		return 2
	}

	// The parent passes a readiness pipe as fd 3 (ExtraFiles). If fd 3 is not
	// valid (e.g. __daemon invoked manually) the write simply fails silently.
	readyFD := 3

	code, err := daemon.Run(daemon.Params{
		Name:    *name,
		Argv:    argv,
		Rows:    uint16(*rows),
		Cols:    uint16(*cols),
		ReadyFD: readyFD,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "psess daemon: %v\n", err)
		return 1
	}
	return code
}
