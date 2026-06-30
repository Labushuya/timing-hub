// Package usb implements the Alge Timy 3 USB protocol reader.
//
// The Timy 3 presents as USB CDC-ACM (VID=0x0c4a, PID=0x0889). It sends
// ASCII impulse lines:
//
//	"  NNNN  HH:MM:SS.mmm  Cx\r\n"
//
// where NNNN is a running sequence number, HH:MM:SS.mmm is time-of-day
// (not epoch), and x is channel 1 or 2.
//
// # Architecture
//
// TimyDevice is the low-level USB driver. Monitor wraps TimyDevice with
// automatic reconnection and exposes the TimyEvent channel that main.go
// and the WS client consume.
package usb

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/gousb"
	"github.com/sirupsen/logrus"
	bridgehttp "github.com/timing-hub/timy-bridge/http"
)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const (
	defaultVendorID  = 0x0c4a
	defaultProductID = 0x0889

	bulkReadSize    = 64
	interfaceNumber = 0
	readTimeout     = 2 * time.Second
	reconnectDelay  = 3 * time.Second

	initCmdTimyInit = "TIMYINIT\r"
	initCmdEMU0     = "EMU0\r"
	initCmdCLR      = "CLR\r"
)

// impulseLineRegexp matches a Timy 3 impulse line.
// Groups: 1=running-num, 2=HH, 3=MM, 4=SS, 5=mmm, 6=channel-digit
var impulseLineRegexp = regexp.MustCompile(
	`^\s*(\d+)\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+C(\d)\s*$`,
)

// ---------------------------------------------------------------------------
// TimyImpulse — low-level parsed impulse
// ---------------------------------------------------------------------------

// TimyImpulse holds a single parsed timing impulse from the Timy 3.
type TimyImpulse struct {
	// RunningNum is the 4-digit sequence number printed by the device.
	RunningNum int
	// TimeOfDay is the duration since midnight as reported by the device.
	TimeOfDay time.Duration
	// EpochMs is the UTC epoch millisecond derived from TimeOfDay and the
	// session start time, with midnight-rollover correction applied.
	EpochMs int64
	// Channel is 1 or 2.
	Channel int
	// RawLine is the original ASCII line from the device (untrimmed).
	RawLine string
}

// ---------------------------------------------------------------------------
// TimyDevice — low-level USB driver
// ---------------------------------------------------------------------------

// TimyDevice manages a single USB connection to an Alge Timy 3.
// Create with NewTimyDevice; call Open before ReadLoop; call Close when done.
type TimyDevice struct {
	vendorID  uint16
	productID uint16

	mu          sync.Mutex
	usbCtx      *gousb.Context
	dev         *gousb.Device
	cfg         *gousb.Config
	iface       *gousb.Interface
	inEp        *gousb.InEndpoint
	outEp       *gousb.OutEndpoint
	connected   int32 // atomic: 1=connected, 0=not

	// time-of-day → epoch conversion state
	sessionStartUTC time.Time
	sessionStartTOD time.Duration
	todInitialised  bool
	prevTOD         time.Duration
	dayOffset       time.Duration // accumulated midnight rollovers
}

// NewTimyDevice creates a TimyDevice for the given USB VID/PID.
// Call Open to actually connect to the hardware.
func NewTimyDevice(vendorID, productID uint16) (*TimyDevice, error) {
	if vendorID == 0 {
		vendorID = defaultVendorID
	}
	if productID == 0 {
		productID = defaultProductID
	}
	return &TimyDevice{
		vendorID:  vendorID,
		productID: productID,
	}, nil
}

