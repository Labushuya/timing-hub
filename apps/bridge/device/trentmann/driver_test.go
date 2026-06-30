package trentmann

import (
	"testing"
	"time"
)

// TestParseRallyStarLine_SpaceFormat verifies the space-delimited variant.
func TestParseRallyStarLine_SpaceFormat(t *testing.T) {
	line := "042 00:01:23.456 1"

	num, tod, ch, err := parseRallyStarLine(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if num != 42 {
		t.Errorf("runningNum: got %d, want 42", num)
	}
	if ch != 1 {
		t.Errorf("channel: got %d, want 1", ch)
	}

	wantTOD := 1*time.Minute + 23*time.Second + 456*time.Millisecond
	if tod != wantTOD {
		t.Errorf("tod: got %v, want %v", tod, wantTOD)
	}
}

// TestParseRallyStarLine_SemicolonFormat verifies the semicolon-delimited variant.
func TestParseRallyStarLine_SemicolonFormat(t *testing.T) {
	line := "042;00:01:23.456;2"

	num, tod, ch, err := parseRallyStarLine(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if num != 42 {
		t.Errorf("runningNum: got %d, want 42", num)
	}
	if ch != 2 {
		t.Errorf("channel: got %d, want 2", ch)
	}

	wantTOD := 1*time.Minute + 23*time.Second + 456*time.Millisecond
	if tod != wantTOD {
		t.Errorf("tod: got %v, want %v", tod, wantTOD)
	}
}

// TestParseRallyStarLine_Garbage verifies that unrecognised input returns an
// error and does not panic.
func TestParseRallyStarLine_Garbage(t *testing.T) {
	cases := []string{
		"",
		"garbage",
		"not a timing line at all",
		"99:99:99.999 000 X",
		";;;",
		"042 00:01:23.456",     // missing channel
		"00:01:23.456 042 1",   // time-first (not RallyStar format)
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc, func(t *testing.T) {
			// Must not panic.
			num, tod, ch, err := parseRallyStarLine(tc)
			if err == nil {
				t.Errorf("expected error for input %q, got num=%d tod=%v ch=%d", tc, num, tod, ch)
			}
		})
	}
}

// TestParseRallyStarLine_LeadingWhitespace verifies that lines with leading
// or trailing whitespace (as produced by bufio.Scanner after stripping CR) are
// handled correctly.
func TestParseRallyStarLine_LeadingWhitespace(t *testing.T) {
	line := "  007 12:34:56.789 2  "

	num, tod, ch, err := parseRallyStarLine(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if num != 7 {
		t.Errorf("runningNum: got %d, want 7", num)
	}
	if ch != 2 {
		t.Errorf("channel: got %d, want 2", ch)
	}

	wantTOD := 12*time.Hour + 34*time.Minute + 56*time.Second + 789*time.Millisecond
	if tod != wantTOD {
		t.Errorf("tod: got %v, want %v", tod, wantTOD)
	}
}

// TestParseRallyStarLine_LargeRunNumber verifies that 4-digit sequence numbers
// are parsed correctly.
func TestParseRallyStarLine_LargeRunNumber(t *testing.T) {
	line := "1234 23:59:59.999 1"

	num, tod, ch, err := parseRallyStarLine(line)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if num != 1234 {
		t.Errorf("runningNum: got %d, want 1234", num)
	}
	if ch != 1 {
		t.Errorf("channel: got %d, want 1", ch)
	}

	wantTOD := 23*time.Hour + 59*time.Minute + 59*time.Second + 999*time.Millisecond
	if tod != wantTOD {
		t.Errorf("tod: got %v, want %v", tod, wantTOD)
	}
}
