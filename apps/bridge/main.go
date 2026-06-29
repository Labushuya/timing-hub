package main

import (
	"flag"
	"os"
	"os/signal"
	"syscall"

	"github.com/getlantern/systray"
	"github.com/sirupsen/logrus"
	"github.com/timing-hub/timy-bridge/config"
	bridgehttp "github.com/timing-hub/timy-bridge/http"
	"github.com/timing-hub/timy-bridge/usb"
	"github.com/timing-hub/timy-bridge/ws"
)

const version = "0.1.0"

func main() {
	configPath := flag.String("config", "bridge.toml", "path to config file")
	dev := flag.Bool("dev", false, "enable development mode (text logging)")
	flag.Parse()

	log := logrus.New()
	if *dev {
		log.SetFormatter(&logrus.TextFormatter{FullTimestamp: true})
		log.SetLevel(logrus.DebugLevel)
	} else {
		log.SetFormatter(&logrus.JSONFormatter{})
		log.SetLevel(logrus.InfoLevel)
	}

	cfg, err := config.LoadConfig(*configPath)
	if err != nil {
		log.WithError(err).Fatal("failed to load config")
	}

	log.WithFields(logrus.Fields{
		"config":  *configPath,
		"version": version,
	}).Info("timy-bridge starting")

	// Buffered event bus: USB monitor writes, WS client reads
	eventBus := make(chan usb.TimyEvent, 512)

	// Shared state accessible by HTTP status endpoint
	state := &bridgehttp.State{
		Version: version,
	}

	// WS client
	wsClient := ws.NewClient(ws.Config{
		WSURL:              cfg.Server.WSURL,
		BridgeToken:        cfg.Server.BridgeToken,
		PostenID:           cfg.Server.PostenID,
		AckTimeoutMs:       cfg.Reliability.AckTimeoutMs,
		ReconnectIntervalS: cfg.Reliability.ReconnectIntervalS,
		LocalBufferPath:    cfg.Reliability.LocalBufferPath,
		MaxBufferEntries:   cfg.Reliability.MaxBufferEntries,
	}, log, state)

	// USB monitor
	usbMonitor := usb.NewMonitor(usb.Config{
		VendorID:   cfg.Device.VendorID,
		ProductID:  cfg.Device.ProductID,
		AutoDetect: cfg.Device.AutoDetect,
	}, log, state)

	// HTTP server
	httpServer := bridgehttp.NewServer(cfg.HTTP.Port, state, log)

	// Shutdown signal
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	if cfg.Tray.ShowIcon {
		// systray.Run blocks; run everything else via OnReady callback
		systray.Run(func() {
			onReady(cfg, log, usbMonitor, wsClient, httpServer, eventBus, quit)
		}, func() {
			log.Info("tray exited")
		})
	} else {
		// No tray: run components directly
		startComponents(log, usbMonitor, wsClient, httpServer, eventBus)
		<-quit
		shutdown(log, usbMonitor, wsClient, httpServer)
	}
}

func onReady(
	cfg *config.Config,
	log *logrus.Logger,
	usbMonitor *usb.Monitor,
	wsClient *ws.Client,
	httpServer *bridgehttp.Server,
	eventBus chan usb.TimyEvent,
	quit chan os.Signal,
) {
	systray.SetTitle("Timy Bridge")
	systray.SetTooltip("Alge Timy 3 Bridge")
	setTrayIcon(systray, false, false)

	mStatus := systray.AddMenuItem("Not connected", "Connection status")
	mStatus.Disable()
	systray.AddSeparator()
	mQuit := systray.AddMenuItem("Quit", "Quit Timy Bridge")

	startComponents(log, usbMonitor, wsClient, httpServer, eventBus)

	go func() {
		select {
		case <-mQuit.ClickedCh:
			log.Info("quit via tray")
		case <-quit:
			log.Info("quit via signal")
		}
		shutdown(log, usbMonitor, wsClient, httpServer)
		systray.Quit()
	}()
}

func startComponents(
	log *logrus.Logger,
	usbMonitor *usb.Monitor,
	wsClient *ws.Client,
	httpServer *bridgehttp.Server,
	eventBus chan usb.TimyEvent,
) {
	go func() {
		if err := usbMonitor.Run(eventBus); err != nil {
			log.WithError(err).Error("usb monitor stopped with error")
		}
	}()

	go func() {
		if err := wsClient.Run(eventBus); err != nil {
			log.WithError(err).Error("ws client stopped with error")
		}
	}()

	go func() {
		if err := httpServer.Start(); err != nil {
			log.WithError(err).Error("http server stopped with error")
		}
	}()
}

func shutdown(
	log *logrus.Logger,
	usbMonitor *usb.Monitor,
	wsClient *ws.Client,
	httpServer *bridgehttp.Server,
) {
	log.Info("shutting down")
	usbMonitor.Stop()
	wsClient.Stop()
	httpServer.Stop()
	log.Info("shutdown complete")
}

// setTrayIcon updates the tray icon color based on connection states.
// This is a stub; real icon data should be embedded via go:embed.
func setTrayIcon(_ interface{}, wsConnected, deviceConnected bool) {
	switch {
	case wsConnected && deviceConnected:
		// green: fully operational
		systray.SetTooltip("Timy Bridge — connected")
	case wsConnected:
		// yellow: server connected, no device
		systray.SetTooltip("Timy Bridge — no device")
	case deviceConnected:
		// orange: device connected, no server
		systray.SetTooltip("Timy Bridge — offline buffering")
	default:
		// red: disconnected
		systray.SetTooltip("Timy Bridge — disconnected")
	}
}
