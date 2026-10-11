import { ProtocolParseError } from '../src/index.ts';

/** Run `fn`, asserting it throws `ProtocolParseError`, and return the error. */
export function captureParseError(fn: () => unknown): ProtocolParseError {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (!(thrown instanceof ProtocolParseError)) {
    throw new Error('expected fn to throw a ProtocolParseError');
  }
  return thrown;
}

export const validGameInfo = {
  gameName: 'Starvalley',
  serverVersion: '0.1.0',
  protocolVersion: 1,
  serverTime: '2025-01-02T03:04:05.000Z',
};
