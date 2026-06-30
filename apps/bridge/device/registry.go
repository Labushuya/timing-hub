// Package device — registry provides a factory that resolves a DeviceType to
// the appropriate Driver implementation.
package device

import (
	"fmt"
	"strings"
)

// DeviceType identifies which driver to use.
type DeviceType string

const (
	DeviceAlgeTimy3   DeviceType = "alge_timy"
	DeviceTagHeuerCP  DeviceType = "tag_heuer_cp"
	DeviceTrentmann   DeviceType = "trentmann_rallystar"
	DeviceAuto        DeviceType = "auto"

	timyDefaultVendorID  uint16 = 0x0c4a
	timyDefaultProductID uint16 = 0x0889
)

// NewDriver creates the appropriate Driver based on type and config.
// Returns an error if the type is unknown or the config is invalid.
//
//   - "alge_timy"           — USB CDC-ACM driver for Alge Timy 3.
//   - "tag_heuer_cp"        — serial driver for Tag Heuer CP series.
//   - "trentmann_rallystar" — serial driver for Trentmann RallyStar.
//   - "auto"                — tries USB (Timy VID/PID) first; falls back to
//     serial detection using serial.Port when set.
func NewDriver(deviceType DeviceType, usbVendorID, usbProductID uint16, serial SerialConfig) (Driver, error) {
	// Normalise type string (trim whitespace, lowercase).
	dt := DeviceType(strings.TrimSpace(strings.ToLower(string(deviceType))))

	switch dt {
	case DeviceAlgeTimy3:
		return newTimyDriver(usbVendorID, usbProductID)

	case DeviceTagHeuerCP:
		if serial.Port == "" {
			return nil, fmt.Errorf("device: tag_heuer_cp requires serial_port")
		}
		applySerialDefaults(&serial)
		return newTagHeuerDriver(serial), nil

	case DeviceTrentmann:
		if serial.Port == "" {
			return nil, fmt.Errorf("device: trentmann_rallystar requires serial_port")
		}
		applySerialDefaults(&serial)
		return newTrentmannDriver(serial), nil

	case DeviceAuto:
		return newAutoDriver(usbVendorID, usbProductID, serial), nil

	default:
		return nil, fmt.Errorf("device: unknown device type %q", deviceType)
	}
}

// applySerialDefaults fills in zero values for a SerialConfig.
func applySerialDefaults(s *SerialConfig) {
	if s.BaudRate == 0 {
		s.BaudRate = 9600
	}
	if s.DataBits == 0 {
		s.DataBits = 8
	}
	if s.StopBits == 0 {
		s.StopBits = 1
	}
	if s.Parity == "" {
		s.Parity = "none"
	}
}
