"use client";

/**
 * Chat tab — workspace column (chat thread + composer + active-team right
 * rail). Session history sidebar lives in AppShell's <ChatSubSidebar />,
 * NOT here — rendering one here too just duplicates the THREADS column.
 *
 * Banners:
 *   - ConnectionBanner    → top, status reconnecting/closed
 *   - ErrorBanner         → above composer, errors[activeKey] non-null
 *
 * Keyboard shortcuts:
 *   - Ctrl/Cmd+K → createSession() (new thread)
 *   - Esc        → abortActive() while streaming
 */
import { useCallback, useEffect } from "react";
import { useAppStore } from "@/lib/app/store";
import { AppActiveTeam } from "@/components/app/app-active-team";
import { AppCommandCenter } from "@/components/app/app-command-center";
import { ChatThread } from "@/components/app/chat-thread";
import { ChatComposer } from "@/components/app/chat-composer";
import { ChatWorkspaceHeader } from "@/components/app/chat-workspace-header";
import { ConnectionBanner } from "@/components/app/connection-banner";
import { ErrorBanner } from "@/components/app/error-banner";

export function ChatTab() {
  const messages = useAppStore((s) => s.messages[s.activeSessionKey]);
  // PERF-1: subscribe to the BOOLEAN, not the streaming object. The object's
  // identity changes on every ~150ms delta; ChatTab only needs "is a stream
  // active" (for isEmpty). Subscribing to the object re-rendered ChatTab +
  // its unmemoized children (composer/header) on every delta. ChatThread keeps
  // its own full-object subscription for the live bubble.
  const isStreaming = useAppStore(
    (s) => Boolean(s.streaming[s.activeSessionKey]),
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
  const clearError = useAppStore((s) => s.clearError);
  const activeKey = useAppStore((s) => s.activeSessionKey);

  const dismissError = useCallback(() => {
    clearError(activeKey);
  }, [clearError, activeKey]);

  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey) {
        const k = ev.key.toLowerCase();
        if (k === "k" && !ev.repeat && !ev.isComposing) {
          ev.preventDefault();
          const s = useAppStore.getState();
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
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const count = messages?.length ?? 0;
  const isEmpty =
    count === 0 && !isStreaming && !sending && !errorMsg && !loadingHistory;

  return (
    <div className="relative flex h-full min-h-0 gap-4 px-4 pt-4 xl:px-6">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/[0.06] bg-[#0B0E14]/40 backdrop-blur-xl">
        <ConnectionBanner />
        {isEmpty ? (
          // Flex column so AppCommandCenter's root (`flex-1 justify-center`)
          // actually stretches to the panel's full height and centers the
          // hero vertically — in a plain block wrapper its height collapses
          // to content and the hero hugs the top. overflow-y-auto keeps
          // short viewports scrollable instead of clipping.
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <AppCommandCenter />
          </div>
        ) : (
          <>
            <ChatWorkspaceHeader />
            <div className="min-h-0 flex-1 overflow-hidden">
              <ChatThread />
            </div>
            <footer className="shrink-0 border-t border-white/[0.06] bg-[#0B0E14]/60 backdrop-blur-xl">
              {errorMsg ? (
                <div className="px-4 pt-3">
                  <ErrorBanner
                    message={errorMsg}
                    onDismiss={dismissError}
                  />
                </div>
              ) : null}
              <ChatComposer />
            </footer>
          </>
        )}
      </div>
      <AppActiveTeam />
    </div>
  );
}
