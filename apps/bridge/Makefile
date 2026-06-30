.PHONY: build build-all build-ci clean

VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
LDFLAGS := -ldflags "-s -w -X main.Version=$(VERSION)"

# Local build for the current platform.
build:
	go build $(LDFLAGS) -o timy-bridge .

# Cross-compile all release targets (for local use; CI uses build-ci per matrix).
build-all:
	GOOS=windows GOARCH=amd64 go build $(LDFLAGS) -o dist/timy-bridge-windows-amd64.exe .
	GOOS=darwin  GOARCH=arm64 go build $(LDFLAGS) -o dist/timy-bridge-darwin-arm64 .
	GOOS=darwin  GOARCH=amd64 go build $(LDFLAGS) -o dist/timy-bridge-darwin-amd64 .
	GOOS=linux   GOARCH=amd64 go build $(LDFLAGS) -o dist/timy-bridge-linux-amd64 .

# Single-platform CI build: caller must set OUTPUT (e.g. dist/timy-bridge-linux-amd64).
build-ci:
	go build $(LDFLAGS) -o $(OUTPUT) .

clean:
	rm -rf dist/ timy-bridge timy-bridge.exe
