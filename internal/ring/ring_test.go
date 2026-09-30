package ring

import (
	"bytes"
	"testing"
)

func TestBasicWriteRead(t *testing.T) {
	b := New(10)
	if _, err := b.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	if got := b.Bytes(); !bytes.Equal(got, []byte("hello")) {
		t.Fatalf("got %q", got)
	}
	if b.Len() != 5 {
		t.Fatalf("len = %d", b.Len())
	}
}

func TestWrapAround(t *testing.T) {
	b := New(5)
	_, _ = b.Write([]byte("abcde"))
	_, _ = b.Write([]byte("fgh"))
	if got := b.Bytes(); !bytes.Equal(got, []byte("defgh")) {
		t.Fatalf("got %q, want defgh", got)
	}
	if b.Len() != 5 {
		t.Fatalf("len = %d", b.Len())
	}
}

func TestOversizedWriteKeepsTail(t *testing.T) {
	b := New(4)
	_, _ = b.Write([]byte("abcdefgh"))
	if got := b.Bytes(); !bytes.Equal(got, []byte("efgh")) {
		t.Fatalf("got %q, want efgh", got)
	}
}

func TestTail(t *testing.T) {
	b := New(100)
	_, _ = b.Write([]byte("0123456789"))
	if got := b.Tail(3); !bytes.Equal(got, []byte("789")) {
		t.Fatalf("got %q", got)
	}
	if got := b.Tail(100); !bytes.Equal(got, []byte("0123456789")) {
		t.Fatalf("got %q", got)
	}
}

func TestZeroCapacity(t *testing.T) {
	b := New(0)
	_, _ = b.Write([]byte("data"))
	if b.Len() != 0 {
		t.Fatalf("len = %d", b.Len())
	}
}
