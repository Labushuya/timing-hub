// Package ws implements the WebSocket client for timy-bridge.
//
// It forwards TimyImpulses to the timing-hub server, tracks unACKed messages,
// buffers to SQLite WAL on disconnect, and drains the buffer on reconnect.
package ws

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	_ "github.com/mattn/go-sqlite3"
	"github.com/sirupsen/logrus"
	"github.com/timing-hub/timy-bridge/config"
	bridgehttp "github.com/timing-hub/timy-bridge/http"
	"github.com/timing-hub/timy-bridge/usb"
)

const (
	writeTimeout    = 10 * time.Second
	pingInterval    = 30 * time.Second
	maxBackoffDelay = 30 * time.Second
	minBackoffDelay = 1 * time.Second
)

// WSTimyImpulse is the JSON message sent to the server.
type WSTimyImpulse struct {
	Type           string `json:"type"`
	PostenID       string `json:"posten_id"`
	Channel        int    `json:"channel"`
	RawTimestampMs int64  `json:"raw_timestamp_ms"`
	RawString      string `json:"raw_string"`
	BridgeSeq      int64  `json:"bridge_seq"`
}

// serverMessage is the envelope for all messages received from the server.
type serverMessage struct {
	Type string `json:"type"`
	// ACK fields
	ClientSeq int64  `json:"client_seq"`
	Status    string `json:"status"`
}

// BridgeStatus is returned by Status().
type BridgeStatus struct {
	Connected     bool
	BufferCount   int
	LastImpulseAt *int64
}

// pendingACK tracks an in-flight message that has not yet been acknowledged.
type pendingACK struct {
	msg    WSTimyImpulse
	sentAt time.Time
}

// BridgeClient manages the WebSocket connection and SQLite WAL buffering.
type BridgeClient struct {
	cfg        *config.Config
	log        *logrus.Logger
	state      *bridgehttp.State
	stopCh     chan struct{}
	reconnCh   chan struct{}
	once       sync.Once
	db         *sql.DB
	dbMu       sync.Mutex
	bridgeSeq  int64 // monotonic, persisted via SQLite
	eventBus   <-chan usb.TimyEvent
	eventBusMu sync.Mutex
}

// NewBridgeClient creates a new BridgeClient using the provided config.
func NewBridgeClient(cfg *config.Config) *BridgeClient {
	return &BridgeClient{
		cfg:      cfg,
		log:      logrus.StandardLogger(),
		stopCh:   make(chan struct{}),
		reconnCh: make(chan struct{}, 1),
	}
}

// newBridgeClientWithState creates a BridgeClient with explicit logger and shared state,
// used by main.go.
func newBridgeClientWithState(cfg *config.Config, log *logrus.Logger, state *bridgehttp.State) *BridgeClient {
	c := NewBridgeClient(cfg)
	c.log = log
	c.state = state
	return c
}

// Connect opens the SQLite WAL database, loads the persisted bridge_seq, and
// initiates the first WebSocket connection attempt. It is non-blocking; call
// RunSendLoop to process events.
func (c *BridgeClient) Connect(ctx context.Context) error {
	db, err := openDB(c.cfg.Reliability.LocalBufferPath)
	if err != nil {
		return fmt.Errorf("ws: open local buffer db: %w", err)
	}
	c.db = db

	// Restore monotonic bridge_seq from the highest value persisted in SQLite.
	var maxSeq int64
	_ = db.QueryRow(`SELECT COALESCE(MAX(bridge_seq), 0) FROM impulse_buffer`).Scan(&maxSeq)
	atomic.StoreInt64(&c.bridgeSeq, maxSeq)

	return nil
}

// SendImpulse buffers a TimyImpulse to the SQLite WAL so RunSendLoop can
// deliver it. It assigns the next bridge_seq and persists the row.
func (c *BridgeClient) SendImpulse(impulse usb.TimyImpulse) error {
	seq := atomic.AddInt64(&c.bridgeSeq, 1)
	c.dbMu.Lock()
	defer c.dbMu.Unlock()
	_, err := c.db.Exec(
		`INSERT OR IGNORE INTO impulse_buffer
		    (bridge_seq, posten_id, channel, epoch_ms, raw_string)
		 VALUES (?, ?, ?, ?, ?)`,
		seq,
		c.cfg.Server.PostenID,
		impulse.Channel,
		impulse.TimestampMs,
		impulse.Raw,
	)
	if err != nil {
		return fmt.Errorf("ws: buffer insert: %w", err)
	}
	c.updateBufferCount()
	return nil
}

