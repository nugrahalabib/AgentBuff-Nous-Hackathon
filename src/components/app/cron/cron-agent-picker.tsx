"use client";

/**
 * CronAgentPicker — dropdown pilih agen dari `agents.list` (engine RPC),
 * bukan free-text input. User gak perlu hafal agentId.
 *
 * Includes "(Default)" option at top yang map ke value = undefined (engine
 * fallback ke defaultId). Plus "Custom..." escape hatch untuk power user
 * yang punya agent yang belum terdaftar di config.
 */
import { Bot, Check, ChevronDown, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  formatAgentLabel,
  useAgentsList,
} from "@/components/app/channels/use-agents-list";

export function CronAgentPicker({
  value,
  onChange,
}: {
  /** Selected agentId; empty string = default. */
  value: string;
  onChange: (next: string) => void;
}) {
  const { data, isLoading } = useAgentsList();
  const [open, setOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState("");
  const [mode, setMode] = useState<"list" | "custom">("list");
  const containerRef = useRef<HTMLDivElement>(null);

  const agents = data?.agents ?? [];
  const defaultId = data?.defaultId ?? "main";

  // Click outside to close
  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () =>
      document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const inCommonList = !value || agents.some((a) => a.id === value);
  const displayLabel = !value
    ? `Default (${defaultId})`
    : (() => {
        const found = agents.find((a) => a.id === value);
        if (found) return formatAgentLabel(found, found.id === defaultId);
        return `Custom: ${value}`;
      })();

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          setMode(inCommonList ? "list" : "custom");
          setCustomDraft(value);
        }}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-lg border bg-white/[0.03] px-3 py-2 text-left transition",
          open
            ? "border-cyan-400/50 ring-2 ring-cyan-400/20"
            : "border-white/10 hover:border-white/25",
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <Bot className="size-4 shrink-0 text-cyan-300/85" aria-hidden />
          <span className="truncate text-[13px] font-semibold text-white/95">
            {displayLabel}
          </span>
        </div>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-white/55 transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>

      {open ? (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-white/10 bg-[#0B0E14] shadow-[0_20px_48px_-12px_rgba(0,0,0,0.7)]">
          {mode === "list" ? (
            <ListMode
              agents={agents}
              defaultId={defaultId}
              value={value}
              isLoading={isLoading}
              onPick={(v) => {
                onChange(v);
                setOpen(false);
              }}
              onSwitchCustom={() => {
                setMode("custom");
                setCustomDraft(value);
              }}
            />
          ) : (
            <CustomMode
              draft={customDraft}
              onDraft={setCustomDraft}
              onCancel={() => setMode("list")}
              onConfirm={() => {
                const v = customDraft.trim();
                onChange(v);
                setOpen(false);
                setMode("list");
              }}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

function ListMode({
  agents,
  defaultId,
  value,
  isLoading,
  onPick,
  onSwitchCustom,
}: {
  agents: { id: string; name?: string }[];
  defaultId: string;
  value: string;
  isLoading: boolean;
  onPick: (v: string) => void;
  onSwitchCustom: () => void;
}) {
  return (
    <div className="max-h-72 overflow-y-auto p-1">
      {/* Default option always at top */}
      <Row
        active={!value}
        onClick={() => onPick("")}
        title={`Default (${defaultId})`}
        hint="Engine pake agen default sesuai config"
      />
      {isLoading ? (
        <div className="px-3 py-3 text-center text-[12px] text-white/55">
          Memuat daftar agen...
        </div>
      ) : agents.length === 0 ? (
        <div className="px-3 py-3 text-center text-[12px] text-white/55">
          Belum ada agen terdaftar. Pake "Default".
        </div>
      ) : (
        <>
          <div className="my-1 border-t border-white/[0.06]" />
          {agents.map((a) => {
            const isDefault = a.id === defaultId;
            const label = a.name?.trim() || a.id;
            return (
              <Row
                key={a.id}
                active={value === a.id}
                onClick={() => onPick(a.id)}
                title={label + (isDefault ? "" : "")}
                hint={a.id}
                isDefault={isDefault}
              />
            );
          })}
        </>
      )}
      <div className="my-1 border-t border-white/[0.06]" />
      <button
        type="button"
        onClick={onSwitchCustom}
        className="flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-[12px] text-white/70 transition hover:bg-white/[0.04] hover:text-cyan-200"
      >
        <span>Custom agentId (advanced)…</span>
        <ChevronDown className="size-3 -rotate-90" aria-hidden />
      </button>
    </div>
  );
}

function Row({
  active,
  onClick,
  title,
  hint,
  isDefault,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  hint?: string;
  isDefault?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left transition",
        active
          ? "bg-cyan-400/15 text-cyan-100"
          : "text-white/85 hover:bg-white/[0.04]",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5 truncate text-[13px] font-semibold">
          {title}
          {isDefault ? (
            <span className="shrink-0 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-1.5 py-0 font-mono text-[9px] uppercase tracking-[0.16em] text-cyan-200">
              default
            </span>
          ) : null}
        </div>
        {hint ? (
          <div className="mt-0.5 truncate font-mono text-[10px] text-white/45">
            {hint}
          </div>
        ) : null}
      </div>
      {active ? (
        <Check className="size-4 shrink-0 text-cyan-300" aria-hidden />
      ) : null}
    </button>
  );
}

function CustomMode({
  draft,
  onDraft,
  onCancel,
  onConfirm,
}: {
  draft: string;
  onDraft: (v: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">
          Custom agentId
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="rounded p-1 text-white/55 hover:bg-white/[0.05] hover:text-white"
          aria-label="Tutup"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          placeholder="agent-id-spesifik"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onConfirm();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          className="flex-1 rounded-md border border-white/10 bg-black/40 px-3 py-1.5 font-mono text-[13px] text-white focus:border-cyan-400/50 focus:outline-none"
        />
        <button
          type="button"
          onClick={onConfirm}
          className="inline-flex items-center gap-1 rounded-md bg-gradient-to-r from-cyan-400 to-fuchsia-500 px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#0B0E14] hover:brightness-110"
        >
          Pakai
        </button>
      </div>
      <p className="mt-1.5 text-[10px] leading-snug text-white/45">
        Pakai opsi ini kalau punya agentId yang belum terdaftar di config.
      </p>
    </div>
  );
}