// Open finds the device on the USB bus, claims the interface, and sends
// the three initialisation commands.
func (d *TimyDevice) Open() error {
	d.mu.Lock()
	defer d.mu.Unlock()

	usbCtx := gousb.NewContext()

	dev, err := usbCtx.OpenDeviceWithVIDPID(
		gousb.ID(d.vendorID),
		gousb.ID(d.productID),
	)
	if err != nil {
		usbCtx.Close()
		return fmt.Errorf("timy: open device VID=%04x PID=%04x: %w",
			d.vendorID, d.productID, err)
	}
	if dev == nil {
		usbCtx.Close()
		return fmt.Errorf("timy: device not found (VID=%04x PID=%04x)",
			d.vendorID, d.productID)
	}

	// Ask libusb to detach any kernel driver automatically.
	if err := dev.SetAutoDetach(true); err != nil {
		// Non-fatal on Windows; log-worthy on Linux.
		_ = err
	}

	cfg, err := dev.Config(1)
	if err != nil {
		dev.Close()
		usbCtx.Close()
		return fmt.Errorf("timy: claim config 1: %w", err)
	}

	iface, err := cfg.Interface(interfaceNumber, 0)
	if err != nil {
		cfg.Close()
		dev.Close()
		usbCtx.Close()
		return fmt.Errorf("timy: claim interface %d: %w", interfaceNumber, err)
	}

	// Locate bulk IN and OUT endpoints.
	var inEp *gousb.InEndpoint
	var outEp *gousb.OutEndpoint
	for _, ep := range iface.Setting.Endpoints {
		switch {
		case ep.Direction == gousb.EndpointDirectionIn &&
			ep.TransferType == gousb.TransferTypeBulk && inEp == nil:
			inEp, err = iface.InEndpoint(ep.Number)
			if err != nil {
				iface.Close()
				cfg.Close()
				dev.Close()
				usbCtx.Close()
				return fmt.Errorf("timy: open bulk-in endpoint: %w", err)
			}
		case ep.Direction == gousb.EndpointDirectionOut &&
			ep.TransferType == gousb.TransferTypeBulk && outEp == nil:
			outEp, err = iface.OutEndpoint(ep.Number)
			if err != nil {
				// OUT endpoint failure is non-fatal; init commands are best-effort.
				outEp = nil
			}
		}
	}
	if inEp == nil {
		iface.Close()
		cfg.Close()
		dev.Close()
		usbCtx.Close()
		return fmt.Errorf("timy: no bulk-in endpoint found")
	}

	// Send initialisation commands.
	if outEp != nil {
		for _, cmd := range []string{initCmdTimyInit, initCmdEMU0, initCmdCLR} {
			if _, err := outEp.Write([]byte(cmd)); err != nil {
				// Non-fatal: device may still stream data.
				_ = err
			}
			time.Sleep(50 * time.Millisecond)
		}
	}

	d.usbCtx = usbCtx
	d.dev = dev
	d.cfg = cfg
	d.iface = iface
	d.inEp = inEp
	d.outEp = outEp

	// Reset epoch-conversion state for this session.
	d.sessionStartUTC = time.Now().UTC()
	d.todInitialised = false
	d.prevTOD = 0
	d.dayOffset = 0

	atomic.StoreInt32(&d.connected, 1)
	return nil
}

// ReadLoop reads bulk packets continuously, parses impulse lines, and sends
// TimyImpulse values to ch. It returns when ctx is cancelled, or when the
// device disconnects (in which case ch is closed before returning).
func (d *TimyDevice) ReadLoop(ctx context.Context, ch chan<- TimyImpulse) {
	defer func() {
		atomic.StoreInt32(&d.connected, 0)
		close(ch)
	}()

	d.mu.Lock()
	inEp := d.inEp
	d.mu.Unlock()

	if inEp == nil {
		return
	}

	buf := make([]byte, bulkReadSize)
	var lineBuf strings.Builder

	for {
		// Respect context cancellation between reads.
		select {
		case <-ctx.Done():
			return
		default:
		}

		n, err := inEp.Read(buf)
		if err != nil {
			// Any read error (including device disconnect) terminates the loop.
			return
		}
		if n == 0 {
			continue
		}

		lineBuf.Write(buf[:n])
		raw := lineBuf.String()

		// Extract complete lines (terminated by \n).
		for {
			idx := strings.IndexByte(raw, '\n')
			if idx < 0 {
				break
			}
			line := strings.TrimRight(raw[:idx], "\r")
			raw = raw[idx+1:]

			imp, err := d.parseTimyLine(line)
			if err != nil {
				// Garbage or empty line — skip silently.
				continue
			}

			select {
			case ch <- imp:
			case <-ctx.Done():
				// Drain remaining raw into lineBuf and exit.
				lineBuf.Reset()
				lineBuf.WriteString(raw)
				return
			}
		}
		// Preserve any incomplete line fragment.
		lineBuf.Reset()
		lineBuf.WriteString(raw)
	}
}

