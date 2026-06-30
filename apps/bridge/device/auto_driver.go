// Package device — auto_driver implements "auto" detection: try USB (Timy 3)
// first; if not found, fall back to the serial port named in SerialConfig.
package device

import (
	"context"
	"fmt"
	"sync/atomic"
)

// AutoDriver tries to open a TimyDriver first; on failure it falls back to a
// serial driver using the port in SerialConfig (if configured).
type AutoDriver struct {
	usbVendorID  uint16
	usbProductID uint16
	serial       SerialConfig
	active       Driver  // the driver that was successfully opened
	connected    int32   // atomic: 1 = open
}

// newAutoDriver creates an AutoDriver that tries USB then serial.
func newAutoDriver(usbVendorID, usbProductID uint16, serial SerialConfig) *AutoDriver {
	if usbVendorID == 0 {
		usbVendorID = timyDefaultVendorID
	}
	if usbProductID == 0 {
		usbProductID = timyDefaultProductID
	}
	applySerialDefaults(&serial)
	return &AutoDriver{
		usbVendorID:  usbVendorID,
		usbProductID: usbProductID,
		serial:       serial,
	}
}

// Name returns the active driver's name after Open, or a generic label.
func (a *AutoDriver) Name() string {
	if a.active != nil {
		return "auto → " + a.active.Name()
	}
	return "auto (no device selected)"
}

// Open attempts USB (Timy 3) first; falls back to the configured serial port.
// Returns an error only when both attempts fail (or serial is not configured
// and USB fails).
func (a *AutoDriver) Open() error {
	// Attempt 1: USB Timy 3.
	timy, err := newTimyDriver(a.usbVendorID, a.usbProductID)
	if err == nil {
		if err2 := timy.Open(); err2 == nil {
			a.active = timy
			atomic.StoreInt32(&a.connected, 1)
			return nil
		}
	}

	// Attempt 2: fall back to serial port if configured.
	if a.serial.Port == "" {
		return fmt.Errorf("auto detect: USB device not found and no serial_port configured")
	}

	serial := newTagHeuerDriver(a.serial) // generic serial — TagHeuer stub is fine as placeholder
	if err := serial.Open(); err != nil {
		return fmt.Errorf("auto detect: USB and serial both failed: %w", err)
	}
	a.active = serial
	atomic.StoreInt32(&a.connected, 1)
	return nil
}

// ReadLoop delegates to the active driver's ReadLoop.
func (a *AutoDriver) ReadLoop(ctx context.Context, ch chan<- Impulse) error {
	if a.active == nil {
		return fmt.Errorf("auto driver: ReadLoop called before Open")
	}
	return a.active.ReadLoop(ctx, ch)
}

// Close delegates to the active driver.
func (a *AutoDriver) Close() error {
	atomic.StoreInt32(&a.connected, 0)
	if a.active == nil {
		return nil
	}
	return a.active.Close()
}

// IsConnected returns true if an underlying driver is open.
func (a *AutoDriver) IsConnected() bool {
	return atomic.LoadInt32(&a.connected) == 1
}
