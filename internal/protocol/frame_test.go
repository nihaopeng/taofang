package protocol

import (
	"bytes"
	"testing"
)

func TestFrameRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteFrame(&buf, TypeStdin, []byte("hello")); err != nil {
		t.Fatal(err)
	}
	f, err := ReadFrame(&buf)
	if err != nil {
		t.Fatal(err)
	}
	if f.Type != TypeStdin || !bytes.Equal(f.Payload, []byte("hello")) {
		t.Fatalf("got type=%#x payload=%q", f.Type, f.Payload)
	}
}

func TestEmptyPayload(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteFrame(&buf, TypeDetach, nil); err != nil {
		t.Fatal(err)
	}
	f, err := ReadFrame(&buf)
	if err != nil {
		t.Fatal(err)
	}
	if f.Type != TypeDetach || len(f.Payload) != 0 {
		t.Fatalf("got type=%#x payload=%v", f.Type, f.Payload)
	}
}

func TestHelloRoundTrip(t *testing.T) {
	payload := EncodeHello(ModeAttachWithTail)
	v, m, err := DecodeHello(payload)
	if err != nil {
		t.Fatal(err)
	}
	if v != Version || m != ModeAttachWithTail {
		t.Fatalf("got v=%d m=%d", v, m)
	}
}

func TestResizeRoundTrip(t *testing.T) {
	rows, cols, err := DecodeResize(EncodeResize(40, 120))
	if err != nil {
		t.Fatal(err)
	}
	if rows != 40 || cols != 120 {
		t.Fatalf("got rows=%d cols=%d", rows, cols)
	}
}

func TestExitRoundTrip(t *testing.T) {
	code, err := DecodeExit(EncodeExit(42))
	if err != nil {
		t.Fatal(err)
	}
	if code != 42 {
		t.Fatalf("got %d", code)
	}
}

func TestOversizedPayloadRejected(t *testing.T) {
	var buf bytes.Buffer
	hdr := []byte{TypeStdin, 0xff, 0xff, 0xff, 0xff}
	buf.Write(hdr)
	if _, err := ReadFrame(&buf); err == nil {
		t.Fatal("expected error for oversized frame")
	}
}
