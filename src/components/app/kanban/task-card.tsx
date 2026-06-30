"use client";

import { useState } from "react";
import { MoreHorizontal, GripVertical, Bot, MessageSquare, Cpu } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type KanbanTask,
  type KanbanAction,
  allowedActions,
  ACTION_LABEL,
  priorityMeta,
  relativeTime,
  statusMeta,
} from "./helpers";

export function TaskCard({
  task,
  busy,
  selected,
  onToggleSelect,
  onOpen,
  onAction,
  onDragStart,
  onDragEnd,
}: {
  task: KanbanTask;
  busy?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
  onOpen: (task: KanbanTask) => void;
  onAction: (task: KanbanTask, action: KanbanAction) => void;
  onDragStart: (task: KanbanTask) => void;
  onDragEnd: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const prio = priorityMeta(task.priority);
  const meta = statusMeta(task.status);
  const actions = allowedActions(task.status);

  return (
    <div
      draggable={!busy}
      role="button"
      tabIndex={0}
      aria-label={`Buka tugas: ${task.title}`}
      onKeyDown={(e) => {
        // Only the card itself opens on Enter/Space — keys from the inner
        // checkbox/menu button (which bubble) must not also open the drawer.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(task);
        }
      }}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", task.id);
        onDragStart(task);
      }}
      onDragEnd={onDragEnd}
      className={cn(
        "group/card relative cursor-pointer rounded-xl border bg-[#0B0E14]/80 p-3 backdrop-blur-sm transition",
        "border-white/[0.08] hover:border-cyan-400/30 hover:bg-white/[0.04]",
        "focus-visible:border-cyan-400/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/40",
        meta.live && "border-emerald-400/25",
        selected && "border-cyan-400/60 bg-cyan-400/[0.06]",
        busy && "opacity-60",
      )}
      onClick={() => onOpen(task)}
    >
      {onToggleSelect ? (
        <input
          type="checkbox"
          checked={!!selected}
          aria-label={`Pilih tugas: ${task.title}`}
          onClick={(e) => e.stopPropagation()}
          onChange={() => onToggleSelect(task.id)}
          className={cn(
            "absolute left-2 top-2 z-10 size-3.5 accent-cyan-400 transition focus-visible:opacity-100",
            selected ? "opacity-100" : "opacity-0 group-hover/card:opacity-100",
          )}
        />
      ) : null}
      {meta.live ? (
        <>
          <span className="absolute right-3 top-3 flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.18em] text-emerald-300/90">
            <span className="size-1.5 animate-pulse rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]" />
            kerja
          </span>
          {/* Minimalist indeterminate progress — signals the agent is working. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] overflow-hidden rounded-b-xl bg-emerald-400/10">
            <div className="agentbuff-shimmer-sweep h-full w-1/3 bg-gradient-to-r from-transparent via-emerald-400 to-transparent" />
          </div>
        </>
      ) : null}

      <div className="flex items-start gap-2">
        <GripVertical className="mt-0.5 size-3.5 shrink-0 text-white/20 transition group-hover/card:text-white/40" />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 pr-5 text-sm font-medium text-white/90">
            {task.title}
          </p>
          {task.body ? (
            <p className="mt-1 line-clamp-2 text-xs text-white/45">{task.body}</p>
          ) : null}
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pl-5">
        {prio ? (
          <span
            className={cn(
              "rounded-full border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide",
              prio.cls,
            )}
          >
            {prio.label}
          </span>
        ) : null}
        {task.assignee ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-white/60">
            <Bot className="size-3 text-cyan-300/80" />
            {task.assignee}
          </span>
        ) : null}
        {task.model_override ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-white/50">
            <Cpu className="size-3 text-indigo-300/80" />
            {task.model_override}
          </span>
        ) : null}
        {task.session_id ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-white/40">
            <MessageSquare className="size-3 text-fuchsia-300/70" />
            sesi
          </span>
        ) : null}
      </div>

      <div className="mt-2 flex items-center justify-between pl-5">
        <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-white/30">
          {relativeTime(task.created_at)}
        </span>
        <div className="relative">
          <button
            type="button"
            aria-label="Aksi tugas"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            className="rounded-md p-1 text-white/40 opacity-0 transition hover:bg-white/[0.06] hover:text-white/80 focus-visible:opacity-100 group-hover/card:opacity-100"
          >
            <MoreHorizontal className="size-4" />
          </button>
          {menuOpen ? (
            <>
              <div
                className="fixed inset-0 z-20"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                }}
              />
              <div
                className="absolute right-0 z-30 mt-1 w-44 overflow-hidden rounded-lg border border-white/10 bg-[#0B0E14] py-1 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                {actions.map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      onAction(task, a);
                    }}
                    className={cn(
                      "block w-full px-3 py-1.5 text-left text-xs transition hover:bg-white/[0.06]",
                      a === "delete" ? "text-red-300" : "text-white/75",
                    )}
                  >
                    {ACTION_LABEL[a]}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
