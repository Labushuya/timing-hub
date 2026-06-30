// Package config loads and exposes the bridge TOML configuration.
package config

import (
	"fmt"
	"os"

	"github.com/BurntSushi/toml"
)

// Config is the top-level configuration structure for timy-bridge.
type Config struct {
	Server      ServerConfig      `toml:"server"`
	Device      DeviceConfig      `toml:"device"`
	Reliability ReliabilityConfig `toml:"reliability"`
	Tray        TrayConfig        `toml:"tray"`
	HTTP        HTTPConfig        `toml:"http"`
}

// ServerConfig holds WebSocket server settings.
type ServerConfig struct {
	// WSURL is the WebSocket URL of the timing-hub API, e.g. wss://api.timinghub.de/ws
	WSURL string `toml:"ws_url"`
	// BridgeToken authenticates this bridge instance with the server.
	BridgeToken string `toml:"bridge_token"`
	// PostenID is the UUID of the timing post this bridge represents.
	PostenID string `toml:"posten_id"`
}

// DeviceConfig holds device selection settings.
type DeviceConfig struct {
	// Type selects the driver: "alge_timy" | "tag_heuer_cp" |
	// "trentmann_rallystar" | "auto".  Defaults to "auto".
	Type string `toml:"type"`
	// SerialPort is the RS-232/USB-serial port for serial devices,
	// e.g. "COM3" or "/dev/ttyUSB0".
	SerialPort string `toml:"serial_port"`
	// BaudRate for serial devices (default 9600).
	BaudRate int `toml:"baud_rate"`
	// VendorID is the USB VID of the Alge Timy 3 (default 0x0c4a).
	VendorID uint16 `toml:"vendor_id"`
	// ProductID is the USB PID of the Alge Timy 3 (default 0x0889).
	ProductID uint16 `toml:"product_id"`
	// AutoDetect scans for the device automatically when true.
	// Deprecated: set Type = "auto" instead; this field is kept for
	// backwards compatibility with existing bridge.toml files.
	AutoDetect bool `toml:"auto_detect"`
}

// ReliabilityConfig holds buffering and reconnect settings.
type ReliabilityConfig struct {
	// ReconnectIntervalS is the base delay in seconds between reconnect attempts.
	ReconnectIntervalS int `toml:"reconnect_interval_s"`
	// AckTimeoutMs is how long to wait for a server ACK before resending.
	AckTimeoutMs int `toml:"ack_timeout_ms"`
	// LocalBufferPath is the SQLite WAL file path for offline buffering.
	LocalBufferPath string `toml:"local_buffer_path"`
	// MaxBufferEntries caps the number of buffered impulses kept on disk.
	MaxBufferEntries int `toml:"max_buffer_entries"`
}

// TrayConfig holds system tray settings.
type TrayConfig struct {
	// ShowIcon controls whether the system tray icon is displayed.
	ShowIcon bool `toml:"show_icon"`
}

// HTTPConfig holds local HTTP server settings.
type HTTPConfig struct {
	// Port is the localhost port for the status/health endpoint.
	Port int `toml:"port"`
}

// defaults fills in zero values with sensible defaults.
func defaults(cfg *Config) {
	if cfg.Device.Type == "" {
		cfg.Device.Type = "auto"
	}
	if cfg.Device.BaudRate == 0 {
		cfg.Device.BaudRate = 9600
	}
	if cfg.Device.VendorID == 0 {
		cfg.Device.VendorID = 0x0c4a
	}
	if cfg.Device.ProductID == 0 {
		cfg.Device.ProductID = 0x0889
	}
	if cfg.Reliability.ReconnectIntervalS == 0 {
		cfg.Reliability.ReconnectIntervalS = 5
	}
	if cfg.Reliability.AckTimeoutMs == 0 {
		cfg.Reliability.AckTimeoutMs = 3000
	}
	if cfg.Reliability.LocalBufferPath == "" {
		cfg.Reliability.LocalBufferPath = "./bridge-buffer.db"
	}
	if cfg.Reliability.MaxBufferEntries == 0 {
		cfg.Reliability.MaxBufferEntries = 10000
	}
	if cfg.HTTP.Port == 0 {
		cfg.HTTP.Port = 7272
	}
}

// DefaultConfig returns a Config populated entirely with default values.
// Required fields (server.ws_url, server.bridge_token, server.posten_id)
// are left empty; callers must fill them before use.
// Device.Type defaults to "auto"; Device.BaudRate defaults to 9600.
func DefaultConfig() *Config {
	cfg := &Config{}
	defaults(cfg)
	return cfg
}

// LoadConfig reads and parses the TOML config file at path.
// It applies defaults for zero-value fields.
func LoadConfig(path string) (*Config, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open config %q: %w", path, err)
	}
	defer f.Close()

	var cfg Config
	if _, err := toml.NewDecoder(f).Decode(&cfg); err != nil {
		return nil, fmt.Errorf("parse config %q: %w", path, err)
	}

	defaults(&cfg)

	if cfg.Server.WSURL == "" {
		return nil, fmt.Errorf("server.ws_url is required")
	}
	if cfg.Server.BridgeToken == "" {
		return nil, fmt.Errorf("server.bridge_token is required")
	}
	if cfg.Server.PostenID == "" {
		return nil, fmt.Errorf("server.posten_id is required")
	}

	return &cfg, nil
}
