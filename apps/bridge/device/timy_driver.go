// Package device — timy_driver wraps usb.TimyDevice and implements Driver for
// the Alge Timy 3 USB CDC-ACM timing device.
package device

import (
	"context"
	"fmt"
	"sync/atomic"

	"github.com/timing-hub/timy-bridge/usb"
)

// TimyDriver implements Driver for the Alge Timy 3.
// It delegates to usb.TimyDevice for all hardware interaction.
type TimyDriver struct {
	vendorID  uint16
	productID uint16
	dev       *usb.TimyDevice
	connected int32 // atomic: 1 = open
}

// newTimyDriver creates a TimyDriver with the given USB VID/PID.
// Zero values fall back to Timy 3 defaults (0x0c4a / 0x0889).
func newTimyDriver(vendorID, productID uint16) (*TimyDriver, error) {
	if vendorID == 0 {
		vendorID = timyDefaultVendorID
	}
	if productID == 0 {
		productID = timyDefaultProductID
	}
	return &TimyDriver{
		vendorID:  vendorID,
		productID: productID,
	}, nil
}

// Name returns a human-readable identifier for log output.
func (t *TimyDriver) Name() string {
	return fmt.Sprintf("Alge Timy 3 (VID=0x%04x PID=0x%04x)", t.vendorID, t.productID)
}

// Open initialises the USB connection to the Timy 3 device.
func (t *TimyDriver) Open() error {
	dev, err := usb.NewTimyDevice(t.vendorID, t.productID)
	if err != nil {
		return err
	}
	if err := dev.Open(); err != nil {
		return err
	}
	t.dev = dev
	atomic.StoreInt32(&t.connected, 1)
	return nil
}

// ReadLoop reads impulses from the device and forwards them as device.Impulse
// values on ch. It returns when ctx is cancelled or the device disconnects.
func (t *TimyDriver) ReadLoop(ctx context.Context, ch chan<- Impulse) error {
	if t.dev == nil {
		return fmt.Errorf("timy driver: ReadLoop called before Open")
	}

	// usb.TimyDevice.ReadLoop sends usb.TimyImpulse values on an internal
	// channel and closes it on disconnect or ctx cancellation.
	impCh := make(chan usb.TimyImpulse, 64)
	go t.dev.ReadLoop(ctx, impCh)

	for imp := range impCh {
		select {
		case ch <- timyImpulseToDeviceImpulse(imp):
		case <-ctx.Done():
			// Drain remaining items so ReadLoop goroutine is not blocked on
			// the channel send, then return.
			go func() {
				for range impCh {
				}
			}()
			return ctx.Err()
		}
	}

	// impCh was closed by usb.TimyDevice.ReadLoop — device disconnected or
	// ctx was cancelled inside the USB layer.
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return fmt.Errorf("timy driver: device disconnected")
}

// Close releases USB resources.
func (t *TimyDriver) Close() error {
	atomic.StoreInt32(&t.connected, 0)
	if t.dev == nil {
		return nil
	}
	err := t.dev.Close()
	t.dev = nil
	return err
}

// IsConnected reports whether the device is currently open and reading.
func (t *TimyDriver) IsConnected() bool {
	return atomic.LoadInt32(&t.connected) == 1
}

// timyImpulseToDeviceImpulse converts a usb.TimyImpulse to the canonical
// device.Impulse type that is consumed by the rest of the bridge.
func timyImpulseToDeviceImpulse(imp usb.TimyImpulse) Impulse {
	return Impulse{
		RunningNum: imp.RunningNum,
		EpochMs:    imp.EpochMs,
		Channel:    imp.Channel,
		RawLine:    imp.RawLine,
	}
}
