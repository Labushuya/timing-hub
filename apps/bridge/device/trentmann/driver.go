// Package trentmann implements the device.Driver interface for the Trentmann
// RallyStar timing console, manufactured by Trentmann GmbH, Erkrath, Germany.
// The RallyStar is widely used in German ADAC Gleichmäßigkeitsprüfungen and
// Orientierungsfahrten.
//
// # Connection
//
// RS-232 serial, typical settings: 9600 baud, 8N1.  No special initialisation
// command is required — the device begins streaming timing data as soon as the
// serial connection is established.
//
// # Protocol
//
// The RallyStar emits ASCII lines terminated with CR+LF.  Two delimiter
// variants exist depending on firmware version:
//
// Space-delimited (most common):
//
//	"042 00:01:23.456 1\r\n"
//
// where 042 is the running sequence number, 00:01:23.456 is the device
// time-of-day (HH:MM:SS.mmm), and 1 is the channel number.
//
// Semicolon-delimited (some older firmware versions):
//
//	"042;00:01:23.456;1\r\n"
//
// # Epoch Conversion
//
// Like all TOD-based timing devices, the RallyStar reports time-of-day rather
// than absolute UTC.  TrentmannDriver uses the same session-anchor algorithm
// as the TAG Heuer driver: on the first received impulse the wall-clock UTC
// instant is recorded together with the device TOD, and all subsequent
// impulses are mapped to UTC via
//
//	epochMs = sessionStartUTC − sessionStartTOD + dayOffset + tod
//
// with dayOffset accumulating 24 h each time a midnight rollover is detected.
package trentmann

import (
	"bufio"
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"go.bug.st/serial"

	"github.com/timing-hub/timy-bridge/device"
)

// ---------------------------------------------------------------------------
// Regular expressions for line parsing
// ---------------------------------------------------------------------------

// spaceRegexp matches the space-delimited RallyStar format:
//
//	"042 00:01:23.456 1"
//
// Groups: 1=runNum, 2=HH, 3=MM, 4=SS, 5=mmm, 6=channel
var spaceRegexp = regexp.MustCompile(
	`^\s*(\d+)\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+(\d+)\s*$`,
)

// semicolonRegexp matches the semicolon-delimited RallyStar format:
//
//	"042;00:01:23.456;1"
//
// Groups: 1=runNum, 2=HH, 3=MM, 4=SS, 5=mmm, 6=channel
var semicolonRegexp = regexp.MustCompile(
	`^\s*(\d+);(\d{2}):(\d{2}):(\d{2})\.(\d{3});(\d+)\s*$`,
)

// ---------------------------------------------------------------------------
// parseRallyStarLine — pure parsing function (also called by tests)
// ---------------------------------------------------------------------------

// parseRallyStarLine parses one ASCII impulse line from a Trentmann RallyStar
// device.  It accepts both the space-delimited and the semicolon-delimited
// variants and tries space-delimited first.
//
// Returns the running sequence number, the device time-of-day as a
// time.Duration since midnight, the channel number, and any parse error.
func parseRallyStarLine(line string) (runningNum int, tod time.Duration, channel int, err error) {
	line = strings.TrimSpace(line)
	if line == "" {
		return 0, 0, 0, fmt.Errorf("trentmann: empty line")
	}

	// --- Space-delimited ---
	if m := spaceRegexp.FindStringSubmatch(line); m != nil {
		runningNum, _ = strconv.Atoi(m[1])
		tod, err = parseTOD(m[2], m[3], m[4], m[5])
		if err != nil {
			return 0, 0, 0, fmt.Errorf("trentmann: space format TOD: %w", err)
		}
		channel, _ = strconv.Atoi(m[6])
		return runningNum, tod, channel, nil
	}

	// --- Semicolon-delimited ---
	if m := semicolonRegexp.FindStringSubmatch(line); m != nil {
		runningNum, _ = strconv.Atoi(m[1])
		tod, err = parseTOD(m[2], m[3], m[4], m[5])
		if err != nil {
			return 0, 0, 0, fmt.Errorf("trentmann: semicolon format TOD: %w", err)
		}
		channel, _ = strconv.Atoi(m[6])
		return runningNum, tod, channel, nil
	}

	return 0, 0, 0, fmt.Errorf("trentmann: unrecognised line format: %q", line)
}

