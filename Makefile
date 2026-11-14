UUID      := go-island@local
BIN_DIR   := $(HOME)/.local/bin
EXT_DIR   := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
UNIT_DIR  := $(HOME)/.config/systemd/user

VERSION   ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
GOFLAGS_REL := -trimpath -ldflags "-s -w"

.PHONY: build install install-daemon install-extension uninstall run logs dist

build:
	go build -o bin/ ./cmd/...

install: install-daemon install-extension

install-daemon: build
	install -Dm755 bin/islandd $(BIN_DIR)/islandd
	install -Dm755 bin/island  $(BIN_DIR)/island
	install -Dm644 systemd/islandd.service $(UNIT_DIR)/islandd.service
	systemctl --user daemon-reload
	systemctl --user enable --now islandd.service
	systemctl --user restart islandd.service

install-extension:
	mkdir -p $(EXT_DIR)
	cp -r extension/$(UUID)/. $(EXT_DIR)/
	@echo "Extension copied. First install: restart GNOME Shell (X11: Alt+F2, r), then:"
	@echo "  gnome-extensions enable $(UUID)"

uninstall:
	-systemctl --user disable --now islandd.service
	-gnome-extensions disable $(UUID)
	rm -f $(BIN_DIR)/islandd $(BIN_DIR)/island $(UNIT_DIR)/islandd.service
	rm -rf $(EXT_DIR)

# Run the daemon in the foreground (stop the service first).
run: build
	./bin/islandd

logs:
	journalctl --user -fu islandd & journalctl -f -o cat /usr/bin/gnome-shell | grep --line-buffered -i go-island

# Release tarball with static binaries for amd64 + arm64; unpack and run ./install.sh.
dist:
	rm -rf dist && mkdir -p dist/go-island
	for arch in amd64 arm64; do \
		CGO_ENABLED=0 GOOS=linux GOARCH=$$arch go build $(GOFLAGS_REL) -o dist/go-island/bin/linux-$$arch/ ./cmd/... || exit 1; \
	done
	cp -r extension systemd contrib install.sh uninstall.sh README.md config.example.json dist/go-island/
	tar -C dist -czf dist/go-island-$(VERSION).tar.gz go-island
	@echo "dist/go-island-$(VERSION).tar.gz"
