/**
 * Loadable<T> — the standard state primitive for every control-tab slice.
 *
 * Each list/detail tab (agents, cron, skills, channels, nodes, etc.) holds
 * its data as a Loadable so the UI can render idle / loading / ready / error
 * uniformly without every tab reinventing the status-machine.
 *
 * `stale` is a soft flag used on reconnect: we keep the last-known data on
 * screen but dim it and show a "Refreshing..." badge while the bootstrap
 * re-fetch runs. This matches the "don't lose context on reconnect" property
 * the chat surface already has (messages stay committed through a WS drop).
 *
 * Tiny on purpose — no observability hooks, no invalidation timers. Tabs
 * manage refetch cadence via useEffect on pathname / tab-focus.
 */
export type Loadable<T> =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; data: T; loadedAt: number; stale?: boolean }
  | { kind: "error"; message: string };

export const Loadable = {
  idle<T>(): Loadable<T> {
    return { kind: "idle" };
  },
  loading<T>(): Loadable<T> {
    return { kind: "loading" };
  },
  ready<T>(data: T): Loadable<T> {
    return { kind: "ready", data, loadedAt: Date.now() };
  },
  error<T>(message: string): Loadable<T> {
    return { kind: "error", message };
  },
  /** Mark a previously-ready Loadable as stale (data still rendered, but UI
   *  should show a refreshing badge). No-op for idle/loading/error. */
  stale<T>(prev: Loadable<T>): Loadable<T> {
    return prev.kind === "ready" ? { ...prev, stale: true } : prev;
  },
  isReady<T>(v: Loadable<T>): v is { kind: "ready"; data: T; loadedAt: number; stale?: boolean } {
    return v.kind === "ready";
  },
  /** Extract data or null. Useful for `Loadable.data(x) ?? fallback`. */
  data<T>(v: Loadable<T>): T | null {
    return v.kind === "ready" ? v.data : null;
  },
} as const;
