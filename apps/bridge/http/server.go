// Package http provides a minimal local HTTP status and health server
// for timy-bridge, listening on localhost only.
package http

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/sirupsen/logrus"
	"go.bug.st/serial"
)

// State holds shared runtime state written by other components and read
// by the HTTP handlers. All fields use atomic access.
type State struct {
	// WSConnectedFlag is 1 when the WS connection is up, 0 otherwise.
	WSConnectedFlag int32
	// DeviceConnectedFlag is 1 when the USB device is open, 0 otherwise.
	DeviceConnectedFlag int32
	// BufferCount is the number of locally buffered (undelivered) impulses.
	BufferCount int32
	// LastImpulseAtMs is the Unix millisecond timestamp of the last impulse,
	// or 0 if none received this session.
	LastImpulseAtMs int64
	// BridgeSeq is the most recently issued bridge_seq counter value.
	BridgeSeq int64
	// Version is the build version string, set at startup.
	Version string

	// CurrentDeviceType is the device type string currently active.
	// Protected by DeviceMu.
	CurrentDeviceType string
	// DeviceMu guards CurrentDeviceType.
	DeviceMu sync.RWMutex
}

// statusResponse is the JSON body returned by GET /status.
type statusResponse struct {
	Connected       bool   `json:"connected"`
	DeviceConnected bool   `json:"device_connected"`
	BufferCount     int    `json:"buffer_count"`
	LastImpulseAt   *int64 `json:"last_impulse_at"`
	BridgeSeq       int64  `json:"bridge_seq"`
	Version         string `json:"version"`
	DeviceType      string `json:"device_type,omitempty"`
}

// DeviceInfo describes a single supported device type.
type DeviceInfo struct {
	Type        string `json:"type"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

// devicesResponse is the JSON body returned by GET /devices.
type devicesResponse struct {
	CurrentType    string       `json:"current_type"`
	AvailableTypes []DeviceInfo `json:"available_types"`
	SerialPorts    []string     `json:"serial_ports"`
}

// deviceChangeRequest is the JSON body expected by POST /device.
type deviceChangeRequest struct {
	Type       string `json:"type"`
	SerialPort string `json:"serial_port"`
	BaudRate   int    `json:"baud_rate"`
}

// deviceChangeResponse is the JSON body returned by POST /device on success.
type deviceChangeResponse struct {
	OK          bool   `json:"ok"`
	CurrentType string `json:"current_type"`
}

// supportedDevices lists all device types in display order.
var supportedDevices = []DeviceInfo{
	{
		Type:        "auto",
		Label:       "Automatisch erkennen",
		Description: "USB zuerst (Timy), dann seriell",
	},
	{
		Type:        "alge_timy",
		Label:       "ALGE Timy 3",
		Description: "USB-Verbindung (VID 0x0c4a)",
	},
	{
		Type:        "tag_heuer_cp",
		Label:       "TAG Heuer CP-Serie",
		Description: "RS-232 / USB-Serial (CP 450–540)",
	},
	{
		Type:        "trentmann_rallystar",
		Label:       "Trentmann RallyStar",
		Description: "RS-232 / USB-Serial",
	},
}

// validDeviceTypes is the set of accepted device type strings.
var validDeviceTypes = func() map[string]bool {
	m := make(map[string]bool, len(supportedDevices))
	for _, d := range supportedDevices {
		m[d.Type] = true
	}
	return m
}()

// reconnectFunc is called by POST /reconnect to trigger an immediate reconnect.
type reconnectFunc func()

// DeviceChangeCallback is called by POST /device when the user selects a new
// device type. The bridge should tear down the current driver and start a new
// one with the supplied parameters.
type DeviceChangeCallback func(deviceType string, serialPort string, baudRate int)

// Server is the local HTTP server.
type Server struct {
	port         int
	state        *State
	log          *logrus.Logger
	server       *http.Server
	reconnect    reconnectFunc
	deviceChange DeviceChangeCallback
}

// NewServer creates a Server but does not start it.
// reconnect may be nil if reconnect triggering is not supported.
func NewServer(port int, state *State, log *logrus.Logger) *Server {
	return &Server{
		port:  port,
		state: state,
		log:   log,
	}
}

// SetReconnectFunc registers a callback invoked by POST /reconnect.
func (s *Server) SetReconnectFunc(fn reconnectFunc) {
	s.reconnect = fn
}

// SetDeviceChangeFunc registers a callback invoked by POST /device.
func (s *Server) SetDeviceChangeFunc(fn DeviceChangeCallback) {
	s.deviceChange = fn
}

// Start binds to localhost:<port> and serves requests.
// It blocks until the server is stopped or an error occurs.
func (s *Server) Start() error {
	mux := http.NewServeMux()
	mux.HandleFunc("/status", s.handleStatus)
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/reconnect", s.handleReconnect)
	mux.HandleFunc("/devices", s.handleDevices)
	mux.HandleFunc("/device", s.handleDevice)

	addr := fmt.Sprintf("127.0.0.1:%d", s.port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listen %s: %w", addr, err)
	}

	s.server = &http.Server{
		Handler:      corsMiddleware(mux),
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 5 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	s.log.WithField("addr", addr).Info("http status server listening")
	if err := s.server.Serve(ln); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

// Stop gracefully shuts down the HTTP server.
func (s *Server) Stop() {
	if s.server == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = s.server.Shutdown(ctx)
}

// -------------------------------------------------------------------
// Handlers
// -------------------------------------------------------------------

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	wsConn := atomic.LoadInt32(&s.state.WSConnectedFlag) == 1
	devConn := atomic.LoadInt32(&s.state.DeviceConnectedFlag) == 1
	bufCount := int(atomic.LoadInt32(&s.state.BufferCount))
	lastMs := atomic.LoadInt64(&s.state.LastImpulseAtMs)
	bridgeSeq := atomic.LoadInt64(&s.state.BridgeSeq)

	s.state.DeviceMu.RLock()
	currentType := s.state.CurrentDeviceType
	s.state.DeviceMu.RUnlock()

	resp := statusResponse{
		Connected:       wsConn,
		DeviceConnected: devConn,
		BufferCount:     bufCount,
		BridgeSeq:       bridgeSeq,
		Version:         s.state.Version,
		DeviceType:      currentType,
	}
	if lastMs != 0 {
		resp.LastImpulseAt = &lastMs
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("OK"))
}

func (s *Server) handleReconnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.reconnect != nil {
		s.reconnect()
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"status":"reconnecting"}`))
}

