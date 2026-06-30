"use client";

/**
 * Custom right-click context menu untuk chat area.
 *
 * Ported pattern from Hermes Desktop (Reff/UI HERMES/.../Chat.tsx:118-137)
 * which uses Electron native context menu. Web-context can't use native
 * menus, so we render a custom React menu positioned at cursor.
 *
 * Items:
 *   - 📋 Salin pesan ini        (kalau cursor di atas bubble dengan
 *                                data-message-id)
 *   - 📄 Salin seluruh chat (Markdown)  (semua pesan formatted markdown)
 *   - 📝 Salin seluruh chat (Plain text)
 *   - 🔍 Pilih teks pesan ini   (selectAllChildren bubble di bawah cursor)
 *
 * Behavior:
 *   - Right-click anywhere in chat-thread → menu appears at cursor
 *   - Click outside or Esc → menu closes
 *   - Click item → action + close
 *
 * Detects "active bubble" via `document.elementFromPoint` looking for
 * the closest `[data-message-id]` ancestor. If found, "Salin pesan ini"
 * + "Pilih teks pesan ini" become available; otherwise they're hidden.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Copy, FileText, FileJson, MousePointer2 } from "lucide-react";
import { useAppStore, type ChatMessage } from "@/lib/app/store";
import { cn } from "@/lib/utils";

/** State of an open context menu — position in viewport coords + the
 *  message ID that was right-clicked (null if right-click was on empty
 *  chat area). */
type MenuState = {
  x: number;
  y: number;
  messageId: string | null;
} | null;

/** Build a markdown transcript of the active session. */
function buildTranscript(messages: ChatMessage[], format: "markdown" | "text"): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.kind === "tool") continue;
    const speaker =
      m.role === "user"
        ? "Chief"
        : m.role === "assistant"
          ? "Buff"
          : "System";
    const text = (m.content || "").trim();
    if (!text) continue;
    if (format === "markdown") {
      lines.push(`**${speaker}:** ${text}`, "");
    } else {
      lines.push(`${speaker}: ${text}`, "");
    }
  }
  return lines.join("\n").trim();
}

async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API blocked — fall back to legacy execCommand.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

export function ChatContextMenu({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<MenuState>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const messages = useAppStore(
    (s) => s.messages[s.activeSessionKey] ?? EMPTY_MESSAGES,
  );

  const handleContextMenu = useCallback((e: MouseEvent) => {
    // Don't override the native menu inside input fields (textarea,
    // input) — user might want browser-native copy/paste/spellcheck
    // affordances there.
    const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
    if (tag === "textarea" || tag === "input") return;
    e.preventDefault();
    // Walk up the DOM from the click target looking for the nearest
    // `[data-message-id]` ancestor. That's the bubble the chief clicked.
    let el: HTMLElement | null = e.target as HTMLElement;
    let messageId: string | null = null;
    while (el) {
      const id = el.getAttribute("data-message-id");
      if (id) {
        messageId = id;
        break;
      }
      el = el.parentElement;
    }
    setMenu({ x: e.clientX, y: e.clientY, messageId });
  }, []);

  // Outside click + Esc close.
  useEffect(() => {
    if (!menu) return;
    function onDoc(e: globalThis.MouseEvent) {
      const target = e.target as Node | null;
      if (!target || !menuRef.current) return;
      if (!menuRef.current.contains(target)) setMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenu(null);
    }
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const handleCopyMessage = useCallback(async () => {
    if (!menu?.messageId) return;
    const msg = messages.find((m) => m.id === menu.messageId);
    if (msg) await copyText(msg.content);
    setMenu(null);
  }, [menu, messages]);

  const handleCopyChatMd = useCallback(async () => {
    await copyText(buildTranscript(messages, "markdown"));
    setMenu(null);
  }, [messages]);

  const handleCopyChatText = useCallback(async () => {
    await copyText(buildTranscript(messages, "text"));
    setMenu(null);
  }, [messages]);

  const handleSelectMessage = useCallback(() => {
    if (!menu?.messageId) return;
    const el = document.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(menu.messageId)}"]`,
    );
    if (el && typeof window !== "undefined") {
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.addRange(range);
      }
    }
    setMenu(null);
  }, [menu]);

  // Clamp menu within viewport — avoid clipping off the right/bottom edge.
  const clampedPos =
    menu === null
      ? { x: 0, y: 0 }
      : {
          x: Math.min(menu.x, window.innerWidth - 240),
          y: Math.min(menu.y, window.innerHeight - 200),
        };

  return (
    <div
      onContextMenu={handleContextMenu}
      className="flex h-full min-h-0 flex-1 flex-col"
    >
      {children}
      {menu ? (
        <div
          ref={menuRef}
          role="menu"
          style={{ left: clampedPos.x, top: clampedPos.y }}
          className="fixed z-[200] flex min-w-[220px] flex-col gap-0.5 rounded-lg border border-white/[0.08] bg-[#0B0E14]/97 p-1 shadow-[0_12px_32px_rgba(0,0,0,0.6)] backdrop-blur-md"
        >
          {menu.messageId ? (
            <MenuItem
              icon={<Copy className="size-3.5" />}
              label="Salin pesan ini"
              onClick={handleCopyMessage}
            />
          ) : null}
          {menu.messageId ? (
            <MenuItem
              icon={<MousePointer2 className="size-3.5" />}
              label="Pilih teks pesan ini"
              onClick={handleSelectMessage}
            />
          ) : null}
          {menu.messageId ? <Divider /> : null}
          <MenuItem
            icon={<FileText className="size-3.5" />}
            label="Salin seluruh chat (Markdown)"
            onClick={handleCopyChatMd}
          />
          <MenuItem
            icon={<FileJson className="size-3.5" />}
            label="Salin seluruh chat (Plain text)"
            onClick={handleCopyChatText}
          />
        </div>
      ) : null}
    </div>
  );
}

const EMPTY_MESSAGES: ChatMessage[] = [];

function MenuItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[12px] font-medium text-white/85 transition",
        "hover:bg-white/[0.08]",
      )}
    >
      <span className="inline-flex size-3.5 shrink-0 items-center justify-center text-white/65">
        {icon}
      </span>
      <span className="flex-1">{label}</span>
    </button>
  );
}

function Divider() {
  return <div className="my-0.5 h-px bg-white/[0.06]" />;
}
