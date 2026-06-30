// Package tray implements the system tray icon and menu for timy-bridge.
//
// It uses github.com/getlantern/systray and updates the menu every 2 seconds
// to reflect the current connection state read from the shared bridgehttp.State.
package tray

import (
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/getlantern/systray"
	"github.com/sirupsen/logrus"
	"github.com/timing-hub/timy-bridge/config"
	bridgehttp "github.com/timing-hub/timy-bridge/http"
)

const statusInterval = 2 * time.Second

// TrayApp manages the system tray lifecycle.
type TrayApp struct {
	cfg     *config.Config
	state   *bridgehttp.State
	log     *logrus.Logger
	version string
	stopCh  chan struct{}
	// reconnectFn is called when the user clicks a future reconnect menu item.
	reconnectFn func()
}

// New creates a TrayApp. Call Run() to start the systray loop (blocks).
func New(cfg *config.Config, state *bridgehttp.State, log *logrus.Logger, version string) *TrayApp {
	return &TrayApp{
		cfg:     cfg,
		state:   state,
		log:     log,
		version: version,
		stopCh:  make(chan struct{}),
	}
}

// SetReconnectFunc registers a callback for the reconnect action.
func (t *TrayApp) SetReconnectFunc(fn func()) {
	t.reconnectFn = fn
}

// Run starts the systray loop. It blocks until the user clicks "Beenden" or
// Stop is called.
func (t *TrayApp) Run(onQuit func()) {
	systray.Run(t.onReady, func() {
		if onQuit != nil {
			onQuit()
		}
	})
}

// Stop signals the tray to quit.
func (t *TrayApp) Stop() {
	select {
	case <-t.stopCh:
	default:
		close(t.stopCh)
	}
	systray.Quit()
}

// -------------------------------------------------------------------
// internal
// -------------------------------------------------------------------

func (t *TrayApp) onReady() {
	// Initial icon (disconnected = red).
	systray.SetIcon(iconPNG(false, false))
	systray.SetTitle("")
	systray.SetTooltip("Timing Hub Bridge")

	// Title item (disabled).
	mTitle := systray.AddMenuItem("Timing Hub Bridge v"+t.version, "")
	mTitle.Disable()

	systray.AddSeparator()

	mStatus := systray.AddMenuItem("Status: Getrennt ✗", "WebSocket-Verbindung")
	mStatus.Disable()

	mDevice := systray.AddMenuItem("Gerät: Kein Timy ✗", "Alge Timy 3 USB")
	mDevice.Disable()

	systray.AddSeparator()

	mConfig := systray.AddMenuItem("Konfiguration öffnen", "bridge.toml in Standard-Editor öffnen")
	mBrowser := systray.AddMenuItem("Status im Browser", "http://localhost:"+strconv.Itoa(t.cfg.HTTP.Port)+" öffnen")

	systray.AddSeparator()

	mQuit := systray.AddMenuItem("Beenden", "Timy Bridge beenden")

	// Status updater goroutine.
	go t.updateLoop(mStatus, mDevice)

	// Event loop.
	go func() {
		for {
			select {
			case <-t.stopCh:
				systray.Quit()
				return
			case <-mConfig.ClickedCh:
				t.openConfig()
			case <-mBrowser.ClickedCh:
				t.openBrowser("http://localhost:" + strconv.Itoa(t.cfg.HTTP.Port))
			case <-mQuit.ClickedCh:
				close(t.stopCh)
				systray.Quit()
				return
			}
		}
	}()
}

func (t *TrayApp) updateLoop(mStatus, mDevice *systray.MenuItem) {
	ticker := time.NewTicker(statusInterval)
	defer ticker.Stop()

	for {
		select {
		case <-t.stopCh:
			return
		case <-ticker.C:
		}

		wsConn := atomic.LoadInt32(&t.state.WSConnectedFlag) == 1
		devConn := atomic.LoadInt32(&t.state.DeviceConnectedFlag) == 1

		if wsConn {
			mStatus.SetTitle("Status: Verbunden ✓")
		} else {
			mStatus.SetTitle("Status: Getrennt ✗")
		}

		if devConn {
			mDevice.SetTitle("Gerät: Timy erkannt ✓")
		} else {
			mDevice.SetTitle("Gerät: Kein Timy ✗")
		}

		systray.SetIcon(iconPNG(wsConn, devConn))

		switch {
		case wsConn && devConn:
			systray.SetTooltip("Timing Hub Bridge — verbunden")
		case wsConn:
			systray.SetTooltip("Timing Hub Bridge — kein Gerät")
		case devConn:
			systray.SetTooltip("Timing Hub Bridge — offline puffert")
		default:
			systray.SetTooltip("Timing Hub Bridge — getrennt")
		}
	}
}

func (t *TrayApp) openConfig() {
	// Find the config file; fall back to "bridge.toml" in cwd.
	path := "bridge.toml"
	if _, err := os.Stat(path); err != nil {
		t.log.WithError(err).Warn("tray: config file not found")
	}
	openFileInEditor(path, t.log)
}

func (t *TrayApp) openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		t.log.WithError(err).Warn("tray: open browser failed")
	}
}

