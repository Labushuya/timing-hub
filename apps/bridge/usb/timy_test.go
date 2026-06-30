package usb

import (
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// newTestState returns a zeroed-out TOD-conversion state suitable for tests.
func newTestState() (
	sessionStartUTC time.Time,
	todInitialised bool,
	sessionStartTOD time.Duration,
	prevTOD time.Duration,
	dayOffset time.Duration,
) {
	// Anchor session at 2024-01-15 08:00:00 UTC.
	sessionStartUTC = time.Date(2024, 1, 15, 8, 0, 0, 0, time.UTC)
	return
}

// parseLine is a thin wrapper that calls parseTimyLineWithState with
// freshly allocated state — convenient for tests that only care about
// the parsed fields and not the epoch conversion.
func parseLine(line string) (TimyImpulse, error) {
	sessionStartUTC, todInitialised, sessionStartTOD, prevTOD, dayOffset :=
		newTestState()
	return parseTimyLineWithState(
		line,
		sessionStartUTC,
		&todInitialised,
		&sessionStartTOD,
		&prevTOD,
		&dayOffset,
	)
}

// ---------------------------------------------------------------------------
// parseTimyLine — field parsing
// ---------------------------------------------------------------------------

func TestParseTimyLine_BasicImpulse(t *testing.T) {
	line := "  0042  00:01:23.456  C1"
	imp, err := parseLine(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if imp.RunningNum != 42 {
		t.Errorf("RunningNum: got %d, want 42", imp.RunningNum)
	}
	wantTOD := 1*time.Minute + 23*time.Second + 456*time.Millisecond
	if imp.TimeOfDay != wantTOD {
		t.Errorf("TimeOfDay: got %v, want %v", imp.TimeOfDay, wantTOD)
	}
	if imp.Channel != 1 {
		t.Errorf("Channel: got %d, want 1", imp.Channel)
	}
	if imp.RawLine != line {
		t.Errorf("RawLine: got %q, want %q", imp.RawLine, line)
	}
}

func TestParseTimyLine_Channel2(t *testing.T) {
	line := "  0001  12:34:56.789  C2"
	imp, err := parseLine(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if imp.Channel != 2 {
		t.Errorf("Channel: got %d, want 2", imp.Channel)
	}
	if imp.RunningNum != 1 {
		t.Errorf("RunningNum: got %d, want 1", imp.RunningNum)
	}
	wantTOD := 12*time.Hour + 34*time.Minute + 56*time.Second + 789*time.Millisecond
	if imp.TimeOfDay != wantTOD {
		t.Errorf("TimeOfDay: got %v, want %v", imp.TimeOfDay, wantTOD)
	}
}

func TestParseTimyLine_WithCRLF(t *testing.T) {
	// The ReadLoop strips \r before passing to parseTimyLine, but the regex
	// also tolerates trailing whitespace.
	line := "  0100  10:00:00.000  C1  "
	imp, err := parseLine(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if imp.RunningNum != 100 {
		t.Errorf("RunningNum: got %d, want 100", imp.RunningNum)
	}
}

func TestParseTimyLine_MaxRunningNum(t *testing.T) {
	line := "  9999  23:59:59.999  C1"
	imp, err := parseLine(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if imp.RunningNum != 9999 {
		t.Errorf("RunningNum: got %d, want 9999", imp.RunningNum)
	}
}

// ---------------------------------------------------------------------------
// parseTimyLine — epoch conversion
// ---------------------------------------------------------------------------

func TestParseTimyLine_EpochConversion(t *testing.T) {
	// Per spec: sessionStartUTC anchors to sessionStartTOD (first TOD seen).
	// For the first impulse: epochMs = sessionStartUTC.UnixMilli() (by definition).
	// For subsequent impulses: epochMs = sessionStartUTC + (tod - sessionStartTOD).
	//
	// Test: session opened at 2024-01-15 08:00:00.000 UTC.
	//   impulse 1: TOD=08:00:00.000 → epochMs = sessionStartUTC (08:00:00.000 UTC)
	//   impulse 2: TOD=08:00:01.500 → epochMs = sessionStartUTC + 1500ms
	sessionStart := time.Date(2024, 1, 15, 8, 0, 0, 0, time.UTC)
	var todInit bool
	var startTOD, prev, dayOff time.Duration

	// First impulse anchors the session.
	_, err := parseTimyLineWithState("  0001  08:00:00.000  C1",
		sessionStart, &todInit, &startTOD, &prev, &dayOff)
	if err != nil {
		t.Fatalf("unexpected error on first impulse: %v", err)
	}

	// Second impulse: 1500ms later.
	imp2, err := parseTimyLineWithState("  0002  08:00:01.500  C1",
		sessionStart, &todInit, &startTOD, &prev, &dayOff)
	if err != nil {
		t.Fatalf("unexpected error on second impulse: %v", err)
	}

	wantEpochMs := sessionStart.UnixMilli() + 1500
	if imp2.EpochMs != wantEpochMs {
		t.Errorf("EpochMs: got %d, want %d (diff %d ms)",
			imp2.EpochMs, wantEpochMs, imp2.EpochMs-wantEpochMs)
	}
}

// ---------------------------------------------------------------------------
// Midnight rollover
// ---------------------------------------------------------------------------

func TestMidnightRollover_EpochAdvances(t *testing.T) {
	// Session started at 2024-01-15 23:59:59.000 UTC (just before midnight).
	// TOD of first impulse: 23:59:59.900
	// TOD of second impulse: 00:00:00.100  (crossed midnight)
	// Expected delta: 200 ms.

	sessionStart := time.Date(2024, 1, 15, 23, 59, 59, 0, time.UTC)
	var todInit bool
	var startTOD, prev, dayOff time.Duration

	line1 := "  0001  23:59:59.900  C1"
	imp1, err := parseTimyLineWithState(line1, sessionStart, &todInit, &startTOD, &prev, &dayOff)
	if err != nil {
		t.Fatalf("first impulse error: %v", err)
	}

	line2 := "  0002  00:00:00.100  C1"
	imp2, err := parseTimyLineWithState(line2, sessionStart, &todInit, &startTOD, &prev, &dayOff)
	if err != nil {
		t.Fatalf("second impulse error: %v", err)
	}

	delta := imp2.EpochMs - imp1.EpochMs
	if delta != 200 {
		t.Errorf("epoch delta after midnight rollover: got %d ms, want 200 ms", delta)
	}
}

func TestMidnightRollover_TwoRollovers(t *testing.T) {
	// Verify that two midnight rollovers accumulate correctly.
	// Sequence: 23:00 → 23:59:59 → (rollover) 00:00:01 → 23:59:58 → (rollover) 00:00:00
	//
	// After first rollover, dayOffset = 24h.
	// After second rollover, dayOffset = 48h.
	sessionStart := time.Date(2024, 1, 15, 23, 0, 0, 0, time.UTC)
	var todInit bool
	var startTOD, prev, dayOff time.Duration

	parse := func(line string) TimyImpulse {
		t.Helper()
		imp, err := parseTimyLineWithState(line, sessionStart, &todInit, &startTOD, &prev, &dayOff)
		if err != nil {
			t.Fatalf("parse error: %v", err)
		}
		return imp
	}

	imp0 := parse("  0001  23:00:00.000  C1") // base
	imp1 := parse("  0002  23:59:59.000  C1") // +59m59s
	imp2 := parse("  0003  00:00:01.000  C1") // first rollover: +1h0m2s from imp0
	imp3 := parse("  0004  23:59:58.000  C1") // same day as imp2 (no rollover)
	imp4 := parse("  0005  00:00:00.500  C1") // second rollover

	wantAdv1 := int64((59*60 + 59) * 1000)
	if got := imp1.EpochMs - imp0.EpochMs; got != wantAdv1 {
		t.Errorf("imp1 adv: got %d, want %d", got, wantAdv1)
	}

	wantAdv2 := int64((60*60 + 2) * 1000) // 1h 0m 2s
	if got := imp2.EpochMs - imp0.EpochMs; got != wantAdv2 {
		t.Errorf("imp2 adv: got %d, want %d", got, wantAdv2)
	}

	// imp3 is 23:59:58 after first rollover — not a new rollover.
	// epoch = imp0 + 24h + (23:59:58 - 23:00:00)
	wantAdv3 := int64(24*60*60*1000 + (59*60+58)*1000)
	if got := imp3.EpochMs - imp0.EpochMs; got != wantAdv3 {
		t.Errorf("imp3 adv: got %d, want %d", got, wantAdv3)
	}

	// imp4 is 00:00:00.500 after imp3=23:59:58 → second rollover.
	// dayOffset = 48h, tod = 00:00:00.500, sessionStartTOD = 23:00:00.000
	// adv = 48h - 23h + 0.5s = 25h + 0.5s
	wantAdv4 := int64(25*60*60*1000 + 500)
	if got := imp4.EpochMs - imp0.EpochMs; got != wantAdv4 {
		t.Errorf("imp4 adv: got %d, want %d", got, wantAdv4)
	}
}

func TestMidnightRollover_PrevTOD23_59_59_900_Next_00_00_00_100(t *testing.T) {
	// Canonical spec example: prev=23:59:59.900, next=00:00:00.100 → +200ms
	sessionStart := time.Date(2024, 6, 1, 10, 0, 0, 0, time.UTC)
	var todInit bool
	var startTOD, prev, dayOff time.Duration

	imp1, err := parseTimyLineWithState("  0001  23:59:59.900  C1",
		sessionStart, &todInit, &startTOD, &prev, &dayOff)
	if err != nil {
		t.Fatal(err)
	}
	imp2, err := parseTimyLineWithState("  0002  00:00:00.100  C1",
		sessionStart, &todInit, &startTOD, &prev, &dayOff)
	if err != nil {
		t.Fatal(err)
	}

	if d := imp2.EpochMs - imp1.EpochMs; d != 200 {
		t.Errorf("expected 200ms delta across midnight, got %dms", d)
	}
}

// ---------------------------------------------------------------------------
// Garbage / empty lines
// ---------------------------------------------------------------------------

func TestParseTimyLine_EmptyLine(t *testing.T) {
	_, err := parseLine("")
	if err == nil {
		t.Error("expected error for empty line, got nil")
	}
}

func TestParseTimyLine_GarbageLine(t *testing.T) {
	garbage := []string{
		"not a timy line",
		"  XXXX  AB:CD:EF.GHI  CX",
		"12345",
		strings.Repeat("A", 128),
		"\x00\xff\xfe",
		"   ",
	}
	for _, g := range garbage {
		_, err := parseLine(g)
		if err == nil {
			t.Errorf("expected error for garbage line %q, got nil", g)
		}
	}
}

func TestParseTimyLine_NoPanicOnGarbage(t *testing.T) {
	// Ensure no panic regardless of input.
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("panic on garbage input: %v", r)
		}
	}()
	inputs := []string{
		"",
		"  ",
		"random data with no structure at all!!!",
		"\r\n",
		"  0001  25:99:99.999  C9",    // out-of-range values (regex won't match)
		"  0001  10:00:00.000  C",     // missing channel digit
		"  0001  10:00:00.000  C1  extra",
	}
	for _, in := range inputs {
		_, _ = parseLine(in)
	}
}

// ---------------------------------------------------------------------------
// impulseToEvent mapping
// ---------------------------------------------------------------------------

func TestImpulseToEvent(t *testing.T) {
	imp := TimyImpulse{
		RunningNum: 7,
		TimeOfDay:  time.Hour,
		EpochMs:    1_700_000_000_000,
		Channel:    2,
		RawLine:    "  0007  01:00:00.000  C2\r\n",
	}
	ev := impulseToEvent(imp)
	if ev.Seq != 7 {
		t.Errorf("Seq: got %d, want 7", ev.Seq)
	}
	if ev.Channel != 2 {
		t.Errorf("Channel: got %d, want 2", ev.Channel)
	}
	if ev.TimestampMs != 1_700_000_000_000 {
		t.Errorf("TimestampMs: got %d", ev.TimestampMs)
	}
	// Raw should be trimmed.
	if strings.ContainsAny(ev.Raw, "\r\n") {
		t.Errorf("Raw should not contain CR/LF, got %q", ev.Raw)
	}
}
