"use client";

/**
 * Per-tab ErrorBoundary. Crash in one tab must NEVER tear down the shell —
 * the user should be able to navigate away and still see nav, session list,
 * connection status, and approvals banner.
 *
 * Class component because React hooks don't expose componentDidCatch. Tiny
 * on purpose: log to console + render a dismissible inline panel with "Coba
 * lagi" that resets the boundary.
 */
import { Component, type ReactNode } from "react";

type Props = {
  tabId: string;
  children: ReactNode;
};

type State = {
  error: Error | null;
  nonce: number;
};

export class TabErrorBoundary extends Component<Props, State> {
  state: State = { error: null, nonce: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // eslint-disable-next-line no-console
    console.error(`[app tab ${this.props.tabId}] crashed`, error, info);
  }

  reset = () => this.setState((s) => ({ error: null, nonce: s.nonce + 1 }));

  render() {
    if (this.state.error) {
      return (
        <div className="m-4 rounded-xl border border-red-500/40 bg-red-500/10 p-5 text-red-100 backdrop-blur-xl">
          <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-red-300/80">
            tab crash · {this.props.tabId}
          </div>
          <div className="mt-2 text-sm font-semibold text-white/90">
            Tab ini error
          </div>
          <div className="mt-1 whitespace-pre-wrap text-xs text-red-200/80">
            {this.state.error.message}
          </div>
          <button
            type="button"
            onClick={this.reset}
            className="mt-4 rounded-md border border-red-500/50 bg-red-500/20 px-3 py-1.5 text-xs font-semibold text-red-50 hover:bg-red-500/30"
          >
            Coba lagi
          </button>
        </div>
      );
    }
    return (
      <div key={this.state.nonce} className="h-full">
        {this.props.children}
      </div>
    );
  }
}