// RunSendLoop is the primary goroutine: it reads from eventBus, writes to
// SQLite, then forwards over WebSocket with reconnect/drain logic.
// It blocks until ctx is cancelled.
func (c *BridgeClient) RunSendLoop(ctx context.Context) {
	attempt := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-c.stopCh:
			return
		default:
		}

		if err := c.runOnce(ctx); err != nil {
			c.setConnected(false)
			c.log.WithError(err).Warn("ws: connection lost")
		}

		delay := backoff(attempt)
		attempt++
		c.log.WithField("delay", delay).Info("ws: reconnecting")

		select {
		case <-ctx.Done():
			return
		case <-c.stopCh:
			return
		case <-time.After(delay):
		case <-c.reconnCh:
			attempt = 0 // manual reconnect resets backoff
		}
	}
}

// Run is the compatibility shim used by main.go (old signature).
// It opens the DB, then runs the send loop using eventBus.
func (c *BridgeClient) Run(eventBus <-chan usb.TimyEvent) error {
	if c.db == nil {
		if err := c.Connect(context.Background()); err != nil {
			return err
		}
	}
	defer c.db.Close()

	// Wrap eventBus: buffer incoming events to SQLite as they arrive so we
	// never drop on disconnect.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-c.stopCh:
				return
			case ev, ok := <-eventBus:
				if !ok {
					return
				}
				if err := c.SendImpulse(ev); err != nil {
					c.log.WithError(err).Error("ws: failed to buffer impulse")
				}
				atomic.StoreInt64(&c.state.LastImpulseAtMs, ev.TimestampMs)
			}
		}
	}()

	c.RunSendLoop(ctx)
	return nil
}

// Status returns a snapshot of the current bridge state.
func (c *BridgeClient) Status() BridgeStatus {
	ws := c.state != nil && atomic.LoadInt32(&c.state.WSConnectedFlag) == 1
	buf := 0
	if c.state != nil {
		buf = int(atomic.LoadInt32(&c.state.BufferCount))
	}
	var lastAt *int64
	if c.state != nil {
		ms := atomic.LoadInt64(&c.state.LastImpulseAtMs)
		if ms != 0 {
			lastAt = &ms
		}
	}
	return BridgeStatus{
		Connected:     ws,
		BufferCount:   buf,
		LastImpulseAt: lastAt,
	}
}

// Stop signals the client to stop gracefully.
func (c *BridgeClient) Stop() {
	c.once.Do(func() { close(c.stopCh) })
}

// TriggerReconnect signals the client to reconnect immediately.
func (c *BridgeClient) TriggerReconnect() {
	select {
	case c.reconnCh <- struct{}{}:
	default:
	}
}

// -------------------------------------------------------------------
// internal: single connection lifecycle
// -------------------------------------------------------------------

