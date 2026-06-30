// Package tagheuer implements the device.Driver interface for TAG Heuer CP
// series timing consoles (CP 450, 500, 520, 525, 540) connected via RS-232
// serial or a USB-to-serial adapter.
//
// # Protocol
//
// The CP series emits ASCII lines terminated with CR+LF.  Two variants exist:
//
// Format A (CP 540, most common):
//
//	"  NNNN  HH:MM:SS.mmm  X\r\n"
//
// where NNNN is the running sequence number, HH:MM:SS.mmm is time-of-day,
// and X is "A" (channel 1) or "B" (channel 2).
//
// Format B (CP 450/500, older firmware):
//
//	"HH:MM:SS.mmm NNN X\r\n"
//
// where the time-of-day comes first, followed by the running number and
// channel letter.
//
// # Epoch Conversion
//
// The CP series reports time-of-day, not absolute UTC.  TagHeuerDriver uses
// the same session-anchor technique as the Alge Timy driver: on the first
// received impulse the wall-clock UTC instant is recorded together with the
// device TOD, and all subsequent impulses are mapped to UTC via
//
//	epochMs = sessionStartUTC − sessionStartTOD + dayOffset + tod
//
// with dayOffset accumulating 24 h each time a midnight rollover is detected.
package tagheuer

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

// formatARegexp matches CP 540-style lines:
//
//	"  NNNN  HH:MM:SS.mmm  X"
//
// Groups: 1=runNum, 2=HH, 3=MM, 4=SS, 5=mmm, 6=channel-letter
var formatARegexp = regexp.MustCompile(
	`^\s*(\d+)\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+([AB12])\s*$`,
)

// formatBRegexp matches CP 450/500-style lines:
//
//	"HH:MM:SS.mmm NNN X"
//
// Groups: 1=HH, 2=MM, 3=SS, 4=mmm, 5=runNum, 6=channel-letter
var formatBRegexp = regexp.MustCompile(
	`^(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+(\d+)\s+([AB12])\s*$`,
)

// ---------------------------------------------------------------------------
// parseTagHeuerLine — pure parsing function (also called by tests)
// ---------------------------------------------------------------------------

