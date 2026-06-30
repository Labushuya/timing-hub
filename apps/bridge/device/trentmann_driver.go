// Package device — trentmann_driver provides a serial-based Driver stub for
// Trentmann RallyStar timing consoles.
//
// Full serial framing and command set for the RallyStar is not yet
// implemented.  The driver skeleton follows the same pattern as TimyDriver
// so it can be wired up to a real go-serial library without interface changes.
package device

import (
	"context"
	"fmt"
	"sync/atomic"
	"time"
)

// TrentmannDriver implements Driver for Trentmann RallyStar timing consoles
// connected via RS-232/USB-serial.
type TrentmannDriver struct {
	serial    SerialConfig
	connected int32 // atomic: 1 = open
}

// newTrentmannDriver creates a TrentmannDriver with the given serial config.
func newTrentmannDriver(serial SerialConfig) *TrentmannDriver {
	return &TrentmannDriver{serial: serial}
}

// Name returns a human-readable identifier for log output.
func (d *TrentmannDriver) Name() string {
	return fmt.Sprintf("Trentmann RallyStar (%s @ %d baud)", d.serial.Port, d.serial.BaudRate)
}

// Open opens the serial port and initialises the device connection.
// TODO: replace placeholder with real go-serial open logic.
func (d *TrentmannDriver) Open() error {
	// Placeholder: real implementation opens d.serial.Port via go-serial,
	// sets baud rate, data bits, parity, and stop bits, then sends any
	// required handshake commands to the RallyStar console.
	atomic.StoreInt32(&d.connected, 1)
	return nil
}

// ReadLoop reads impulse lines from the serial port and forwards them as
// device.Impulse values on ch. Returns when ctx is cancelled or the device
// disconnects.
// TODO: replace placeholder polling with real serial read loop.
func (d *TrentmannDriver) ReadLoop(ctx context.Context, ch chan<- Impulse) error {
	if atomic.LoadInt32(&d.connected) == 0 {
		return fmt.Errorf("trentmann driver: ReadLoop called before Open")
	}

	// Placeholder: wake up every second and check for ctx cancellation.
	// Replace with blocking serial reads that parse the RallyStar ASCII
	// protocol and send Impulse values.
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			// Real implementation: read from serial port, parse line,
			// send Impulse on ch.
		}
	}
}

// Close releases the serial port.
func (d *TrentmannDriver) Close() error {
	atomic.StoreInt32(&d.connected, 0)
	// TODO: close the real serial port handle.
	return nil
}

// IsConnected reports whether the serial port is currently open.
func (d *TrentmannDriver) IsConnected() bool {
	return atomic.LoadInt32(&d.connected) == 1
}
