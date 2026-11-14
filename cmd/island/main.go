// island is the CLI for the Go Island daemon.
//
//	island notify [-t ms] [-i icon] TITLE [BODY]
//	island action NAME        (e.g. media.play-pause)
//	island state
package main

import (
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/godbus/dbus/v5"

	"go-island/internal/dbusapi"
)

func usage() {
	fmt.Fprintln(os.Stderr, `usage:
  island notify [-t ms] [-i icon] TITLE [BODY]
  island action NAME
  island state`)
	os.Exit(2)
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		fail(err)
	}
	obj := conn.Object(dbusapi.BusName, dbusapi.Path)
	method := func(name string) string { return dbusapi.Iface + "." + name }

	switch os.Args[1] {
	case "notify":
		fs := flag.NewFlagSet("notify", flag.ExitOnError)
		timeout := fs.Int("t", 5000, "timeout in milliseconds")
		icon := fs.String("i", "", "icon name (default dialog-information-symbolic)")
		fs.Parse(os.Args[2:])
		if fs.NArg() < 1 {
			usage()
		}
		body := strings.Join(fs.Args()[1:], " ")
		var id uint32
		err = obj.Call(method("Notify"), 0, fs.Arg(0), body, *icon, int32(*timeout)).Store(&id)
	case "action":
		if len(os.Args) != 3 {
			usage()
		}
		err = obj.Call(method("Action"), 0, os.Args[2]).Err
	case "state":
		var s string
		if err = obj.Call(method("GetState"), 0).Store(&s); err == nil {
			fmt.Println(s)
		}
	default:
		usage()
	}
	if err != nil {
		fail(err)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "island:", err)
	os.Exit(1)
}
