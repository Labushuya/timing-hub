// Package usb implements the Alge Timy 3 USB protocol reader.
//
// The Timy 3 uses USB CDC (VID=0x0c4a, PID=0x0889). It sends ASCII lines:
//
//	"  NNNN  HH:MM:SS.mmm  Cx\r\n"
//
// where NNNN is a running sequence number, HH:MM:SS.mmm is time-of-day,
// and x is channel 1 or 2.
package usb

import (
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
// Groups: 1=seq, 2=HH, 3=MM, 4=SS, 5=mmm, 6=channel
var impulseLineRegexp = regexp.MustCompile(
	`^\s*(\d+)\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+C(\d)\s*$`,
)

// TimyEvent holds a parsed impulse from the Timy 3.
type TimyEvent struct {
	// Seq is the running sequence number from the device.
	Seq int
	// Channel is 1 or 2.
	Channel int
	// TimestampMs is the UTC epoch millisecond derived from the time-of-day
	// plus the session-start date, with midnight rollover correction.
	TimestampMs int64
	// Raw is the original ASCII line from the device (trimmed).
	Raw string
}

// Config holds device selection parameters.
type Config struct {
	VendorID   uint16
	ProductID  uint16
	AutoDetect bool
}

// Monitor opens the Timy 3 USB device and emits TimyEvents on eventBus.
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
// It blocks until Stop is called. It reconnects automatically on disconnect.
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
	ctx := gousb.NewContext()
	defer ctx.Close()

	dev, err := ctx.OpenDeviceWithVIDPID(
		gousb.ID(m.cfg.VendorID),
		gousb.ID(m.cfg.ProductID),
	)
	if err != nil {
		return fmt.Errorf("open device: %w", err)
	}
	if dev == nil {
		return fmt.Errorf("device not found (VID=%04x PID=%04x)", m.cfg.VendorID, m.cfg.ProductID)
	}
	defer dev.Close()

	if err := dev.SetAutoDetach(true); err != nil {
		m.log.WithError(err).Warn("SetAutoDetach failed (non-fatal)")
	}

	cfg, err := dev.Config(1)
	if err != nil {
		return fmt.Errorf("claim config: %w", err)
	}
	defer cfg.Close()

	iface, err := cfg.Interface(interfaceNumber, 0)
	if err != nil {
		return fmt.Errorf("claim interface: %w", err)
	}
	defer iface.Close()

	// Find the bulk-in endpoint
	var inEp *gousb.InEndpoint
	for _, ep := range iface.Setting.Endpoints {
		if ep.Direction == gousb.EndpointDirectionIn &&
			ep.TransferType == gousb.TransferTypeBulk {
			inEp, err = iface.InEndpoint(ep.Number)
			if err != nil {
				return fmt.Errorf("open in endpoint: %w", err)
			}
			break
		}
	}
	if inEp == nil {
		return fmt.Errorf("no bulk-in endpoint found")
	}

	// Find the bulk-out endpoint for init commands
	var outEp *gousb.OutEndpoint
	for _, ep := range iface.Setting.Endpoints {
		if ep.Direction == gousb.EndpointDirectionOut &&
			ep.TransferType == gousb.TransferTypeBulk {
			outEp, err = iface.OutEndpoint(ep.Number)
			if err != nil {
				m.log.WithError(err).Warn("open out endpoint failed (non-fatal)")
			}
			break
		}
	}

	if outEp != nil {
		for _, cmd := range []string{initCmdTimyInit, initCmdEMU0, initCmdCLR} {
			if _, err := outEp.Write([]byte(cmd)); err != nil {
				m.log.WithError(err).Warnf("send init cmd %q failed", cmd)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}

	m.log.WithFields(logrus.Fields{
		"vid": fmt.Sprintf("0x%04x", m.cfg.VendorID),
		"pid": fmt.Sprintf("0x%04x", m.cfg.ProductID),
	}).Info("Timy 3 device opened")
	atomic.StoreInt32(&m.state.DeviceConnectedFlag, 1)

	// Record the UTC date at session start for time-of-day -> epoch conversion.
	sessionDate := time.Now().UTC().Truncate(24 * time.Hour)
	var prevTOD time.Duration

	buf := make([]byte, bulkReadSize)
	var lineBuf strings.Builder

	for {
		select {
		case <-m.stopCh:
			return nil
		default:
		}

		n, err := inEp.Read(buf)
		if err != nil {
			return fmt.Errorf("bulk read: %w", err)
		}
		if n == 0 {
			continue
		}

		lineBuf.Write(buf[:n])
		raw := lineBuf.String()

		for {
			idx := strings.IndexByte(raw, '\n')
			if idx < 0 {
				break
			}
			line := strings.TrimRight(raw[:idx], "\r")
			raw = raw[idx+1:]

			ev, ok := parseLine(line, sessionDate, &prevTOD)
			if !ok {
				continue
			}
			ev.Raw = strings.TrimSpace(line)

			atomic.StoreInt64(&m.state.LastImpulseAtMs, ev.TimestampMs)
			select {
			case eventBus <- ev:
			default:
				m.log.Warn("event bus full, dropping impulse")
			}
		}
		lineBuf.Reset()
		lineBuf.WriteString(raw)
	}
}

// parseLine parses an impulse line and returns a TimyEvent.
// prevTOD is updated in-place for midnight rollover detection.
func parseLine(line string, sessionDate time.Time, prevTOD *time.Duration) (TimyEvent, bool) {
	m := impulseLineRegexp.FindStringSubmatch(line)
	if m == nil {
		return TimyEvent{}, false
	}

	seq, _ := strconv.Atoi(m[1])
	hh, _ := strconv.Atoi(m[2])
	mm, _ := strconv.Atoi(m[3])
	ss, _ := strconv.Atoi(m[4])
	ms, _ := strconv.Atoi(m[5])
	ch, _ := strconv.Atoi(m[6])

	tod := time.Duration(hh)*time.Hour +
		time.Duration(mm)*time.Minute +
		time.Duration(ss)*time.Second +
		time.Duration(ms)*time.Millisecond

	// Midnight rollover: if new TOD is less than previous, increment day.
	if tod < *prevTOD {
		sessionDate = sessionDate.Add(24 * time.Hour)
	}
	*prevTOD = tod

	ts := sessionDate.Add(tod)
	return TimyEvent{
		Seq:         seq,
		Channel:     ch,
		TimestampMs: ts.UnixMilli(),
	}, true
}

// Stop signals the monitor to stop after the current read completes.
func (m *Monitor) Stop() {
	m.once.Do(func() { close(m.stopCh) })
}
