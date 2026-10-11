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
  protocolVersion: 2,
  serverTime: '2025-01-02T03:04:05.000Z',
};

export const validPosition = { x: 3, y: 4 };

export const validActor = {
  actorId: 'actor-1',
  name: 'Alex',
  position: validPosition,
};

export const validWorldSnapshot = {
  size: { width: 20, height: 15 },
  actor: validActor,
  serverTime: '2025-01-02T03:04:05.000Z',
};

export const validMoveActorResult = {
  actor: validActor,
  moved: true,
  serverTime: '2025-01-02T03:04:05.000Z',
};
