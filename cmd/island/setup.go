package main

import (
	"bytes"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

const (
	serviceUnit   = "dynamic-island.service"
	extensionUUID = "dynamic-island@adamshannag.github.io"
)

func setupCmd(args []string) int {
	fs := flag.NewFlagSet("setup", flag.ExitOnError)
	remove := fs.Bool("remove", false, "disable the daemon and the GNOME extension")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "usage: island setup [--remove]")
	}
	fs.Parse(args)
	if fs.NArg() > 0 {
		fs.Usage()
		return 2
	}
	if os.Geteuid() == 0 {
		fmt.Fprintln(os.Stderr, "island setup configures your own session; run it as your user, not with sudo.")
		return 1
	}
	if *remove {
		return setupRemove()
	}
	return setupInstall()
}

func setupInstall() int {
	fmt.Println("Setting up Dynamic Island for", currentUser())
	ok := true

	step("Starting the background service")
	if _, err := runTool("systemctl", "--user", "daemon-reload"); err != nil {
		failed(err)
		ok = false
	} else if _, err := runTool("systemctl", "--user", "enable", "--now", serviceUnit); err != nil {
		failed(err)
		ok = false
	} else {
		done(serviceUnit + " is enabled and running")
	}

	step("Enabling the GNOME Shell extension")
	relogin := false
	if _, err := runTool("gnome-extensions", "enable", extensionUUID); err == nil {
		done(extensionUUID + " is enabled")
	} else if added, gerr := addEnabledExtension(extensionUUID); gerr != nil {
		failed(fmt.Errorf("%v; %v", err, gerr))
		ok = false
	} else {
		relogin = true
		if added {
			done("added to GNOME's enabled extensions")
		} else {
			done("already in GNOME's enabled extensions")
		}
	}

	fmt.Println()
	switch {
	case !ok:
		fmt.Println("Setup finished with problems (see above).")
		return 1
	case relogin:
		fmt.Println("All set. GNOME Shell has not loaded the extension yet:")
		fmt.Println("log out and back in, and the island will appear at the top of your screen.")
	default:
		fmt.Println("All set. The island should now be at the top of your screen.")
	}
	fmt.Println("Tip: run `island claude install` to show Claude Code sessions in the island.")
	return 0
}

func setupRemove() int {
	fmt.Println("Removing Dynamic Island from your session")
	ok := true

	step("Disabling the GNOME Shell extension")
	_, err := runTool("gnome-extensions", "disable", extensionUUID)
	removed, gerr := removeEnabledExtension(extensionUUID)
	switch {
	case err == nil || removed:
		done(extensionUUID + " is disabled")
	case gerr != nil:
		failed(fmt.Errorf("%v; %v", err, gerr))
		ok = false
	default:
		done("extension was not enabled")
	}

	step("Stopping the background service")
	if _, err := runTool("systemctl", "--user", "disable", "--now", serviceUnit); err != nil {
		failed(err)
		ok = false
	} else {
		done(serviceUnit + " is stopped and disabled")
	}

	fmt.Println()
	if !ok {
		fmt.Println("Finished with problems (see above).")
		return 1
	}
	fmt.Println("Done. Your notes, clipboard history and settings were left in place.")
	return 0
}

const (
	shellSchema = "org.gnome.shell"
	enabledKey  = "enabled-extensions"
)

func addEnabledExtension(uuid string) (bool, error) {
	list, err := enabledExtensions()
	if err != nil {
		return false, err
	}
	for _, u := range list {
		if u == uuid {
			return false, nil
		}
	}
	return true, setEnabledExtensions(append(list, uuid))
}

func removeEnabledExtension(uuid string) (bool, error) {
	list, err := enabledExtensions()
	if err != nil {
		return false, err
	}
	kept := list[:0:0]
	for _, u := range list {
		if u != uuid {
			kept = append(kept, u)
		}
	}
	if len(kept) == len(list) {
		return false, nil
	}
	return true, setEnabledExtensions(kept)
}

func enabledExtensions() ([]string, error) {
	out, err := runTool("gsettings", "get", shellSchema, enabledKey)
	if err != nil {
		return nil, err
	}
	return parseStrv(out), nil
}

func setEnabledExtensions(list []string) error {
	_, err := runTool("gsettings", "set", shellSchema, enabledKey, formatStrv(list))
	return err
}

func parseStrv(s string) []string {
	s = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(s), "@as"))
	s = strings.TrimSuffix(strings.TrimPrefix(s, "["), "]")
	var out []string
	for _, f := range strings.Split(s, ",") {
		f = strings.Trim(strings.TrimSpace(f), `'"`)
		if f != "" {
			out = append(out, f)
		}
	}
	return out
}

func formatStrv(list []string) string {
	q := make([]string, len(list))
	for i, u := range list {
		q[i] = "'" + strings.ReplaceAll(u, "'", `\'`) + "'"
	}
	return "[" + strings.Join(q, ", ") + "]"
}

func runTool(name string, args ...string) (string, error) {
	if _, err := exec.LookPath(name); err != nil {
		return "", fmt.Errorf("%s not found", name)
	}
	var stdout, stderr bytes.Buffer
	cmd := exec.Command(name, args...)
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return stdout.String(), fmt.Errorf("%s %s: %s", name, strings.Join(args, " "), msg)
	}
	return stdout.String(), nil
}

func currentUser() string {
	if u := os.Getenv("USER"); u != "" {
		return u
	}
	return "this user"
}

func step(msg string)  { fmt.Printf("• %s…\n", msg) }
func done(msg string)  { fmt.Printf("  ✓ %s\n", msg) }
func failed(err error) { fmt.Printf("  ✗ %v\n", err) }
