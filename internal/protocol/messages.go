// Package protocol implements the psess client/daemon wire protocol.
//
// The protocol is intentionally minimal: a 1-byte type followed by a 4-byte
// big-endian payload length and the raw payload. No JSON, gRPC or other
// heavyweight encoding is used, because the payloads are mostly opaque PTY
// byte streams.
package protocol

// Version is the current protocol version.
const Version uint8 = 1

// Message types exchanged between client and daemon.
const (
	TypeHello       uint8 = 0x01 // client -> daemon
	TypeHelloOK     uint8 = 0x02 // daemon -> client
	TypeStdin       uint8 = 0x10 // client -> daemon
	TypeStdout      uint8 = 0x11 // daemon -> client
	TypeResize      uint8 = 0x20 // client -> daemon
	TypeDetach      uint8 = 0x30 // client -> daemon
	TypeSessionInfo uint8 = 0x40 // daemon -> client
	TypeExit        uint8 = 0x41 // daemon -> client
	TypeRequestLog  uint8 = 0x50 // client -> daemon
	TypeLogData     uint8 = 0x51 // daemon -> client
	TypeKill        uint8 = 0x52 // client -> daemon (payload: 1 byte force flag)
	TypeError       uint8 = 0x60 // daemon -> client
)

// Mode describes why a client is connecting.
type Mode uint8

// Supported connection modes.
const (
	ModeAttach         Mode = 0 // interactive attach, no history replay
	ModeAttachWithTail Mode = 1 // interactive attach, replay ring buffer first
	ModeStatus         Mode = 2 // one-shot status query
	ModeLog            Mode = 3 // one-shot ring buffer dump
	ModeKill           Mode = 4 // terminate the session
)

// String renders a mode for logs and error messages.
func (m Mode) String() string {
	switch m {
	case ModeAttach:
		return "attach"
	case ModeAttachWithTail:
		return "attach-tail"
	case ModeStatus:
		return "status"
	case ModeLog:
		return "log"
	case ModeKill:
		return "kill"
	default:
		return "unknown"
	}
}

// MaxPayload bounds a single frame payload to protect against corrupt or
// malicious length prefixes. 16 MiB is far above any legitimate PTY chunk.
const MaxPayload = 16 << 20
