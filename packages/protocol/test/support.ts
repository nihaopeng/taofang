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
  protocolVersion: 3,
  serverTime: '2025-01-02T03:04:05.000Z',
};

export const validTransform = { x: 3, y: 4 };

export const validEntityState = {
  entityId: 'entity-1',
  actorId: 'actor-1',
  kind: 'character',
  transform: validTransform,
  visible: true,
};

export const validWorldSnapshot = {
  size: { width: 20, height: 15 },
  entities: [validEntityState],
  controlledActorId: 'actor-1',
  serverTime: '2025-01-02T03:04:05.000Z',
};

export const validActorMoveCommand = { type: 'actor.move', direction: 'north' };

export const validEntitySpawnedEvent = {
  type: 'entity.spawned',
  entity: validEntityState,
};

export const validEntityRemovedEvent = {
  type: 'entity.removed',
  entityId: 'entity-1',
};

export const validTransformChangedEvent = {
  type: 'transform.changed',
  entityId: 'entity-1',
  transform: validTransform,
};

export const validSubmitCommandResponse = {
  events: [validTransformChangedEvent],
  serverTime: validWorldSnapshot.serverTime,
};
