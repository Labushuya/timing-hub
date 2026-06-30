package tagheuer

import (
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// parseTagHeuerLine tests
// ---------------------------------------------------------------------------

func TestParseTagHeuerLine_FormatA(t *testing.T) {
	// CP 540 format: leading spaces, running number, time, channel letter.
	line := "  0042  00:01:23.456  A"

	runNum, tod, channel, err := parseTagHeuerLine(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if runNum != 42 {
		t.Errorf("runningNum: got %d, want 42", runNum)
	}
	wantTOD := 1*time.Minute + 23*time.Second + 456*time.Millisecond
	if tod != wantTOD {
		t.Errorf("tod: got %v, want %v", tod, wantTOD)
	}
	if channel != 1 {
		t.Errorf("channel: got %d, want 1 (A)", channel)
	}
}

func TestParseTagHeuerLine_FormatA_ChannelB(t *testing.T) {
	line := "  0001  12:00:00.000  B"

	_, _, channel, err := parseTagHeuerLine(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if channel != 2 {
		t.Errorf("channel: got %d, want 2 (B)", channel)
	}
}

func TestParseTagHeuerLine_FormatA_Digit1Channel(t *testing.T) {
	// Some CP firmware emits "1" / "2" instead of "A" / "B".
	line := "  0010  10:30:00.100  1"

	_, _, channel, err := parseTagHeuerLine(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if channel != 1 {
		t.Errorf("channel: got %d, want 1", channel)
	}
}

func TestParseTagHeuerLine_FormatB(t *testing.T) {
	// CP 450/500 format: time first, then running number, then channel.
	line := "00:01:23.456 042 B"

	runNum, tod, channel, err := parseTagHeuerLine(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if runNum != 42 {
		t.Errorf("runningNum: got %d, want 42", runNum)
	}
	wantTOD := 1*time.Minute + 23*time.Second + 456*time.Millisecond
	if tod != wantTOD {
		t.Errorf("tod: got %v, want %v", tod, wantTOD)
	}
	if channel != 2 {
		t.Errorf("channel: got %d, want 2 (B)", channel)
	}
}

func TestParseTagHeuerLine_FormatB_ChannelA(t *testing.T) {
	line := "23:59:59.999 001 A"

	runNum, tod, channel, err := parseTagHeuerLine(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if runNum != 1 {
		t.Errorf("runningNum: got %d, want 1", runNum)
	}
	wantTOD := 23*time.Hour + 59*time.Minute + 59*time.Second + 999*time.Millisecond
	if tod != wantTOD {
		t.Errorf("tod: got %v, want %v", tod, wantTOD)
	}
	if channel != 1 {
		t.Errorf("channel: got %d, want 1 (A)", channel)
	}
}

func TestParseTagHeuerLine_Garbage_NoMatch(t *testing.T) {
	cases := []string{
		"",
		"   ",
		"GARBAGE DATA",
		"not a timing line at all",
		"12:00:00",        // missing fields
		"  42  12:00:00",  // missing ms and channel
		"12:00:00.000 A",  // format B missing runNum
	}

	for _, line := range cases {
		_, _, _, err := parseTagHeuerLine(line)
		if err == nil {
			t.Errorf("expected error for garbage line %q, got nil", line)
		}
	}
}

func TestParseTagHeuerLine_Garbage_NoPanic(t *testing.T) {
	// Ensure no panic on adversarial input — the test itself validates this.
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("panic on garbage input: %v", r)
		}
	}()

	adversarial := []string{
		"\x00\x01\x02\x03",
		"9999999999999999999999",
		"  99999  99:99:99.999  Z",
		string([]byte{0xff, 0xfe, 0xfd}),
	}

	for _, line := range adversarial {
		_, _, _, _ = parseTagHeuerLine(line)
	}
}

// ---------------------------------------------------------------------------
// letterToChannel tests
// ---------------------------------------------------------------------------

func TestLetterToChannel(t *testing.T) {
	cases := []struct {
		input string
		want  int
	}{
		{"A", 1},
		{"1", 1},
		{"B", 2},
		{"2", 2},
		{"C", 1}, // unknown defaults to 1
		{"",  1},
	}
	for _, tc := range cases {
		got := letterToChannel(tc.input)
		if got != tc.want {
			t.Errorf("letterToChannel(%q) = %d, want %d", tc.input, got, tc.want)
		}
	}
}

// ---------------------------------------------------------------------------
// parseTOD tests
// ---------------------------------------------------------------------------

func TestParseTOD_Valid(t *testing.T) {
	tod, err := parseTOD("01", "02", "03", "456")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := 1*time.Hour + 2*time.Minute + 3*time.Second + 456*time.Millisecond
	if tod != want {
		t.Errorf("got %v, want %v", tod, want)
	}
}

func TestParseTOD_Midnight(t *testing.T) {
	tod, err := parseTOD("00", "00", "00", "000")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tod != 0 {
		t.Errorf("got %v, want 0", tod)
	}
}
