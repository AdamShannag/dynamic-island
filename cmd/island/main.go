// island is the CLI for the Go Island daemon.
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"syscall"

	"github.com/godbus/dbus/v5"

	"go-island/internal/dbusapi"
)

func usage() {
	fmt.Fprintln(os.Stderr, `usage:
  island notify [-t ms] [-i icon] [-a ok|warn|error] TITLE [BODY]
  island run [-n name] -- COMMAND [ARGS...]   show a command in the island while it runs
  island open [home|agents|docker|ports|clipboard|web]   toggle the dashboard
  island claude install|uninstall             report Claude Code sessions to the island
  island kill-port PORT                       free a port (kills the process / stops the container)
  island pomodoro start|stop|toggle
  island action NAME                          e.g. media.play-pause, notify.dismiss
  island state`)
	os.Exit(2)
}

var obj dbus.BusObject

func call(method string, args ...any) *dbus.Call {
	return obj.Call(dbusapi.Iface+"."+method, 0, args...)
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	args := os.Args[2:]
	if os.Args[1] == "claude" {
		os.Exit(claudeCmd(args)) // handles its own (optional) bus connection
	}
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		fail(err)
	}
	obj = conn.Object(dbusapi.BusName, dbusapi.Path)

	switch os.Args[1] {
	case "notify":
		fs := flag.NewFlagSet("notify", flag.ExitOnError)
		timeout := fs.Int("t", 5000, "timeout in milliseconds")
		icon := fs.String("i", "", "icon name (default dialog-information-symbolic)")
		accent := fs.String("a", "", "accent: ok, warn or error")
		fs.Parse(args)
		if fs.NArg() < 1 {
			usage()
		}
		body := strings.Join(fs.Args()[1:], " ")
		err = call("Notify", fs.Arg(0), body, *icon, *accent, int32(*timeout)).Err
	case "run":
		os.Exit(run(args))
	case "claude":
		os.Exit(claudeCmd(args))
	case "open":
		tab := ""
		if len(args) > 0 {
			tab = args[0]
		}
		err = call("Open", tab).Err
	case "kill-port":
		if len(args) != 1 {
			usage()
		}
		port, perr := strconv.ParseUint(args[0], 10, 16)
		if perr != nil || port == 0 {
			fail(fmt.Errorf("invalid port %q", args[0]))
		}
		var summary string
		err = call("PortFree", uint32(port)).Store(&summary)
		if summary != "" {
			fmt.Println(summary)
		}
	case "pomodoro":
		if len(args) != 1 {
			usage()
		}
		err = call("Action", "pomodoro."+args[0]).Err
	case "action":
		if len(args) != 1 {
			usage()
		}
		err = call("Action", args[0]).Err
	case "state":
		var s string
		if err = call("GetState").Store(&s); err == nil {
			fmt.Println(s)
		}
	default:
		usage()
	}
	if err != nil {
		fail(err)
	}
}

// run executes a command, mirroring it in the island, and exits with its code.
// If the daemon is unreachable the command still runs.
func run(args []string) int {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	name := fs.String("n", "", "name to show (default: the command line)")
	fs.Parse(args)
	cmdArgs := fs.Args()
	if len(cmdArgs) == 0 {
		usage()
	}
	title := *name
	if title == "" {
		title = strings.Join(cmdArgs, " ")
	}

	var id uint32
	tracked := call("TaskStart", title).Store(&id) == nil

	cmd := exec.Command(cmdArgs[0], cmdArgs[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	signal.Ignore(syscall.SIGINT, syscall.SIGQUIT) // let the child handle Ctrl-C, then report
	code := 0
	if err := cmd.Run(); err != nil {
		var ee *exec.ExitError
		switch {
		case errors.As(err, &ee):
			code = ee.ExitCode()
			if code < 0 { // killed by a signal
				code = 128 + int(ee.Sys().(syscall.WaitStatus).Signal())
			}
		default:
			fmt.Fprintln(os.Stderr, "island:", err)
			code = 127
		}
	}
	if tracked {
		call("TaskEnd", id, int32(code))
	}
	return code
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "island:", err)
	os.Exit(1)
}