func (s *Server) handleDevices(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	s.state.DeviceMu.RLock()
	currentType := s.state.CurrentDeviceType
	s.state.DeviceMu.RUnlock()

	if currentType == "" {
		currentType = "auto"
	}

	ports, err := serial.GetPortsList()
	if err != nil {
		s.log.WithError(err).Warn("failed to list serial ports")
		ports = []string{}
	}
	if ports == nil {
		ports = []string{}
	}

	resp := devicesResponse{
		CurrentType:    currentType,
		AvailableTypes: supportedDevices,
		SerialPorts:    ports,
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp)
}

func (s *Server) handleDevice(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req deviceChangeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}

	req.Type = strings.TrimSpace(strings.ToLower(req.Type))
	if !validDeviceTypes[req.Type] {
		http.Error(w, fmt.Sprintf("unknown device type %q", req.Type), http.StatusBadRequest)
		return
	}

	// Update shared state so /status and /devices reflect the new type immediately.
	s.state.DeviceMu.Lock()
	s.state.CurrentDeviceType = req.Type
	s.state.DeviceMu.Unlock()

	if s.deviceChange != nil {
		go s.deviceChange(req.Type, req.SerialPort, req.BaudRate)
	}

	s.log.WithFields(logrus.Fields{
		"type":        req.Type,
		"serial_port": req.SerialPort,
		"baud_rate":   req.BaudRate,
	}).Info("device type changed via HTTP")

	resp := deviceChangeResponse{
		OK:          true,
		CurrentType: req.Type,
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp)
}

// -------------------------------------------------------------------
// CORS middleware
// -------------------------------------------------------------------

// corsMiddleware adds CORS headers permitting requests from localhost origins.
// This allows the Svelte dashboard on localhost to poll the status endpoint.
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if isLocalhostOrigin(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			w.Header().Set("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// isLocalhostOrigin returns true for http(s)://localhost:* and http(s)://127.0.0.1:*
func isLocalhostOrigin(origin string) bool {
	if origin == "" {
		return false
	}
	for _, prefix := range []string{
		"http://localhost",
		"https://localhost",
		"http://127.0.0.1",
		"https://127.0.0.1",
	} {
		if strings.HasPrefix(origin, prefix) {
			return true
		}
	}
	return false
}