func (c *BridgeClient) runOnce(ctx context.Context) error {
	dialer := websocket.DefaultDialer
	headers := http.Header{
		"Authorization": []string{"Bearer " + c.cfg.Server.BridgeToken},
		"X-Posten-ID":   []string{c.cfg.Server.PostenID},
	}

	conn, _, err := dialer.DialContext(ctx, c.cfg.Server.WSURL, headers)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	c.setConnected(true)
	c.log.WithField("url", c.cfg.Server.WSURL).Info("ws: connected")

	ackTimeout := time.Duration(c.cfg.Reliability.AckTimeoutMs) * time.Millisecond

	// pending maps bridge_seq → pendingACK
	pending := make(map[int64]pendingACK)
	var pendingMu sync.Mutex

	connCtx, connCancel := context.WithCancel(ctx)
	defer connCancel()

	errCh := make(chan error, 2)

	// Reader goroutine: parse server messages.
	go func() {
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				errCh <- fmt.Errorf("read: %w", err)
				return
			}
			var msg serverMessage
			if err := json.Unmarshal(raw, &msg); err != nil {
				continue
			}
			switch msg.Type {
			case "ack":
				pendingMu.Lock()
				if pa, ok := pending[msg.ClientSeq]; ok {
					// Mark acked_at in SQLite.
					nowMs := time.Now().UnixMilli()
					c.dbMu.Lock()
					_, _ = c.db.Exec(
						`UPDATE impulse_buffer SET acked_at = ? WHERE bridge_seq = ?`,
						nowMs, pa.msg.BridgeSeq,
					)
					// Remove row once fully acked.
					_, _ = c.db.Exec(
						`DELETE FROM impulse_buffer WHERE bridge_seq = ? AND acked_at IS NOT NULL`,
						pa.msg.BridgeSeq,
					)
					c.dbMu.Unlock()
					delete(pending, msg.ClientSeq)
					c.updateBufferCount()
				}
				pendingMu.Unlock()
			}
		}
	}()

	// Drain SQLite buffer (rows with sent_at IS NULL, ordered by bridge_seq).
	if err := c.drainBuffer(conn, pending, &pendingMu); err != nil {
		c.log.WithError(err).Warn("ws: partial buffer drain")
	}

	pingTicker := time.NewTicker(pingInterval)
	defer pingTicker.Stop()

	ackChecker := time.NewTicker(ackTimeout / 2)
	defer ackChecker.Stop()

	send := func(msg WSTimyImpulse) error {
		_ = conn.SetWriteDeadline(time.Now().Add(writeTimeout))
		return conn.WriteJSON(msg)
	}

	for {
		select {
		case <-connCtx.Done():
			return connCtx.Err()

		case <-c.stopCh:
			return nil

		case err := <-errCh:
			return err

		case <-pingTicker.C:
			_ = conn.SetWriteDeadline(time.Now().Add(writeTimeout))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return fmt.Errorf("ping: %w", err)
			}

		case <-ackChecker.C:
			// Resend in-flight messages older than ack_timeout.
			deadline := time.Now().Add(-ackTimeout)
			pendingMu.Lock()
			for seq, pa := range pending {
				if pa.sentAt.Before(deadline) {
					if err := send(pa.msg); err != nil {
						pendingMu.Unlock()
						return fmt.Errorf("resend: %w", err)
					}
					pending[seq] = pendingACK{msg: pa.msg, sentAt: time.Now()}
				}
			}
			pendingMu.Unlock()

			// Also pick up any new rows written to SQLite since last drain.
			if err := c.sendNewRows(conn, pending, &pendingMu); err != nil {
				return fmt.Errorf("send new rows: %w", err)
			}
		}
	}
}

// drainBuffer sends all unsent (sent_at IS NULL) rows from impulse_buffer
// in bridge_seq order. Called once immediately after connect.
func (c *BridgeClient) drainBuffer(
	conn *websocket.Conn,
	pending map[int64]pendingACK,
	pendingMu *sync.Mutex,
) error {
	c.dbMu.Lock()
	rows, err := c.db.Query(
		`SELECT bridge_seq, posten_id, channel, epoch_ms, raw_string
		 FROM impulse_buffer
		 WHERE sent_at IS NULL
		 ORDER BY bridge_seq ASC`,
	)
	if err != nil {
		c.dbMu.Unlock()
		return err
	}

	type row struct {
		bridgeSeq int64
		postenID  string
		channel   int
		epochMs   int64
		rawString string
	}
	var buf []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.bridgeSeq, &r.postenID, &r.channel, &r.epochMs, &r.rawString); err != nil {
			continue
		}
		buf = append(buf, r)
	}
	rows.Close()
	c.dbMu.Unlock()

	for _, r := range buf {
		msg := WSTimyImpulse{
			Type:           "timy_impulse",
			PostenID:       r.postenID,
			Channel:        r.channel,
			RawTimestampMs: r.epochMs,
			RawString:      r.rawString,
			BridgeSeq:      r.bridgeSeq,
		}
		_ = conn.SetWriteDeadline(time.Now().Add(writeTimeout))
		if err := conn.WriteJSON(msg); err != nil {
			return fmt.Errorf("drain send seq=%d: %w", r.bridgeSeq, err)
		}
		nowMs := time.Now().UnixMilli()
		c.dbMu.Lock()
		_, _ = c.db.Exec(
			`UPDATE impulse_buffer SET sent_at = ? WHERE bridge_seq = ?`,
			nowMs, r.bridgeSeq,
		)
		c.dbMu.Unlock()

		pendingMu.Lock()
		pending[r.bridgeSeq] = pendingACK{msg: msg, sentAt: time.Now()}
		pendingMu.Unlock()
	}
	return nil
}

