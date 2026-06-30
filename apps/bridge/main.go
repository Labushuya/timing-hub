package main

import (
	"flag"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/sirupsen/logrus"
	"github.com/timing-hub/timy-bridge/config"
	bridgehttp "github.com/timing-hub/timy-bridge/http"
	"github.com/timing-hub/timy-bridge/tray"
	"github.com/timing-hub/timy-bridge/usb"
	"github.com/timing-hub/timy-bridge/ws"
)

// Version is set at build time via -ldflags "-X main.Version=<tag>".
var Version = "dev"

// state holds shared runtime state accessible to all goroutines.
// Atomic fields are used for lock-free reads from the HTTP handler;
// mu protects the non-atomic fields below.
type state struct {
	mu sync.Mutex

	// wsConnected and deviceConnected are also mirrored into bridgehttp.State
	// via atomic ops; these copies are used in the tray / shutdown logic.
	wsConnected     bool
	deviceConnected bool

	// bridgehttp.State uses atomic int32/int64 for the HTTP handler.
	httpState bridgehttp.State
}

func main() {
	// Default config path: bridge.toml next to the executable.
	execPath, err := os.Executable()
	if err != nil {
		execPath = "."
	}
	defaultConfig := filepath.Join(filepath.Dir(execPath), "bridge.toml")

	configPath := flag.String("config", defaultConfig, "path to TOML config file")
	dev := flag.Bool("dev", false, "enable development mode (text logging, debug level)")
	flag.Parse()

	// Logger setup.
	log := logrus.New()
	if *dev {
		log.SetFormatter(&logrus.TextFormatter{FullTimestamp: true})
		log.SetLevel(logrus.DebugLevel)
	} else {
		log.SetFormatter(&logrus.JSONFormatter{})
		log.SetLevel(logrus.InfoLevel)
	}

	// Config.
	cfg, err := config.LoadConfig(*configPath)
	if err != nil {
		log.WithError(err).Fatal("failed to load config")
	}

	log.WithFields(logrus.Fields{
		"config":  *configPath,
		"version": Version,
		"dev":     *dev,
	}).Info("timy-bridge starting")

	// Shared state.
	s := &state{}
	s.httpState.Version = Version

	// Buffered event bus: USB monitor writes, WS client reads.
	eventBus := make(chan usb.TimyEvent, 512)

	// WS client.
	wsClient := ws.NewClient(ws.Config{
		WSURL:              cfg.Server.WSURL,
		BridgeToken:        cfg.Server.BridgeToken,
		PostenID:           cfg.Server.PostenID,
		AckTimeoutMs:       cfg.Reliability.AckTimeoutMs,
		ReconnectIntervalS: cfg.Reliability.ReconnectIntervalS,
		LocalBufferPath:    cfg.Reliability.LocalBufferPath,
		MaxBufferEntries:   cfg.Reliability.MaxBufferEntries,
	}, log, &s.httpState)

	// USB monitor.
	usbMonitor := usb.NewMonitor(usb.Config{
		VendorID:   cfg.Device.VendorID,
		ProductID:  cfg.Device.ProductID,
		AutoDetect: cfg.Device.AutoDetect,
	}, log, &s.httpState)

	// HTTP status server.
	httpServer := bridgehttp.NewServer(cfg.HTTP.Port, &s.httpState, log)
	// Wire up manual reconnect via POST /reconnect.
	httpServer.SetReconnectFunc(wsClient.TriggerReconnect)

	// OS signal channel for graceful shutdown.
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	if cfg.Tray.ShowIcon {
		trayApp := tray.New(cfg, &s.httpState, log, Version)
		trayApp.SetReconnectFunc(wsClient.TriggerReconnect)

		// Start bridge components before entering the systray event loop.
		startComponents(log, usbMonitor, wsClient, httpServer, eventBus)

		// Watch for OS signal in a goroutine; tray Quit button is handled
		// internally by TrayApp itself.
		go func() {
			<-quit
			log.Info("received shutdown signal")
			shutdown(log, usbMonitor, wsClient, httpServer, trayApp)
		}()

		// Run blocks until the user quits via tray or Stop() is called.
		trayApp.Run(func() {
			shutdown(log, usbMonitor, wsClient, httpServer, nil)
		})
	} else {
		startComponents(log, usbMonitor, wsClient, httpServer, eventBus)
		<-quit
		shutdown(log, usbMonitor, wsClient, httpServer, nil)
	}
}

// startComponents launches the three background goroutines.
func startComponents(
	log *logrus.Logger,
	usbMonitor *usb.Monitor,
	wsClient *ws.BridgeClient,
	httpServer *bridgehttp.Server,
	eventBus chan usb.TimyEvent,
) {
	// 1. USB monitor loop: opens device, reads impulses, reconnects on disconnect.
	go func() {
		if err := usbMonitor.Run(eventBus); err != nil {
			log.WithError(err).Error("usb monitor stopped with error")
		}
	}()

	// 2. WS client: buffers to SQLite, forwards over WS, reconnects on disconnect.
	go func() {
		if err := wsClient.Run(eventBus); err != nil {
			log.WithError(err).Error("ws client stopped with error")
		}
	}()

	// 3. HTTP status server on localhost.
	go func() {
		if err := httpServer.Start(); err != nil {
			log.WithError(err).Error("http server stopped with error")
		}
	}()
}

// shutdown stops all components in order and waits briefly for clean exit.
func shutdown(
	log *logrus.Logger,
	usbMonitor *usb.Monitor,
	wsClient *ws.BridgeClient,
	httpServer *bridgehttp.Server,
	trayApp *tray.TrayApp,
) {
	log.Info("shutting down")

	// Stop USB read loop first so no new impulses are queued.
	usbMonitor.Stop()

	// Drain and close WS client (flushes pending ACKs, closes SQLite buffer).
	wsClient.Stop()

	// Stop HTTP server.
	httpServer.Stop()

	// Hide tray icon if present.
	if trayApp != nil {
		trayApp.Stop()
	}

	// Brief grace period for goroutines to exit cleanly.
	time.Sleep(200 * time.Millisecond)
	log.Info("shutdown complete")
}
