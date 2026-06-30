package main

import (
	"context"
	"flag"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/sirupsen/logrus"
	"github.com/timing-hub/timy-bridge/config"
	"github.com/timing-hub/timy-bridge/device"
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
		"config":      *configPath,
		"version":     Version,
		"dev":         *dev,
		"device_type": cfg.Device.Type,
	}).Info("universal-timing-bridge starting")

	// Shared state.
	s := &state{}
	s.httpState.Version = Version

	// Build the device driver from config.
	drv, err := device.NewDriver(
		device.DeviceType(cfg.Device.Type),
		cfg.Device.VendorID,
		cfg.Device.ProductID,
		device.SerialConfig{
			Port:     cfg.Device.SerialPort,
			BaudRate: cfg.Device.BaudRate,
		},
	)
	if err != nil {
		log.WithError(err).Fatal("failed to create device driver")
	}

	log.WithField("driver", drv.Name()).Info("device driver selected")

	// impulse bus: device driver writes device.Impulse; the adapter goroutine
	// converts to usb.TimyEvent for the WS client.
	impulseBus := make(chan device.Impulse, 512)

	// eventBus carries the WS-client-facing events (usb.TimyEvent).
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
		ctx, cancel := context.WithCancel(context.Background())
		startComponents(ctx, log, drv, wsClient, httpServer, impulseBus, eventBus, &s.httpState)

		go func() {
			<-quit
			log.Info("received shutdown signal")
			cancel()
			shutdownComponents(log, wsClient, httpServer, trayApp)
		}()

		trayApp.Run(func() {
			cancel()
			shutdownComponents(log, wsClient, httpServer, nil)
		})
	} else {
		ctx, cancel := context.WithCancel(context.Background())
		startComponents(ctx, log, drv, wsClient, httpServer, impulseBus, eventBus, &s.httpState)
		<-quit
		cancel()
		shutdownComponents(log, wsClient, httpServer, nil)
	}
}

// startComponents launches all background goroutines.
func startComponents(
	ctx context.Context,
	log *logrus.Logger,
	drv device.Driver,
	wsClient *ws.BridgeClient,
	httpServer *bridgehttp.Server,
	impulseBus chan device.Impulse,
	eventBus chan usb.TimyEvent,
	httpState *bridgehttp.State,
) {
	// 1. Device driver loop: opens device, reads impulses, reconnects on disconnect.
	go func() {
		if err := runDeviceLoop(ctx, log, drv, impulseBus, httpState); err != nil {
			log.WithError(err).Error("device driver stopped with error")
		}
	}()

	// 2. Adapter goroutine: converts device.Impulse → usb.TimyEvent.
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case imp, ok := <-impulseBus:
				if !ok {
					return
				}
				eventBus <- impulseToTimyEvent(imp)
			}
		}
	}()

	// 3. WS client: buffers to SQLite, forwards over WS, reconnects on disconnect.
	go func() {
		if err := wsClient.Run(eventBus); err != nil {
			log.WithError(err).Error("ws client stopped with error")
		}
	}()

	// 4. HTTP status server on localhost.
	go func() {
		if err := httpServer.Start(); err != nil {
			log.WithError(err).Error("http server stopped with error")
		}
	}()
}

// runDeviceLoop opens the driver and reads impulses, reconnecting on
// disconnect until ctx is cancelled.
func runDeviceLoop(
	ctx context.Context,
	log *logrus.Logger,
	drv device.Driver,
	impulseBus chan<- device.Impulse,
	httpState *bridgehttp.State,
) error {
	const reconnectDelay = 3 * time.Second

	for {
		select {
		case <-ctx.Done():
			return nil
		default:
		}

		if err := drv.Open(); err != nil {
			log.WithFields(logrus.Fields{
				"driver": drv.Name(),
				"error":  err,
			}).Warn("device open failed, retrying")
			atomic.StoreInt32(&httpState.DeviceConnectedFlag, 0)
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(reconnectDelay):
			}
			continue
		}

		log.WithField("driver", drv.Name()).Info("device opened")
		atomic.StoreInt32(&httpState.DeviceConnectedFlag, 1)

		err := drv.ReadLoop(ctx, impulseBus)
		_ = drv.Close()
		atomic.StoreInt32(&httpState.DeviceConnectedFlag, 0)

		if ctx.Err() != nil {
			return nil
		}
		log.WithFields(logrus.Fields{
			"driver": drv.Name(),
			"error":  err,
		}).Warn("device session ended, reconnecting")

		select {
		case <-ctx.Done():
			return nil
		case <-time.After(reconnectDelay):
		}
	}
}

// impulseToTimyEvent converts a device.Impulse to the usb.TimyEvent that the
// WS client and HTTP status endpoint consume.
func impulseToTimyEvent(imp device.Impulse) usb.TimyEvent {
	return usb.TimyEvent{
		Seq:         imp.RunningNum,
		Channel:     imp.Channel,
		TimestampMs: imp.EpochMs,
		Raw:         imp.RawLine,
	}
}

// shutdownComponents stops all components in order and waits briefly for a
// clean exit.
func shutdownComponents(
	log *logrus.Logger,
	wsClient *ws.BridgeClient,
	httpServer *bridgehttp.Server,
	trayApp *tray.TrayApp,
) {
	log.Info("shutting down")

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
