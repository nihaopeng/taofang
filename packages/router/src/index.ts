/**
 * `@starvalley/router` — server transport adapters.
 *
 * Binds Protocol contracts to `node:http` and calls typed Manager APIs. See
 * AGENTS.md for the layer boundary.
 */

export { createRequestListener } from './create-request-listener.ts';
export type { ResolveActorId, RouterDependencies } from './create-request-listener.ts';

export { mapErrorCodeToStatus, protocolErrorBody } from './http-errors.ts';

export { ROUTES, allowedMethods, findRoute, isKnownPath } from './routes.ts';
export type { RouteContext, RouteDefinition, RouteResponse } from './routes.ts';