// parseTagHeuerLine parses one ASCII impulse line from a TAG Heuer CP series
// device.  It tries Format A first (CP 540), then falls back to Format B
// (CP 450/500).
//
// Returns the running sequence number, the device time-of-day as a
// time.Duration since midnight, the channel (1 or 2), and any parse error.
func parseTagHeuerLine(line string) (runningNum int, tod time.Duration, channel int, err error) {
	line = strings.TrimSpace(line)
	if line == "" {
		return 0, 0, 0, fmt.Errorf("tagheuer: empty line")
	}

	// --- Format A ---
	if m := formatARegexp.FindStringSubmatch(line); m != nil {
		runningNum, _ = strconv.Atoi(m[1])
		tod, err = parseTOD(m[2], m[3], m[4], m[5])
		if err != nil {
			return 0, 0, 0, fmt.Errorf("tagheuer: format A TOD: %w", err)
		}
		channel = letterToChannel(m[6])
		return runningNum, tod, channel, nil
	}

	// --- Format B ---
	if m := formatBRegexp.FindStringSubmatch(line); m != nil {
		tod, err = parseTOD(m[1], m[2], m[3], m[4])
		if err != nil {
			return 0, 0, 0, fmt.Errorf("tagheuer: format B TOD: %w", err)
		}
		runningNum, _ = strconv.Atoi(m[5])
		channel = letterToChannel(m[6])
		return runningNum, tod, channel, nil
	}

	return 0, 0, 0, fmt.Errorf("tagheuer: unrecognised line format: %q", line)
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

// letterToChannel converts a channel indicator from the wire format to an
// integer channel number.  "A" or "1" → 1; "B" or "2" → 2.
func letterToChannel(s string) int {
	switch s {
	case "A", "1":
		return 1
	case "B", "2":
		return 2
	default:
		return 1 // safe default
	}
}

// ---------------------------------------------------------------------------
// TagHeuerDriver — implements device.Driver
// ---------------------------------------------------------------------------

// TagHeuerDriver is a fully functional RS-232 driver for TAG Heuer CP series
// timing consoles.  It uses go.bug.st/serial for cross-platform serial I/O.
type TagHeuerDriver struct {
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

// NewTagHeuerDriver creates a TagHeuerDriver with the given serial config.
// Zero values in cfg are replaced with sensible defaults (9600 8N1).
func NewTagHeuerDriver(cfg device.SerialConfig) *TagHeuerDriver {
	applyDefaults(&cfg)
	return &TagHeuerDriver{cfg: cfg}
}

// applyDefaults fills in zero values for a SerialConfig.
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
func (d *TagHeuerDriver) Name() string {
	return fmt.Sprintf("TAG Heuer CP (%s @ %d baud)", d.cfg.Port, d.cfg.BaudRate)
}

// Open opens the serial port and sends the "R" command that instructs most
// TAG Heuer CP devices to begin streaming timing data.
func (d *TagHeuerDriver) Open() error {
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
		return fmt.Errorf("tagheuer: open %s: %w", d.cfg.Port, err)
	}

	// Set a read deadline so ReadLoop can check ctx between reads.
	if err := p.SetReadTimeout(2 * time.Second); err != nil {
		_ = p.Close()
		return fmt.Errorf("tagheuer: set read timeout: %w", err)
	}

	// Send "R\r\n" to start streaming.  Non-fatal if the write fails.
	_, _ = p.Write([]byte("R\r\n"))

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
// them with parseTagHeuerLine, converts the device TOD to UTC epoch
// milliseconds, and sends device.Impulse values to ch.
//
// It returns when ctx is cancelled or the port encounters a non-timeout error.
func (d *TagHeuerDriver) ReadLoop(ctx context.Context, ch chan<- device.Impulse) error {
	d.mu.Lock()
	port := d.port
	d.mu.Unlock()

	if port == nil {
		return fmt.Errorf("tagheuer: ReadLoop called before Open")
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
				return fmt.Errorf("tagheuer: serial port closed")
			}
			// Distinguish timeout (retry) from hard error (exit).
			if isSerialTimeout(err) {
				continue
			}
			return fmt.Errorf("tagheuer: read error: %w", err)
		}

		line := scanner.Text()
		runNum, tod, channel, parseErr := parseTagHeuerLine(line)
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
func (d *TagHeuerDriver) Close() error {
	atomic.StoreInt32(&d.connected, 0)

	d.mu.Lock()
	port := d.port
	d.port = nil
	d.mu.Unlock()

	if port == nil {
		return nil
	}
	if err := port.Close(); err != nil {
		return fmt.Errorf("tagheuer: close %s: %w", d.cfg.Port, err)
	}
	return nil
}

// IsConnected reports whether the serial port is currently open.
func (d *TagHeuerDriver) IsConnected() bool {
	return atomic.LoadInt32(&d.connected) == 1
}

// ---------------------------------------------------------------------------
// Epoch conversion helpers (same algorithm as usb.TimyDevice)
// ---------------------------------------------------------------------------

// todToEpochMs converts a device time-of-day to a UTC epoch millisecond,
// updating the driver's midnight-rollover state.  Must be called in the
// order impulses arrive (sequential TOD values).
//
// Caller need not hold mu — this runs single-threaded inside ReadLoop.
func (d *TagHeuerDriver) todToEpochMs(tod time.Duration) int64 {
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
	// go.bug.st/serial exposes PortError with Code() == ReadTimeout.
	type portErrorer interface {
		Code() serial.PortErrorCode
	}
	var pe portErrorer
	if e, ok := err.(portErrorer); ok {
		pe = e
		return pe.Code() == serial.ReadTimeout
	}
	return false
}
