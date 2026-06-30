// Package device — tag_heuer_driver provides a serial-based Driver stub for
// Tag Heuer CP series timing consoles.
//
// Full serial framing and command set for the Tag Heuer CP540/550/560 is not
// yet implemented.  The driver skeleton follows the same pattern as TimyDriver
// so it can be wired up to a real go-serial library without interface changes.
package device

import (
	"context"
	"fmt"
	"sync/atomic"
	"time"
)

// TagHeuerDriver implements Driver for Tag Heuer CP series timing consoles
// connected via RS-232/USB-serial.
type TagHeuerDriver struct {
	serial    SerialConfig
	connected int32 // atomic: 1 = open
}

// newTagHeuerDriver creates a TagHeuerDriver with the given serial config.
func newTagHeuerDriver(serial SerialConfig) *TagHeuerDriver {
	return &TagHeuerDriver{serial: serial}
}

// Name returns a human-readable identifier for log output.
func (d *TagHeuerDriver) Name() string {
	return fmt.Sprintf("Tag Heuer CP (%s @ %d baud)", d.serial.Port, d.serial.BaudRate)
}

// Open opens the serial port and initialises the device connection.
// TODO: replace placeholder with real go-serial open logic.
func (d *TagHeuerDriver) Open() error {
	// Placeholder: real implementation opens d.serial.Port via go-serial,
	// sets baud rate, data bits, parity, and stop bits, then sends any
	// required handshake commands to the CP console.
	atomic.StoreInt32(&d.connected, 1)
	return nil
}

// ReadLoop reads impulse lines from the serial port and forwards them as
// device.Impulse values on ch. Returns when ctx is cancelled or the device
// disconnects.
// TODO: replace placeholder polling with real serial read loop.
func (d *TagHeuerDriver) ReadLoop(ctx context.Context, ch chan<- Impulse) error {
	if atomic.LoadInt32(&d.connected) == 0 {
		return fmt.Errorf("tag heuer driver: ReadLoop called before Open")
	}

	// Placeholder: wake up every second and check for ctx cancellation so
	// that the goroutine exits cleanly.  Replace with blocking serial reads
	// that parse the Tag Heuer ASCII protocol and send Impulse values.
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
func (d *TagHeuerDriver) Close() error {
	atomic.StoreInt32(&d.connected, 0)
	// TODO: close the real serial port handle.
	return nil
}

// IsConnected reports whether the serial port is currently open.
func (d *TagHeuerDriver) IsConnected() bool {
	return atomic.LoadInt32(&d.connected) == 1
}