// parseTOD converts individual HH, MM, SS, mmm string components to a
// time.Duration since midnight.
func parseTOD(hh, mm, ss, ms string) (time.Duration, error) {
	h, err := strconv.Atoi(hh)
	if err != nil || h < 0 || h > 23 {
		return 0, fmt.Errorf("invalid hour %q", hh)
	}
	m, err := strconv.Atoi(mm)
	if err != nil || m < 0 || m > 59 {
		return 0, fmt.Errorf("invalid minute %q", mm)
	}
	s, err := strconv.Atoi(ss)
	if err != nil || s < 0 || s > 59 {
		return 0, fmt.Errorf("invalid second %q", ss)
	}
	msv, err := strconv.Atoi(ms)
	if err != nil || msv < 0 || msv > 999 {
		return 0, fmt.Errorf("invalid millisecond %q", ms)
	}
	tod := time.Duration(h)*time.Hour +
		time.Duration(m)*time.Minute +
		time.Duration(s)*time.Second +
		time.Duration(msv)*time.Millisecond
	return tod, nil
}

// ---------------------------------------------------------------------------
// TrentmannDriver — implements device.Driver
// ---------------------------------------------------------------------------

// TrentmannDriver is a fully functional RS-232 driver for the Trentmann
// RallyStar timing console.  It uses go.bug.st/serial for cross-platform
// serial I/O.
type TrentmannDriver struct {
	cfg  device.SerialConfig
	port serial.Port

	// epoch-conversion state (protected by mu during Open, reset per-session)
	mu              sync.Mutex
	todInitialised  bool
	sessionStartUTC time.Time
	sessionStartTOD time.Duration
	prevTOD         time.Duration
	dayOffset       time.Duration

	connected int32 // atomic: 1 = port open
}

// NewTrentmannDriver creates a TrentmannDriver with the given serial config.
// Zero values in cfg are replaced with the RallyStar defaults (9600 8N1).
func NewTrentmannDriver(cfg device.SerialConfig) *TrentmannDriver {
	applyDefaults(&cfg)
	return &TrentmannDriver{cfg: cfg}
}