// Close releases all USB resources.
func (d *TimyDevice) Close() error {
	d.mu.Lock()
	defer d.mu.Unlock()

	atomic.StoreInt32(&d.connected, 0)

	if d.iface != nil {
		d.iface.Close()
		d.iface = nil
	}
	if d.cfg != nil {
		d.cfg.Close()
		d.cfg = nil
	}
	if d.dev != nil {
		if err := d.dev.Close(); err != nil {
			return fmt.Errorf("timy: close device: %w", err)
		}
		d.dev = nil
	}
	if d.usbCtx != nil {
		if err := d.usbCtx.Close(); err != nil {
			return fmt.Errorf("timy: close usb context: %w", err)
		}
		d.usbCtx = nil
	}
	return nil
}

// IsConnected reports whether the device is currently open and connected.
func (d *TimyDevice) IsConnected() bool {
	return atomic.LoadInt32(&d.connected) == 1
}

// parseTimyLine parses one ASCII impulse line and returns a TimyImpulse.
// It updates the device's internal time-of-day state (midnight rollover,
// epoch anchoring).
//
// Returns an error for empty, comment, or malformed lines.
func (d *TimyDevice) parseTimyLine(line string) (TimyImpulse, error) {
	return parseTimyLineWithState(
		line,
		d.sessionStartUTC,
		&d.todInitialised,
		&d.sessionStartTOD,
		&d.prevTOD,
		&d.dayOffset,
	)
}

// parseTimyLineWithState is the pure parsing function used by both TimyDevice
// and the unit tests (which supply their own state pointers).
func parseTimyLineWithState(
	line string,
	sessionStartUTC time.Time,
	todInitialised *bool,
	sessionStartTOD *time.Duration,
	prevTOD *time.Duration,
	dayOffset *time.Duration,
) (TimyImpulse, error) {
	m := impulseLineRegexp.FindStringSubmatch(line)
	if m == nil {
		return TimyImpulse{}, fmt.Errorf("timy: no match: %q", line)
	}

	runNum, _ := strconv.Atoi(m[1])
	hh, _ := strconv.Atoi(m[2])
	mm, _ := strconv.Atoi(m[3])
	ss, _ := strconv.Atoi(m[4])
	ms, _ := strconv.Atoi(m[5])
	ch, _ := strconv.Atoi(m[6])

	tod := time.Duration(hh)*time.Hour +
		time.Duration(mm)*time.Minute +
		time.Duration(ss)*time.Second +
		time.Duration(ms)*time.Millisecond

	// Anchor the session: record the first time-of-day seen so we can
	// compute the UTC epoch offset for all subsequent impulses.
	if !*todInitialised {
		*sessionStartTOD = tod
		*todInitialised = true
	}

	// Midnight rollover detection: if new TOD is less than the previous TOD
	// (e.g. prev=23:59:58, new=00:00:01), the clock crossed midnight and we
	// must add 24 h to the day offset.
	if *todInitialised && tod < *prevTOD {
		*dayOffset += 24 * time.Hour
	}
	*prevTOD = tod

	// epochMs = sessionStartUTC − sessionStartTOD + dayOffset + tod
	//
	// This maps the device's time-of-day onto the UTC timeline anchored at
	// the moment Open() was called.
	epochMs := sessionStartUTC.UnixMilli() -
		sessionStartTOD.Milliseconds() +
		dayOffset.Milliseconds() +
		tod.Milliseconds()

	return TimyImpulse{
		RunningNum: runNum,
		TimeOfDay:  tod,
		EpochMs:    epochMs,
		Channel:    ch,
		RawLine:    line,
	}, nil
}

// ---------------------------------------------------------------------------
// TimyEvent — public type consumed by ws.Client and main.go
// ---------------------------------------------------------------------------

// TimyEvent is the bridge-internal event emitted by Monitor.
// The WS client and HTTP status endpoint consume this type.
type TimyEvent struct {
	// Seq is the running sequence number from the device.
	Seq int
	// Channel is 1 or 2.
	Channel int
	// TimestampMs is the UTC epoch millisecond.
	TimestampMs int64
	// Raw is the original ASCII line from the device (trimmed).
	Raw string
}

