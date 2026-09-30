// Package ring implements a fixed-size byte ring buffer used to keep the most
// recent PTY output in memory.
//
// The buffer is intentionally byte-oriented: PTY output is an opaque stream
// and psess must never split or interpret ANSI/UTF-8 sequences.
package ring

import "sync"

// Buffer is a fixed-capacity circular byte buffer. It is safe for concurrent
// use.
type Buffer struct {
	mu   sync.Mutex
	data []byte
	size int
	pos  int  // next write offset
	full bool // at least one full wrap has happened
}

// New creates a ring buffer holding at most capacity bytes.
func New(capacity int) *Buffer {
	if capacity < 0 {
		capacity = 0
	}
	return &Buffer{data: make([]byte, capacity), size: capacity}
}

// Write appends p to the buffer, overwriting the oldest bytes when full.
func (b *Buffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if b.size == 0 {
		return len(p), nil
	}

	// If the input alone is larger than the buffer, keep only the tail.
	if len(p) >= b.size {
		copy(b.data, p[len(p)-b.size:])
		b.pos = 0
		b.full = true
		return len(p), nil
	}

	// Track whether this write wraps around past the current write pointer.
	first := copy(b.data[b.pos:], p)
	if first < len(p) {
		copy(b.data, p[first:])
		b.full = true
	}

	b.pos = (b.pos + len(p)) % b.size
	return len(p), nil
}

// Bytes returns a copy of the buffered bytes in chronological order.
func (b *Buffer) Bytes() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.bytesLocked()
}

// Len returns the number of buffered bytes.
func (b *Buffer) Len() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.full {
		return b.size
	}
	return b.pos
}

// Tail returns up to n most recent bytes in chronological order.
func (b *Buffer) Tail(n int) []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	all := b.bytesLocked()
	if n < 0 || n >= len(all) {
		return all
	}
	return append([]byte(nil), all[len(all)-n:]...)
}

func (b *Buffer) bytesLocked() []byte {
	if b.size == 0 {
		return nil
	}
	if !b.full {
		return append([]byte(nil), b.data[:b.pos]...)
	}
	out := make([]byte, 0, b.size)
	out = append(out, b.data[b.pos:]...)
	out = append(out, b.data[:b.pos]...)
	return out
}