// applyDefaults fills in zero values for a SerialConfig using the RallyStar
// factory defaults.
func applyDefaults(s *device.SerialConfig) {
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

// Name returns a human-readable identifier used in log output.
func (d *TrentmannDriver) Name() string {
	return fmt.Sprintf("Trentmann RallyStar (%s @ %d baud)", d.cfg.Port, d.cfg.BaudRate)
}

// Open opens the serial port.  The RallyStar begins streaming timing data
// immediately on connection — no initialisation command is required.
func (d *TrentmannDriver) Open() error {
	d.mu.Lock()
	defer d.mu.Unlock()

	mode := &serial.Mode{
		BaudRate: d.cfg.BaudRate,
		DataBits: d.cfg.DataBits,
		StopBits: serialStopBits(d.cfg.StopBits),
		Parity:   serialParity(d.cfg.Parity),
	}

	p, err := serial.Open(d.cfg.Port, mode)
	if err != nil {
		return fmt.Errorf("trentmann: open %s: %w", d.cfg.Port, err)
	}

	// Set a read deadline so ReadLoop can check ctx between reads.
	if err := p.SetReadTimeout(2 * time.Second); err != nil {
		_ = p.Close()
		return fmt.Errorf("trentmann: set read timeout: %w", err)
	}

	d.port = p

	// Reset epoch-conversion state for this new session.
	d.sessionStartUTC = time.Now().UTC()
	d.todInitialised = false
	d.prevTOD = 0
	d.dayOffset = 0

	atomic.StoreInt32(&d.connected, 1)
	return nil
}

// ReadLoop reads CR+LF terminated ASCII lines from the serial port, parses
// them with parseRallyStarLine, converts the device TOD to UTC epoch
// milliseconds, and sends device.Impulse values to ch.
//
// It returns when ctx is cancelled or the port encounters a non-timeout error.
func (d *TrentmannDriver) ReadLoop(ctx context.Context, ch chan<- device.Impulse) error {
	d.mu.Lock()
	port := d.port
	d.mu.Unlock()

	if port == nil {
		return fmt.Errorf("trentmann: ReadLoop called before Open")
	}

	scanner := bufio.NewScanner(port)

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		if !scanner.Scan() {
			err := scanner.Err()
			if err == nil {
				// EOF — port closed.
				return fmt.Errorf("trentmann: serial port closed")
			}
			// Distinguish timeout (retry) from hard error (exit).
			if isSerialTimeout(err) {
				continue
			}
			return fmt.Errorf("trentmann: read error: %w", err)
		}

		line := scanner.Text()
		runNum, tod, channel, parseErr := parseRallyStarLine(line)
		if parseErr != nil {
			// Ignore garbage / comment lines silently.
			continue
		}

		epochMs := d.todToEpochMs(tod)

		imp := device.Impulse{
			RunningNum: runNum,
			EpochMs:    epochMs,
			Channel:    channel,
			RawLine:    line,
		}

		select {
		case ch <- imp:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// Close closes the serial port and marks the driver as disconnected.
func (d *TrentmannDriver) Close() error {
	atomic.StoreInt32(&d.connected, 0)

	d.mu.Lock()
	port := d.port
	d.port = nil
	d.mu.Unlock()

	if port == nil {
		return nil
	}
	if err := port.Close(); err != nil {
		return fmt.Errorf("trentmann: close %s: %w", d.cfg.Port, err)
	}
	return nil
}

// IsConnected reports whether the serial port is currently open.
func (d *TrentmannDriver) IsConnected() bool {
	return atomic.LoadInt32(&d.connected) == 1
}

// ---------------------------------------------------------------------------
// Epoch conversion helpers
// ---------------------------------------------------------------------------

// todToEpochMs converts a device time-of-day to a UTC epoch millisecond,
// updating the driver's midnight-rollover state.  Must be called in the
// order impulses arrive (sequential TOD values).
//
// Caller need not hold mu — this runs single-threaded inside ReadLoop.
func (d *TrentmannDriver) todToEpochMs(tod time.Duration) int64 {
	if !d.todInitialised {
		d.sessionStartTOD = tod
		d.todInitialised = true
	}

	// Midnight rollover: if this TOD is earlier than the previous one, the
	// device clock passed midnight; accumulate an extra 24 h.
	if d.todInitialised && tod < d.prevTOD {
		d.dayOffset += 24 * time.Hour
	}
	d.prevTOD = tod

	return d.sessionStartUTC.UnixMilli() -
		d.sessionStartTOD.Milliseconds() +
		d.dayOffset.Milliseconds() +
		tod.Milliseconds()
}

// ---------------------------------------------------------------------------
// go.bug.st/serial mode helpers
// ---------------------------------------------------------------------------

func serialStopBits(n int) serial.StopBits {
	switch n {
	case 2:
		return serial.TwoStopBits
	default:
		return serial.OneStopBit
	}
}

func serialParity(s string) serial.Parity {
	switch strings.ToLower(s) {
	case "odd":
		return serial.OddParity
	case "even":
		return serial.EvenParity
	case "mark":
		return serial.MarkParity
	case "space":
		return serial.SpaceParity
	default:
		return serial.NoParity
	}
}

// isSerialTimeout reports whether err is a serial read-timeout error.
// go.bug.st/serial wraps timeouts in a PortError with code ReadTimeout.
func isSerialTimeout(err error) bool {
	if err == nil {
		return false
	}
	type portErrorer interface {
		Code() serial.PortErrorCode
	}
	if e, ok := err.(portErrorer); ok {
		return e.Code() == serial.ReadTimeout
	}
	return false
}
