package protocol

import (
	"encoding/binary"
	"fmt"
	"io"
)

// Frame is a decoded protocol message.
type Frame struct {
	Type    uint8
	Payload []byte
}

// WriteFrame writes a single framed message. It is safe to call concurrently
// only if the caller serializes access to w.
func WriteFrame(w io.Writer, typ uint8, payload []byte) error {
	if len(payload) > MaxPayload {
		return fmt.Errorf("payload too large: %d bytes", len(payload))
	}
	var hdr [5]byte
	hdr[0] = typ
	binary.BigEndian.PutUint32(hdr[1:], uint32(len(payload)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	if len(payload) > 0 {
		if _, err := w.Write(payload); err != nil {
			return err
		}
	}
	return nil
}

// ReadFrame reads a single framed message from r.
func ReadFrame(r io.Reader) (Frame, error) {
	var hdr [5]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return Frame{}, err
	}
	length := binary.BigEndian.Uint32(hdr[1:])
	if length > MaxPayload {
		return Frame{}, fmt.Errorf("frame payload too large: %d bytes", length)
	}
	var payload []byte
	if length > 0 {
		payload = make([]byte, length)
		if _, err := io.ReadFull(r, payload); err != nil {
			return Frame{}, err
		}
	}
	return Frame{Type: hdr[0], Payload: payload}, nil
}

// EncodeHello builds the payload for a HELLO frame.
func EncodeHello(mode Mode) []byte {
	return []byte{Version, byte(mode)}
}

// DecodeHello parses a HELLO payload.
func DecodeHello(payload []byte) (version uint8, mode Mode, err error) {
	if len(payload) != 2 {
		return 0, 0, fmt.Errorf("malformed HELLO payload: %d bytes", len(payload))
	}
	return payload[0], Mode(payload[1]), nil
}

// EncodeResize builds the payload for a RESIZE frame.
func EncodeResize(rows, cols uint16) []byte {
	buf := make([]byte, 4)
	binary.BigEndian.PutUint16(buf[0:2], rows)
	binary.BigEndian.PutUint16(buf[2:4], cols)
	return buf
}

// DecodeResize parses a RESIZE payload.
func DecodeResize(payload []byte) (rows, cols uint16, err error) {
	if len(payload) != 4 {
		return 0, 0, fmt.Errorf("malformed RESIZE payload: %d bytes", len(payload))
	}
	return binary.BigEndian.Uint16(payload[0:2]), binary.BigEndian.Uint16(payload[2:4]), nil
}

// EncodeExit builds the payload for an EXIT frame.
func EncodeExit(code int32) []byte {
	buf := make([]byte, 4)
	binary.BigEndian.PutUint32(buf, uint32(code))
	return buf
}

// DecodeExit parses an EXIT payload.
func DecodeExit(payload []byte) (int32, error) {
	if len(payload) != 4 {
		return 0, fmt.Errorf("malformed EXIT payload: %d bytes", len(payload))
	}
	return int32(binary.BigEndian.Uint32(payload)), nil
}

// EncodeError builds the payload for an ERROR frame. It is a single UTF-8
// string message shown verbatim to the user.
func EncodeError(msg string) []byte { return []byte(msg) }