// openFileInEditor opens path in the OS default editor.
func openFileInEditor(path string, log *logrus.Logger) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", "", path)
	case "darwin":
		cmd = exec.Command("open", path)
	default:
		editor := os.Getenv("EDITOR")
		if editor == "" {
			editor = "xdg-open"
		}
		cmd = exec.Command(editor, path)
	}
	if err := cmd.Start(); err != nil {
		log.WithError(err).Warn("tray: open editor failed")
	}
}

// -------------------------------------------------------------------
// Icon generation
//
// We generate a minimal 16x16 PNG entirely in Go without any external
// image files. The color encodes connection state:
//   - green  (0x22,0xc5,0x5e): WS connected + device connected
//   - yellow (0xf5,0xa6,0x23): WS connected, no device
//   - orange (0xf5,0x73,0x1e): device connected, no WS (buffering)
//   - red    (0xe5,0x43,0x2d): both disconnected
//
// -------------------------------------------------------------------

func iconPNG(wsConnected, deviceConnected bool) []byte {
	var r, g, b uint8
	switch {
	case wsConnected && deviceConnected:
		r, g, b = 0x22, 0xc5, 0x5e // green
	case wsConnected:
		r, g, b = 0xf5, 0xa6, 0x23 // yellow
	case deviceConnected:
		r, g, b = 0xf5, 0x73, 0x1e // orange
	default:
		r, g, b = 0xe5, 0x43, 0x2d // red
	}
	return generatePNG(16, 16, r, g, b)
}

// generatePNG creates a minimal, valid PNG for a solid-color w×h image.
// It does not import image/png to keep the dependency footprint small;
// the PNG byte layout is hand-assembled per the PNG spec.
func generatePNG(w, h int, r, g, b uint8) []byte {
	var buf bytes.Buffer

	// PNG signature
	buf.Write([]byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a})

	writeChunk := func(typ string, data []byte) {
		length := make([]byte, 4)
		binary.BigEndian.PutUint32(length, uint32(len(data)))
		buf.Write(length)
		buf.WriteString(typ)
		buf.Write(data)
		crc := crc32.NewIEEE()
		crc.Write([]byte(typ))
		crc.Write(data)
		cs := make([]byte, 4)
		binary.BigEndian.PutUint32(cs, crc.Sum32())
		buf.Write(cs)
	}

	// IHDR
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:4], uint32(w))
	binary.BigEndian.PutUint32(ihdr[4:8], uint32(h))
	ihdr[8] = 8    // bit depth
	ihdr[9] = 2    // color type: RGB truecolor
	ihdr[10] = 0   // compression method
	ihdr[11] = 0   // filter method
	ihdr[12] = 0   // interlace: none
	writeChunk("IHDR", ihdr)

	// IDAT: raw scanlines, one filter byte (0x00 = None) + w*3 bytes per row.
	rawRow := make([]byte, 1+w*3)
	rawRow[0] = 0x00 // filter type None
	for x := 0; x < w; x++ {
		rawRow[1+x*3+0] = r
		rawRow[1+x*3+1] = g
		rawRow[1+x*3+2] = b
	}
	var scanlines bytes.Buffer
	for y := 0; y < h; y++ {
		scanlines.Write(rawRow)
	}

	// Compress the scanlines using zlib (deflate).
	compressed := zlibCompress(scanlines.Bytes())
	writeChunk("IDAT", compressed)

	// IEND
	writeChunk("IEND", []byte{})

	return buf.Bytes()
}

// zlibCompress compresses data using a minimal zlib wrapper (no external deps).
// For a 16x16 icon this keeps binary size tiny.
func zlibCompress(data []byte) []byte {
	// Use the standard library compress/zlib package would require an import;
	// instead we write a store-only (no compression) zlib stream for simplicity.
	// Zlib header: CMF=0x78 (deflate, window 32k), FLG computed for FCHECK.
	cmf := byte(0x78)
	// FLG must satisfy (CMF*256+FLG) % 31 == 0 and FDICT bit clear.
	flg := byte(0x9c) // 0x789c is a common store zlib header; (0x78*256+0x9c)%31==0

	var out bytes.Buffer
	out.WriteByte(cmf)
	out.WriteByte(flg)

	// Write deflate blocks: BFINAL=1, BTYPE=00 (no compression).
	// Each no-compression block can hold up to 65535 bytes.
	remaining := data
	for len(remaining) > 0 {
		blockLen := len(remaining)
		if blockLen > 65535 {
			blockLen = 65535
		}
		chunk := remaining[:blockLen]
		remaining = remaining[blockLen:]

		bfinal := byte(0x00)
		if len(remaining) == 0 {
			bfinal = 0x01 // final block
		}
		// BTYPE=00 stored: bfinal | (BTYPE=00 << 1)
		out.WriteByte(bfinal)
		// LEN and NLEN (little-endian)
		l := uint16(blockLen)
		out.WriteByte(byte(l))
		out.WriteByte(byte(l >> 8))
		out.WriteByte(byte(^l))
		out.WriteByte(byte(^l >> 8))
		out.Write(chunk)
	}

	// Adler-32 checksum of the uncompressed data (big-endian).
	s1, s2 := uint32(1), uint32(0)
	for _, b := range data {
		s1 = (s1 + uint32(b)) % 65521
		s2 = (s2 + s1) % 65521
	}
	adler := (s2 << 16) | s1
	cs := make([]byte, 4)
	binary.BigEndian.PutUint32(cs, adler)
	out.Write(cs)

	return out.Bytes()
}
