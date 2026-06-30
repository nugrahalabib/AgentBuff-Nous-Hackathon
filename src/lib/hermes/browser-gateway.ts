/**
 * Browser-side gateway client. Mirrors the wire API surface of OpenClaw's
 * Control UI `GatewayBrowserClient` (request + event + reconnection) but talks
 * to the portal's WS proxy instead of the upstream gateway directly.
 *
 * The browser never sees the upstream host, port, or gateway token — the
 * proxy injects those server-side. The ONLY visible difference vs. the Control
 * UI client is: no device pairing and no `connect` RPC (proxy handles both).
 * Instead, the proxy emits a synthetic `proxy.ready` event when the upstream
 * handshake is complete; `waitReady()` resolves on that.
 */

export type GatewayEvent = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
};

export type GatewayResponse = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
    retryable?: boolean;
    retryAfterMs?: number;
  };
};

export class GatewayError extends Error {
  readonly code: string;
  readonly details?: unknown;
  constructor(error: { code: string; message: string; details?: unknown }) {
    super(error.message);
    this.name = "GatewayError";
    this.code = error.code;
    this.details = error.details;
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
};

export type GatewayClientOptions = {
  url?: string;
  onEvent?: (evt: GatewayEvent) => void;
  onOpen?: () => void;
  onClose?: (info: { code: number; reason: string }) => void;
  onReady?: (payload: unknown) => void;
};

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private eventHandlers = new Set<(evt: GatewayEvent) => void>();
  private readyResolvers: Array<() => void> = [];
  private ready = false;
  private closed = false;
  private backoffMs = 800;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private url: string;

  constructor(private opts: GatewayClientOptions = {}) {
    this.url = opts.url ?? this.defaultUrl();
    if (opts.onEvent) this.eventHandlers.add(opts.onEvent);
  }

  private defaultUrl(): string {
    if (typeof window === "undefined") return "";
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/api/ws/hermes`;
  }

  start(): void {
    if (this.closed) this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    this.clearReconnectTimer();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.ready = false;
    this.flushPending(new Error("gateway stopped"));
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get isReady(): boolean {
    return this.ready && this.isConnected;
  }

  onEvent(handler: (evt: GatewayEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  waitReady(timeoutMs = 10_000): Promise<void> {
    if (this.ready && this.isConnected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.readyResolvers = this.readyResolvers.filter((r) => r !== done);
        reject(new Error(`gateway not ready after ${timeoutMs}ms`));
      }, timeoutMs);
      const done = () => {
        clearTimeout(t);
        resolve();
      };
      this.readyResolvers.push(done);
    });
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.ready) {
      await this.waitReady();
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("gateway not connected");
    }
    const id = crypto.randomUUID();
    const frame = { type: "req", id, method, params };
    const p = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject });
    });
    this.ws.send(JSON.stringify(frame));
    return p;
  }

  /**
   * Make a request and receive event-frame deltas that the gateway streams
   * while the request is in-flight. The final `res` frame fulfills the
   * returned promise with the response payload.
   *
   * Event filter matches by `event` string prefix so callers don't need to
   * worry about correlation ids (OpenClaw streams chat/session deltas via
   * global events tagged with the current session/request).
   */
  async stream<T = unknown>(
    method: string,
    params: unknown,
    onDelta: (evt: GatewayEvent) => void,
  ): Promise<T> {
    const off = this.onEvent(onDelta);
    try {
      return await this.request<T>(method, params);
    } finally {
      off();
    }
  }

  private connect() {
    if (this.closed) return;
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener("open", () => {
      this.opts.onOpen?.();
    });
    this.ws.addEventListener("message", (ev) => {
      this.handleMessage(typeof ev.data === "string" ? ev.data : String(ev.data ?? ""));
    });
    this.ws.addEventListener("close", (ev) => {
      const reason = ev.reason ?? "";
      this.ws = null;
      this.ready = false;
      this.flushPending(new Error(`gateway closed (${ev.code}): ${reason}`));
      this.opts.onClose?.({ code: ev.code, reason });
      if (!this.closed) this.scheduleReconnect();
    });
    this.ws.addEventListener("error", () => {
      // close handler will handle cleanup
    });
  }

  private handleMessage(raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const frame = parsed as { type?: unknown };
    if (frame.type === "event") {
      const evt = parsed as GatewayEvent;
      if (evt.event === "proxy.ready") {
        this.ready = true;
        this.backoffMs = 800;
        this.opts.onReady?.(evt.payload);
        const resolvers = this.readyResolvers;
        this.readyResolvers = [];
        for (const r of resolvers) r();
        return;
      }
      for (const h of this.eventHandlers) {
        try {
          h(evt);
        } catch (err) {
          console.error("[gateway] event handler error:", err);
        }
      }
      return;
    }

    if (frame.type === "res") {
      const res = parsed as GatewayResponse;
      const p = this.pending.get(res.id);
      if (!p) return;
      this.pending.delete(res.id);
      if (res.ok) {
        p.resolve(res.payload);
      } else {
        p.reject(
          new GatewayError({
            code: res.error?.code ?? "UNAVAILABLE",
            message: res.error?.message ?? "request failed",
            details: res.error?.details,
          }),
        );
      }
    }
  }

  private scheduleReconnect() {
    if (this.closed) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 1.7, 15_000);
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private flushPending(err: Error) {
    for (const [, p] of this.pending) {
      p.reject(err);
    }
    this.pending.clear();
  }
}
