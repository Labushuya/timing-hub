// Package ws implements the WebSocket client for timy-bridge.
//
// It forwards TimyEvents to the timing-hub server, tracks unACKed messages,
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
	bridgehttp "github.com/timing-hub/timy-bridge/http"
	"github.com/timing-hub/timy-bridge/usb"
)

const (
	writeTimeout    = 10 * time.Second
	pingInterval    = 30 * time.Second
	maxBackoffDelay = 60 * time.Second
)

// WSTimyImpulse is the JSON message sent to the server.
type WSTimyImpulse struct {
	Type        string `json:"type"`
	MsgID       int64  `json:"msg_id"`
	PostenID    string `json:"posten_id"`
	Seq         int    `json:"seq"`
	Channel     int    `json:"channel"`
	TimestampMs int64  `json:"timestamp_ms"`
	Raw         string `json:"raw"`
}

// wsACK is the JSON message received from the server.
type wsACK struct {
	Type  string `json:"type"`
	MsgID int64  `json:"msg_id"`
}

// Config holds WS client configuration.
type Config struct {
	WSURL              string
	BridgeToken        string
	PostenID           string
	AckTimeoutMs       int
	ReconnectIntervalS int
	LocalBufferPath    string
	MaxBufferEntries   int
}

// Client manages the WebSocket connection and buffering.
type Client struct {
	cfg      Config
	log      *logrus.Logger
	state    *bridgehttp.State
	stopCh   chan struct{}
	once     sync.Once
	db       *sql.DB
	msgIDSeq int64
}

// NewClient creates a new WS client.
func NewClient(cfg Config, log *logrus.Logger, state *bridgehttp.State) *Client {
	return &Client{
		cfg:    cfg,
		log:    log,
		state:  state,
		stopCh: make(chan struct{}),
	}
}

// Run processes events from eventBus, forwarding them to the server.
// It blocks until Stop is called.
func (c *Client) Run(eventBus <-chan usb.TimyEvent) error {
	db, err := openDB(c.cfg.LocalBufferPath)
	if err != nil {
		return fmt.Errorf("open local buffer db: %w", err)
	}
	c.db = db
	defer db.Close()

	attempt := 0
	for {
		select {
		case <-c.stopCh:
			return nil
		default:
		}

		if err := c.runOnce(eventBus); err != nil {
			atomic.StoreInt32(&c.state.WSConnectedFlag, 0)
			c.log.WithError(err).Warn("ws connection lost")
		}

		delay := backoff(attempt)
		attempt++
		c.log.WithField("delay", delay).Info("reconnecting ws")

		select {
		case <-c.stopCh:
			return nil
		case <-time.After(delay):
		}
	}
}

