/**
 * src/lib/hermes/types.ts
 *
 * Internal types for Hermes container provisioning + wire protocol envelopes.
 *
 * Mirrors `src/lib/openclaw/types.ts` shapes where they semantically align.
 * RPC payload types live separately in `rpc-types.ts` (the FROZEN contract
 * surface — touch with regression tests).
 */

// Status machine values for user_container.status — same as OpenClaw
// so dashboard widgets work for both engines during transition.
export type ContainerStatus =
  | "queued"
  | "starting"
  | "awaiting-health"
  | "running"
  | "failed"
  | "destroyed"
  | "stopped";

/**
 * Per-user container binding — what `provisionContainer` returns.
 */
export interface HermesContainerConfig {
  userId: string;
  containerName: string;
  port: number;
  /** Auth token consumed by the bridge WebSocket on connect handshake. */
  bridgeToken: string;
  /** Optional: filesystem path or named-volume identifier in Docker. */
  volumePath: string;
  /** Docker image tag the container was created from. */
  imageVersion: string;
}

/**
 * Outcome of a single port allocation request.
 */
export interface PortClaim {
  port: number;
  /** True if this caller just claimed it; false if it was already theirs. */
  isNew: boolean;
}

// ---------------------------------------------------------------------
// Wire frame envelopes — what flows over the WebSocket between portal
// browser and bridge inside container. Mirrors OpenClaw frame shape
// because the bridge speaks the same protocol on its outward face.
// ---------------------------------------------------------------------

export type RpcFrame = RpcRequestFrame | RpcResponseFrame | RpcEventFrame;

export interface RpcRequestFrame<P = unknown> {
  type: "req";
  id: string;
  method: string;
  params?: P;
}

export interface RpcResponseFrame<R = unknown> {
  type: "res";
  id: string;
  ok: boolean;
  payload?: R;
  error?: { code: string; message: string; details?: unknown };
}

export interface RpcEventFrame<P = unknown> {
  type: "event";
  event: string;
  payload?: P;
}

// ---------------------------------------------------------------------
// Error shape carried over the wire — consumed by store classifier
// ---------------------------------------------------------------------

export interface RpcErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}
