package daemon

import (
	"testing"
	"time"
)

func TestStatusCodecRoundTrip(t *testing.T) {
	in := Status{
		Name:       "dev",
		PID:        12345,
		Command:    "python train.py --epochs 100",
		StartTime:  time.Unix(1700000000, 0),
		Attached:   true,
		Exited:     false,
		ExitCode:   0,
		Rows:       40,
		Cols:       120,
		BufferSize: 4096,
	}
	out, err := DecodeStatus(encodeStatus(in))
	if err != nil {
		t.Fatal(err)
	}
	if out.Name != in.Name || out.PID != in.PID || out.Command != in.Command {
		t.Fatalf("identity mismatch: %+v", out)
	}
	if out.Rows != in.Rows || out.Cols != in.Cols {
		t.Fatalf("size mismatch: %+v", out)
	}
	if !out.Attached || out.Exited {
		t.Fatalf("flag mismatch: %+v", out)
	}
	if out.BufferSize != in.BufferSize {
		t.Fatalf("buffer mismatch: %+v", out)
	}
	if !out.StartTime.Equal(in.StartTime) {
		t.Fatalf("time mismatch: %v vs %v", out.StartTime, in.StartTime)
	}
}

func TestDecodeStatusTruncated(t *testing.T) {
	if _, err := DecodeStatus([]byte{0, 0}); err == nil {
		t.Fatal("expected error on truncated payload")
	}
}
