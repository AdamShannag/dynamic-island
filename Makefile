APP        := dynamic-island
UUID       := dynamic-island@adamshannag.github.io
DAEMON     := dynamic-islandd
CLI        := island
EXT_SRC    := extension/$(UUID)

BIN_DIR    := $(HOME)/.local/bin
EXT_DIR    := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
UNIT_DIR   := $(HOME)/.config/systemd/user

VERSION    ?= $(shell git describe --tags --always --dirty 2>/dev/null | sed 's/^v//' || echo dev)
DEB_VERSION = $(shell echo "$(VERSION)" | sed -E 's/^([0-9]+\.[0-9]+\.[0-9]+)-([0-9]+)-g/\1+git\2./; s/-dirty$$/+dirty/; s/^([^0-9])/0.0.0+\1/')
LDFLAGS    := -s -w -X main.version=$(VERSION)
GOBUILD    := CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)"
ARCHES     := amd64 arm64
NFPM       ?= nfpm

.PHONY: all build test test-go test-js check fmt schemas install install-daemon install-extension uninstall \
        run logs dist deb clean

all: check test build

build:
	$(GOBUILD) -o bin/ ./cmd/...

test: test-go test-js

test-go:
	go test -race ./...

test-js:
	cd extension && npm test

check:
	@test -z "$$(gofmt -l cmd internal)" || { gofmt -l cmd internal; echo "run: make fmt"; exit 1; }
	go vet ./...
	cd extension && npm run check
	@if command -v glib-compile-schemas >/dev/null; then glib-compile-schemas --strict --dry-run $(EXT_SRC)/schemas; fi

schemas:
	glib-compile-schemas --strict $(EXT_SRC)/schemas

fmt:
	gofmt -w cmd internal

install: install-daemon install-extension

install-daemon: build
	install -Dm755 bin/$(DAEMON) $(BIN_DIR)/$(DAEMON)
	install -Dm755 bin/$(CLI) $(BIN_DIR)/$(CLI)
	install -Dm644 systemd/$(APP).service $(UNIT_DIR)/$(APP).service
	systemctl --user daemon-reload
	systemctl --user enable --now $(APP).service
	systemctl --user restart $(APP).service

install-extension:
	mkdir -p $(EXT_DIR)
	cp -r $(EXT_SRC)/. $(EXT_DIR)/
	@if command -v glib-compile-schemas >/dev/null; then glib-compile-schemas $(EXT_DIR)/schemas; fi
	@echo "Extension copied. First install: log out and back in (X11: Alt+F2, r), then:"
	@echo "  gnome-extensions enable $(UUID)"

uninstall:
	./uninstall.sh

run: build
	./bin/$(DAEMON)

logs:
	journalctl --user -fu $(APP) & journalctl -f -o cat /usr/bin/gnome-shell | grep --line-buffered -i $(APP)

dist:
	mkdir -p dist/$(APP)/extension
	for arch in $(ARCHES); do \
		GOARCH=$$arch $(GOBUILD) -o dist/$(APP)/bin/linux-$$arch/ ./cmd/... || exit 1; \
	done
	cp -r $(EXT_SRC) dist/$(APP)/extension/
	cp -r systemd contrib install.sh uninstall.sh README.md LICENSE config.example.json dist/$(APP)/
	tar -C dist -czf dist/$(APP)-$(VERSION).tar.gz $(APP)
	@echo dist/$(APP)-$(VERSION).tar.gz

deb:
	mkdir -p dist
	for arch in $(ARCHES); do \
		GOARCH=$$arch $(GOBUILD) -o build/pkg/ ./cmd/... || exit 1; \
		ARCH=$$arch VERSION=$(DEB_VERSION) $(NFPM) package -f packaging/nfpm.yaml -p deb -t dist/ || exit 1; \
	done

clean:
	go clean
	git clean -fdX -- bin build dist
