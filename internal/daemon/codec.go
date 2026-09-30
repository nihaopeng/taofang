package daemon

import (
	"encoding/binary"
	"fmt"
	"os"
	"time"
)

func appendU16(b []byte, v uint16) []byte {
	var t [2]byte
	binary.BigEndian.PutUint16(t[:], v)
	return append(b, t[:]...)
}

func appendU32(b []byte, v uint32) []byte {
	var t [4]byte
	binary.BigEndian.PutUint32(t[:], v)
	return append(b, t[:]...)
}

func timeUnix(sec int64) time.Time { return time.Unix(sec, 0) }

// signalReadyErr reports a startup failure over the readiness pipe. The
// first byte 0x00 means "not ready, see message"; 0x01 means ready.
func (p Params) signalReadyErr(err error) {
	if p.ReadyFD < 0 {
		return
	}
	f := os.NewFile(uintptr(p.ReadyFD), "ready")
	if f == nil {
		return
	}
	defer f.Close()
	_, _ = f.Write([]byte{0x00})
	_, _ = f.Write([]byte(err.Error()))
}

type reader struct {
	b   []byte
	off int
}

func newReader(b []byte) *reader { return &reader{b: b} }

func (r *reader) byte() (byte, error) {
	if r.off+1 > len(r.b) {
		return 0, fmt.Errorf("truncated status payload")
	}
	v := r.b[r.off]
	r.off++
	return v, nil
}

func (r *reader) u16() (uint16, error) {
	if r.off+2 > len(r.b) {
		return 0, fmt.Errorf("truncated status payload")
	}
	v := binary.BigEndian.Uint16(r.b[r.off:])
	r.off += 2
	return v, nil
}

func (r *reader) u32() (uint32, error) {
	if r.off+4 > len(r.b) {
		return 0, fmt.Errorf("truncated status payload")
	}
	v := binary.BigEndian.Uint32(r.b[r.off:])
	r.off += 4
	return v, nil
}

// blob reads a u32 length prefix followed by that many bytes.
func (r *reader) blob() ([]byte, error) {
	n, err := r.u32()
	if err != nil {
		return nil, err
	}
	if r.off+int(n) > len(r.b) {
		return nil, fmt.Errorf("truncated status payload")
	}
	v := r.b[r.off : r.off+int(n)]
	r.off += int(n)
	return v, nil
}