// sendNewRows picks up rows written to impulse_buffer since the last drain
// (sent_at IS NULL) and sends them over the live connection.
func (c *BridgeClient) sendNewRows(
	conn *websocket.Conn,
	pending map[int64]pendingACK,
	pendingMu *sync.Mutex,
) error {
	return c.drainBuffer(conn, pending, pendingMu)
}

// -------------------------------------------------------------------
// helpers
// -------------------------------------------------------------------

func (c *BridgeClient) setConnected(v bool) {
	if c.state == nil {
		return
	}
	if v {
		atomic.StoreInt32(&c.state.WSConnectedFlag, 1)
	} else {
		atomic.StoreInt32(&c.state.WSConnectedFlag, 0)
	}
}

func (c *BridgeClient) updateBufferCount() {
	if c.db == nil || c.state == nil {
		return
	}
	var n int32
	_ = c.db.QueryRow(`SELECT COUNT(*) FROM impulse_buffer`).Scan(&n)
	atomic.StoreInt32(&c.state.BufferCount, n)
}

// openDB creates or opens the SQLite WAL buffer database with the required schema.
func openDB(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite3", path+"?_journal=WAL&_timeout=5000&_busy_timeout=5000")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // SQLite WAL is single-writer

	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS impulse_buffer (
		id          INTEGER PRIMARY KEY AUTOINCREMENT,
		bridge_seq  INTEGER NOT NULL UNIQUE,
		posten_id   TEXT    NOT NULL,
		channel     INTEGER NOT NULL,
		epoch_ms    INTEGER NOT NULL,
		raw_string  TEXT    NOT NULL,
		sent_at     INTEGER,
		acked_at    INTEGER
	)`)
	if err != nil {
		db.Close()
		return nil, err
	}

	_, err = db.Exec(`CREATE INDEX IF NOT EXISTS idx_impulse_buffer_sent
		ON impulse_buffer(sent_at)`)
	if err != nil {
		db.Close()
		return nil, err
	}

	return db, nil
}

// backoff returns exponential backoff (1s → 2s → 4s → … → 30s).
func backoff(attempt int) time.Duration {
	d := minBackoffDelay.Seconds() * math.Pow(2, float64(attempt))
	if d > maxBackoffDelay.Seconds() {
		d = maxBackoffDelay.Seconds()
	}
	return time.Duration(d * float64(time.Second))
}

// -------------------------------------------------------------------
// Compatibility shim: NewClient keeps main.go compiling unchanged.
// -------------------------------------------------------------------

// Config is the flat config struct used by the legacy NewClient constructor.
type Config struct {
	WSURL              string
	BridgeToken        string
	PostenID           string
	AckTimeoutMs       int
	ReconnectIntervalS int
	LocalBufferPath    string
	MaxBufferEntries   int
}

// NewClient is the legacy constructor used by main.go.
func NewClient(cfg Config, log *logrus.Logger, state *bridgehttp.State) *BridgeClient {
	bridgeCfg := &config.Config{}
	bridgeCfg.Server.WSURL = cfg.WSURL
	bridgeCfg.Server.BridgeToken = cfg.BridgeToken
	bridgeCfg.Server.PostenID = cfg.PostenID
	bridgeCfg.Reliability.AckTimeoutMs = cfg.AckTimeoutMs
	bridgeCfg.Reliability.ReconnectIntervalS = cfg.ReconnectIntervalS
	bridgeCfg.Reliability.LocalBufferPath = cfg.LocalBufferPath
	bridgeCfg.Reliability.MaxBufferEntries = cfg.MaxBufferEntries
	c := newBridgeClientWithState(bridgeCfg, log, state)
	return c
}
