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
	"os"

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
  psess new [-d] NAME COMMAND [ARGS...]   create a session
  psess attach [--tail] NAME              attach to a session
  psess list | ls                         list sessions
  psess kill [-f] NAME                    terminate a session
  psess logs NAME                         dump recent output
  psess version                           print version

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
	if len(rest) < 2 {
		fmt.Fprintln(os.Stderr, "psess: usage: psess new [-d] NAME COMMAND [ARGS...]")
		return 2
	}
	name := rest[0]
	argv := rest[1:]
	if err := client.New(name, argv, *detach); err != nil {
		fmt.Fprintf(os.Stderr, "psess: %v\n", err)
		return 1
	}
	return 0
}

func cmdAttach(args []string) int {
	fs := flag.NewFlagSet("attach", flag.ContinueOnError)
	tail := fs.Bool("tail", false, "replay recent raw output before attaching")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	rest := fs.Args()
	if len(rest) != 1 {
		fmt.Fprintln(os.Stderr, "psess: usage: psess attach [--tail] NAME")
		return 2
	}
	name := rest[0]
	fmt.Printf("[psess: attached to %s]\n", name)
	code, exited, err := client.Attach(name, *tail)
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
