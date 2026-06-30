"use client";

import { useEffect } from "react";
import { useAppStore } from "@/lib/app/store";
import { SidebarProvider } from "@/components/basecamp/sidebar-context";
import { AppSidebar } from "./app-sidebar";
import { AppTopbar } from "./app-topbar";
import { AppActiveTeam } from "./app-active-team";
import { AppCommandCenter } from "./app-command-center";
import { ChatThread } from "./chat-thread";
import { ChatContextMenu } from "./chat-context-menu";
import { ChatComposer } from "./chat-composer";
import { ChatWorkspaceHeader } from "./chat-workspace-header";
import { ConnectionBanner } from "./connection-banner";

// Basecamp-verbatim 3-column layout: left sidebar · main (topbar + center) ·
// right-rail Active Team. Empty sessions swap the main column for the
// Command Center hero; first user turn flips to <ChatThread /> +
// <ChatComposer />.

export function ChatShell() {
  const messages = useAppStore((s) => s.messages[s.activeSessionKey]);
  const streaming = useAppStore(
    (s) => s.streaming[s.activeSessionKey] ?? null,
  );
  const sending = useAppStore(
    (s) => s.sending[s.activeSessionKey] ?? false,
  );
  const errorMsg = useAppStore(
    (s) => s.errors[s.activeSessionKey] ?? null,
  );
  const loadingHistory = useAppStore(
    (s) => s.loadingHistory[s.activeSessionKey] ?? false,
  );

  // ────────── global keyboard shortcuts ──────────
  // Ctrl/Cmd+K → Thread baru. Esc → abort in-flight stream OR dismiss the
  // mobile sidebar (priority: abort wins when something is streaming).
  //
  // Read the store via `getState()` inside the handler so the listener
  // stays mounted once and reads the freshest state on each press — the
  // effect has an empty deps array, which would otherwise capture stale
  // closures.
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      // Ctrl/Cmd+K. Skip when the user is composing IME text so Asian
      // input methods don't swallow the chord mid-composition.
      if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey) {
        const k = ev.key.toLowerCase();
        if (k === "k" && !ev.repeat && !ev.isComposing) {
          ev.preventDefault();
          const s = useAppStore.getState();
          // No-op if still connecting — gateway rejects RPCs pre-ready.
          if (s.status !== "ready") return;
          void s.createSession();
          return;
        }
      }

      if (ev.key === "Escape" && !ev.isComposing) {
        const s = useAppStore.getState();
        const key = s.activeSessionKey;
        const busy = Boolean(s.streaming[key]) || Boolean(s.sending[key]);
        if (busy) {
          ev.preventDefault();
          void s.abortActive(key);
          return;
        }
        if (s.sidebarOpen) {
          ev.preventDefault();
          s.setSidebarOpen(false);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const count = messages?.length ?? 0;
  // Show Command Center when the active session has NO activity at all —
  // no committed messages, no in-flight stream, no pending send, no error
  // banner, and we're not still hydrating history from the gateway.
  const isEmpty =
    count === 0 &&
    !streaming &&
    !sending &&
    !errorMsg &&
    !loadingHistory;

  return (
    <SidebarProvider>
      <div className="flex h-screen text-white">
        <AppSidebar />

        <div className="flex min-w-0 flex-1 flex-col">
          <AppTopbar />
          <ConnectionBanner />

          <main className="relative flex min-h-0 flex-1 gap-4 px-4 pt-4 xl:px-6">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/[0.06] bg-[#0B0E14]/40 backdrop-blur-xl">
              {isEmpty ? (
                <AppCommandCenter />
              ) : (
                <>
                  <ChatWorkspaceHeader />
                  <ChatContextMenu>
                    <div className="min-h-0 flex-1 overflow-hidden">
                      <ChatThread />
                    </div>
                  </ChatContextMenu>
                  <footer className="shrink-0 border-t border-white/[0.06] bg-[#0B0E14]/60 backdrop-blur-xl">
                    <ChatComposer />
                  </footer>
                </>
              )}
            </div>

            <AppActiveTeam />
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}