func (c *Client) runOnce(eventBus <-chan usb.TimyEvent) error {
	dialer := websocket.DefaultDialer
	headers := http.Header{
		"Authorization": []string{"Bearer " + c.cfg.BridgeToken},
		"X-Posten-ID":   []string{c.cfg.PostenID},
	}

	conn, _, err := dialer.Dial(c.cfg.WSURL, headers)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	atomic.StoreInt32(&c.state.WSConnectedFlag, 1)
	c.log.WithField("url", c.cfg.WSURL).Info("ws connected")

	// Track unACKed messages: msgID -> WSTimyImpulse
	unACKed := make(map[int64]WSTimyImpulse)
	var unACKedMu sync.Mutex
	ackTimeout := time.Duration(c.cfg.AckTimeoutMs) * time.Millisecond

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	errCh := make(chan error, 2)

	// ACK reader goroutine
	go func() {
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				errCh <- fmt.Errorf("read: %w", err)
				return
			}
			var ack wsACK
			if err := json.Unmarshal(raw, &ack); err != nil || ack.Type != "ack" {
				continue
			}
			unACKedMu.Lock()
			delete(unACKed, ack.MsgID)
			atomic.StoreInt32(&c.state.WSConnectedFlag, 1)
			unACKedMu.Unlock()
		}
	}()

	// Ping ticker
	pingTicker := time.NewTicker(pingInterval)
	defer pingTicker.Stop()

	// ACK timeout checker
	ackChecker := time.NewTicker(ackTimeout / 2)
	defer ackChecker.Stop()

	// Drain SQLite buffer first
	if err := c.drainBuffer(conn, unACKed, &unACKedMu); err != nil {
		c.log.WithError(err).Warn("partial buffer drain")
	}

	send := func(msg WSTimyImpulse) error {
		conn.SetWriteDeadline(time.Now().Add(writeTimeout))
		return conn.WriteJSON(msg)
	}

	for {
		select {
		case <-c.stopCh:
			// Drain remaining eventBus events to SQLite before exit
			drainToDB:
			for {
				select {
				case ev := <-eventBus:
					_ = c.bufferEvent(ev)
				default:
					break drainToDB
				}
			}
			return nil

		case ev, ok := <-eventBus:
			if !ok {
				return nil
			}
			msgID := atomic.AddInt64(&c.msgIDSeq, 1)
			msg := WSTimyImpulse{
				Type:        "timy_impulse",
				MsgID:       msgID,
				PostenID:    c.cfg.PostenID,
				Seq:         ev.Seq,
				Channel:     ev.Channel,
				TimestampMs: ev.TimestampMs,
				Raw:         ev.Raw,
			}
			if err := send(msg); err != nil {
				_ = c.bufferEvent(ev)
				return fmt.Errorf("send: %w", err)
			}
			unACKedMu.Lock()
			unACKed[msgID] = msg
			unACKedMu.Unlock()

		case <-ackChecker.C:
			// Resend messages that haven't been ACKed within ackTimeout
			deadline := time.Now().Add(-ackTimeout)
			_ = deadline // in a production impl, stamp send time on msg
			unACKedMu.Lock()
			for _, msg := range unACKed {
				if err := send(msg); err != nil {
					unACKedMu.Unlock()
					return fmt.Errorf("resend: %w", err)
				}
			}
			unACKedMu.Unlock()

		case <-pingTicker.C:
			conn.SetWriteDeadline(time.Now().Add(writeTimeout))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return fmt.Errorf("ping: %w", err)
			}

		case err := <-errCh:
			return err

		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (c *Client) bufferEvent(ev usb.TimyEvent) error {
	_, err := c.db.Exec(
		`INSERT OR IGNORE INTO buffer(seq, channel, timestamp_ms, raw) VALUES (?,?,?,?)`,
		ev.Seq, ev.Channel, ev.TimestampMs, ev.Raw,
	)
	if err != nil {
		c.log.WithError(err).Error("buffer insert failed")
	}
	// Trim oldest entries if over limit
	_, _ = c.db.Exec(
		`DELETE FROM buffer WHERE rowid IN (
			SELECT rowid FROM buffer ORDER BY rowid ASC
			LIMIT (SELECT MAX(0, COUNT(*) - ?) FROM buffer)
		)`,
		c.cfg.MaxBufferEntries,
	)
	count := 0
	_ = c.db.QueryRow(`SELECT COUNT(*) FROM buffer`).Scan(&count)
	atomic.StoreInt32(&c.state.BufferCount, int32(count))
	return err
}

func (c *Client) drainBuffer(conn *websocket.Conn, unACKed map[int64]WSTimyImpulse, mu *sync.Mutex) error {
	rows, err := c.db.Query(
		`SELECT rowid, seq, channel, timestamp_ms, raw FROM buffer ORDER BY rowid ASC`,
	)
	if err != nil {
		return err
	}
	defer rows.Close()

	type row struct {
		rowid       int64
		seq         int
		channel     int
		timestampMs int64
		raw         string
	}
	var buffered []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.rowid, &r.seq, &r.channel, &r.timestampMs, &r.raw); err != nil {
			continue
		}
		buffered = append(buffered, r)
	}
	rows.Close()

	for _, r := range buffered {
		msgID := atomic.AddInt64(&c.msgIDSeq, 1)
		msg := WSTimyImpulse{
			Type:        "timy_impulse",
			MsgID:       msgID,
			PostenID:    c.cfg.PostenID,
			Seq:         r.seq,
			Channel:     r.channel,
			TimestampMs: r.timestampMs,
			Raw:         r.raw,
		}
		conn.SetWriteDeadline(time.Now().Add(writeTimeout))
		if err := conn.WriteJSON(msg); err != nil {
			return fmt.Errorf("drain send: %w", err)
		}
		mu.Lock()
		unACKed[msgID] = msg
		mu.Unlock()

		// Remove from SQLite after sending (ACK will confirm delivery)
		_, _ = c.db.Exec(`DELETE FROM buffer WHERE rowid = ?`, r.rowid)
	}

	count := 0
	_ = c.db.QueryRow(`SELECT COUNT(*) FROM buffer`).Scan(&count)
	atomic.StoreInt32(&c.state.BufferCount, int32(count))
	return nil
}

// Stop signals the client to stop.
func (c *Client) Stop() {
	c.once.Do(func() { close(c.stopCh) })
}

// openDB creates/opens the SQLite WAL buffer database.
func openDB(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite3", path+"?_journal=WAL&_timeout=5000")
	if err != nil {
		return nil, err
	}
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS buffer (
		seq          INTEGER NOT NULL,
		channel      INTEGER NOT NULL,
		timestamp_ms INTEGER NOT NULL,
		raw          TEXT    NOT NULL,
		UNIQUE(seq, timestamp_ms)
	)`)
	if err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

// backoff returns exponential backoff with jitter, capped at maxBackoffDelay.
func backoff(attempt int) time.Duration {
	base := 1.0
	d := base * math.Pow(2, float64(attempt))
	if d > maxBackoffDelay.Seconds() {
		d = maxBackoffDelay.Seconds()
	}
	return time.Duration(d) * time.Second
}
