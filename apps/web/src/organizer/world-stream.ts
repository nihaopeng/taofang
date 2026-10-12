/**
 * Transport adapter for the world state stream (`GET STREAM_PATH`, Server-Sent
 * Events).
 *
 * This is the only place in the client that knows about `EventSource`. The store
 * owns *when* to connect and the retry policy; this module owns *how* a stream
 * connection is created, behind an injectable factory so tests never touch a real
 * network.
 *
 * The stream is one-way (server -> client); movement intents already have a
 * reliable request/response channel (`world-api-client`). The server sends a
 * full `snapshot` first on every connection, then `events` batches, each as a
 * JSON-encoded `WorldStreamMessage` on the default SSE `message` event. The store
 * validates every frame with the canonical `parseWorldStreamMessage` guard.
 *
 * Nothing here is exported from `organizer/index.ts` except the test hooks.
 */

import { STREAM_PATH } from '@starvalley/protocol';

import { resolveApiUrl } from './transport';

/** The subset of the DOM `MessageEvent` the stream adapter reads. */
export interface StreamMessageEventLike {
  data: string;
}

/**
 * Minimal `EventSource` surface the store uses. Kept narrow so a test fake is a
 * plain object with `onopen`/`onerror`/`addEventListener`/`close`.
 */
export interface EventSourceLike {
  onopen: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  addEventListener(type: 'message', listener: (event: StreamMessageEventLike) => void): void;
  close(): void;
}

/** Injectable `EventSource` constructor. Receives the resolved stream URL. */
export type EventSourceFactory = (url: string) => EventSourceLike;

/**
 * Default factory backed by the global `EventSource` (when present). Resolved
 * lazily, never at module load, so importing this module on the server (SSR) is
 * safe; a missing implementation surfaces as a handled stream failure.
 */
function defaultEventSourceFactory(url: string): EventSourceLike {
  const ctor = (globalThis as { EventSource?: new (url: string) => unknown }).EventSource;
  if (typeof ctor !== 'function') {
    throw new Error('EventSource is not available in this environment.');
  }
  return new ctor(url) as EventSourceLike;
}

let factory: EventSourceFactory = defaultEventSourceFactory;

/** Inject an `EventSource` factory for tests. Internal/test-only. */
export function setWorldEventSource(next: EventSourceFactory): void {
  factory = next;
}

/** Restore the default (global) `EventSource` factory. Internal/test-only. */
export function resetWorldEventSource(): void {
  factory = defaultEventSourceFactory;
}

/** Origin-relative URL for the world stream endpoint. */
export function resolveStreamUrl(): string {
  return resolveApiUrl(STREAM_PATH);
}

/** Open a stream connection through the injected factory. */
export function createWorldEventSource(): EventSourceLike {
  return factory(resolveStreamUrl());
}
