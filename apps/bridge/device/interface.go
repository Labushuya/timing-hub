// Package device defines the universal timing device abstraction used by the
// Universal Timing Bridge. Every hardware adapter (USB or serial) implements
// the Driver interface so that main.go and the WS client are decoupled from
// any specific timing device brand.
package device

import (
	"context"
)

// Impulse represents a single timing impulse from any device.
// This is the canonical data type passed from any driver to the WS client.
type Impulse struct {
	RunningNum int
	EpochMs    int64  // UTC epoch milliseconds
	Channel    int    // 1 or 2
	RawLine    string // original ASCII line for audit
}

// Driver is implemented by each timing device adapter.
type Driver interface {
	// Name returns the human-readable device name for logging.
	Name() string
	// Open initialises the connection to the device.
	Open() error
	// ReadLoop sends Impulse values to ch until ctx is cancelled or device
	// disconnects. Must return (not block forever) when ctx is cancelled.
	ReadLoop(ctx context.Context, ch chan<- Impulse) error
	// Close releases resources.
	Close() error
	// IsConnected returns true if the device is currently connected.
	IsConnected() bool
}

// SerialConfig holds parameters for RS-232/USB-serial devices.
type SerialConfig struct {
	Port     string // e.g. "COM3" or "/dev/ttyUSB0"
	BaudRate int    // default 9600
	DataBits int    // default 8
	StopBits int    // default 1
	Parity   string // "none", "odd", "even"
}