// impulseToEvent converts a TimyImpulse to the TimyEvent consumed by the
// rest of the bridge.
func impulseToEvent(imp TimyImpulse) TimyEvent {
	return TimyEvent{
		Seq:         imp.RunningNum,
		Channel:     imp.Channel,
		TimestampMs: imp.EpochMs,
		Raw:         strings.TrimSpace(imp.RawLine),
	}
}

// ---------------------------------------------------------------------------
// Config — device selection parameters (used by Monitor and main.go)
// ---------------------------------------------------------------------------

// Config holds USB device selection parameters for Monitor.
type Config struct {
	VendorID   uint16
	ProductID  uint16
	AutoDetect bool
}

// ---------------------------------------------------------------------------
// Monitor — reconnecting wrapper around TimyDevice
// ---------------------------------------------------------------------------

// Monitor opens the Timy 3 USB device and emits TimyEvents on eventBus.
// It reconnects automatically on disconnect.
type Monitor struct {
	cfg    Config
	log    *logrus.Logger
	state  *bridgehttp.State
	stopCh chan struct{}
	once   sync.Once
}

// NewMonitor creates a Monitor with the given configuration.
func NewMonitor(cfg Config, log *logrus.Logger, state *bridgehttp.State) *Monitor {
	if cfg.VendorID == 0 {
		cfg.VendorID = defaultVendorID
	}
	if cfg.ProductID == 0 {
		cfg.ProductID = defaultProductID
	}
	return &Monitor{
		cfg:    cfg,
		log:    log,
		state:  state,
		stopCh: make(chan struct{}),
	}
}

// Run opens the device and reads impulses, emitting them on eventBus.
// It blocks until Stop is called, reconnecting on disconnect.
func (m *Monitor) Run(eventBus chan<- TimyEvent) error {
	for {
		select {
		case <-m.stopCh:
			return nil
		default:
		}

		if err := m.runOnce(eventBus); err != nil {
			m.log.WithError(err).Warn("usb session ended, reconnecting")
			atomic.StoreInt32(&m.state.DeviceConnectedFlag, 0)
		}

		select {
		case <-m.stopCh:
			return nil
		case <-time.After(reconnectDelay):
		}
	}
}

func (m *Monitor) runOnce(eventBus chan<- TimyEvent) error {
	td, err := NewTimyDevice(m.cfg.VendorID, m.cfg.ProductID)
	if err != nil {
		return err
	}

	if err := td.Open(); err != nil {
		return err
	}
	defer func() {
		_ = td.Close()
		atomic.StoreInt32(&m.state.DeviceConnectedFlag, 0)
	}()

	m.log.WithFields(logrus.Fields{
		"vid": fmt.Sprintf("0x%04x", m.cfg.VendorID),
		"pid": fmt.Sprintf("0x%04x", m.cfg.ProductID),
	}).Info("Timy 3 device opened")
	atomic.StoreInt32(&m.state.DeviceConnectedFlag, 1)

	ctx, cancel := context.WithCancel(context.Background())

	// Watch for Stop() signal and cancel the ReadLoop.
	go func() {
		select {
		case <-m.stopCh:
			cancel()
		case <-ctx.Done():
		}
	}()
	defer cancel()

	impCh := make(chan TimyImpulse, 64)
	go td.ReadLoop(ctx, impCh)

	for imp := range impCh {
		ev := impulseToEvent(imp)
		atomic.StoreInt64(&m.state.LastImpulseAtMs, ev.TimestampMs)
		select {
		case eventBus <- ev:
		default:
			m.log.Warn("event bus full, dropping impulse")
		}
	}

	// ReadLoop closed impCh — device disconnected or ctx cancelled.
	if ctx.Err() != nil {
		// Cancelled via Stop(): signal clean shutdown.
		return nil
	}
	return fmt.Errorf("timy: device disconnected")
}

// Stop signals the monitor to stop after the current read completes.
func (m *Monitor) Stop() {
	m.once.Do(func() { close(m.stopCh) })
}
