"""kanban_handler.py — bridge access to the engine's agentic task board.

Anti-drift: imports the engine's own `hermes_cli.kanban_db` (SQLite-backed,
multi-board, agent-dispatched) directly, so /app's "Papan Tugas" mirrors the
engine /kanban page exactly. Read helpers here; mutations live alongside.

Status lifecycle (VALID_STATUSES): triage, todo, scheduled, ready, running,
blocked, review, done, archived. Transitions are SEMANTIC (agent-driven) — the
engine exposes promote/block/unblock/complete, not a free-form set-status.
"""

from __future__ import annotations

import dataclasses
import logging
from typing import Any, Optional

log = logging.getLogger("bridge.kanban")


def _K():
    from hermes_cli import kanban_db  # imported lazily so import errors are caught
    return kanban_db


def _scrub(text: Optional[str]) -> Optional[str]:
    """Strip engine brand (Hermes/etc) from engine-generated text before /app.

    Worker logs + run summaries are engine chrome; the chief mandates NO
    engine-brand vocabulary anywhere user-visible. User-authored fields
    (title/body/comments) are NOT scrubbed.
    """
    if not text:
        return text
    try:
        from hermes_multichannel_plugin.outbound_brand import scrub_outbound
        return scrub_outbound(text)
    except Exception:  # noqa: BLE001
        import re
        out = text
        for pat, rep in (
            (r"hermes-agent", "Buff"),
            (r"Hermes[- ]?Agent", "Buff"),
            (r"Hermes", "Buff"),
            (r"HERMES", "BUFF"),
            (r"hermes", "buff"),
            (r"Nous Research", "AgentBuff"),
            (r"OpenClaw", "AgentBuff"),
        ):
            out = re.sub(pat, rep, out)
        return out


def _ser(obj: Any) -> Any:
    """Serialize a kanban dataclass (Task/Comment/Event/Run) → plain dict."""
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return dataclasses.asdict(obj)
    return obj


def _scrub_task_dict(d: Any) -> Any:
    """Scrub engine-generated error text on a serialized task dict. Only
    last_failure_error is engine chrome (it comes from worker/subprocess
    failures and can carry the engine brand + internal paths); title/body are
    user-authored and left verbatim."""
    if isinstance(d, dict) and d.get("last_failure_error"):
        d["last_failure_error"] = _scrub(d["last_failure_error"])
    return d


def _scrub_event(ev: Any) -> Any:
    """Scrub all string values in a serialized lifecycle event. Events are
    engine-generated (no user prose), so scrubbing every string value is safe
    and covers brand/path leaks in event payloads (e.g. crashed/gave_up errors)."""
    if not isinstance(ev, dict):
        return ev
    out: dict[str, Any] = {}
    for k, v in ev.items():
        if isinstance(v, str):
            out[k] = _scrub(v)
        elif isinstance(v, dict):
            out[k] = {kk: (_scrub(vv) if isinstance(vv, str) else vv) for kk, vv in v.items()}
        else:
            out[k] = v
    return out


def list_boards() -> dict[str, Any]:
    try:
        K = _K()
        boards = K.list_boards(include_archived=False)
        current = ""
        try:
            current = K.get_current_board()
        except Exception:  # noqa: BLE001
            pass
        return {"boards": boards, "current": current}
    except Exception as e:  # noqa: BLE001
        return {"boards": [], "current": "", "error": _scrub(str(e))[:200]}


def list_tasks(board: Optional[str] = None, include_archived: bool = False) -> dict[str, Any]:
    try:
        K = _K()
        with K.connect_closing(board=board) as conn:
            tasks = K.list_tasks(conn, include_archived=include_archived, limit=1000)
            try:
                stats = K.board_stats(conn)
            except Exception:  # noqa: BLE001
                stats = {}
        return {
            "tasks": [_scrub_task_dict(_ser(t)) for t in tasks],
            "stats": stats,
            "statuses": sorted(K.VALID_STATUSES),
            "board": board or "",
        }
    except Exception as e:  # noqa: BLE001
        return {"tasks": [], "stats": {}, "statuses": [], "error": _scrub(str(e))[:200]}


def _task_summary(K, conn, tid: str) -> dict[str, Any]:
    t = K.get_task(conn, tid)
    if t is None:
        return {"id": tid, "title": tid, "status": "unknown"}
    return {"id": t.id, "title": t.title, "status": t.status, "assignee": t.assignee}


def task_detail(board: Optional[str], task_id: str) -> dict[str, Any]:
    try:
        K = _K()
        with K.connect_closing(board=board) as conn:
            t = K.get_task(conn, task_id)
            if t is None:
                return {"error": "Tugas tidak ditemukan"}
            comments, events, runs = [], [], []
            parents, children, notify = [], [], []
            try:
                comments = [_ser(c) for c in K.list_comments(conn, task_id)]
            except Exception:  # noqa: BLE001
                pass
            try:
                events = [_ser(e) for e in K.list_events(conn, task_id)]
            except Exception:  # noqa: BLE001
                pass
            try:
                runs = [_ser(r) for r in K.list_runs(conn, task_id=task_id)]
            except Exception:  # noqa: BLE001
                pass
            try:
                parents = [_task_summary(K, conn, p) for p in K.parent_ids(conn, task_id)]
            except Exception:  # noqa: BLE001
                pass
            try:
                children = [_task_summary(K, conn, c) for c in K.child_ids(conn, task_id)]
            except Exception:  # noqa: BLE001
                pass
            try:
                notify = K.list_notify_subs(conn, task_id)
            except Exception:  # noqa: BLE001
                pass
        worker_log = None
        try:
            worker_log = _scrub(K.read_worker_log(task_id, board=board))
        except Exception:  # noqa: BLE001
            pass
        for r in runs:
            if isinstance(r, dict):
                if r.get("summary"):
                    r["summary"] = _scrub(r["summary"])
                if r.get("error"):
                    r["error"] = _scrub(r["error"])
        return {
            "task": _scrub_task_dict(_ser(t)),
            "comments": comments,
            "events": [_scrub_event(e) for e in events],
            "runs": runs,
            "parents": parents,
            "children": children,
            "notify": notify,
            "workerLog": worker_log,
        }
    except Exception as e:  # noqa: BLE001
        return {"error": _scrub(str(e))[:200]}


def worker_log(board: Optional[str], task_id: str) -> dict[str, Any]:
    try:
        K = _K()
        return {"ok": True, "log": _scrub(K.read_worker_log(task_id, board=board))}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": _scrub(str(e))[:200], "log": None}


def link_task(board: Optional[str], parent_id: str, child_id: str) -> dict[str, Any]:
    try:
        K = _K()
        with K.connect_closing(board=board) as conn:
            K.link_tasks(conn, parent_id, child_id)
        return {"ok": True}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": _scrub(str(e))[:200]}


def unlink_task(board: Optional[str], parent_id: str, child_id: str) -> dict[str, Any]:
    try:
        K = _K()
        with K.connect_closing(board=board) as conn:
            ok = K.unlink_tasks(conn, parent_id, child_id)
        return {"ok": bool(ok)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": _scrub(str(e))[:200]}


def notify_remove(board: Optional[str], task_id: str, platform: str, chat_id: str, thread_id: Optional[str] = None) -> dict[str, Any]:
    try:
        K = _K()
        with K.connect_closing(board=board) as conn:
            ok = K.remove_notify_sub(conn, task_id=task_id, platform=platform, chat_id=chat_id, thread_id=thread_id)
        return {"ok": bool(ok)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": _scrub(str(e))[:200]}


def notify_add(board: Optional[str], task_id: str, platform: str, chat_id: str, thread_id: Optional[str] = None) -> dict[str, Any]:
    try:
        K = _K()
        with K.connect_closing(board=board) as conn:
            K.add_notify_sub(conn, task_id=task_id, platform=platform, chat_id=str(chat_id), thread_id=thread_id)
        return {"ok": True}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": _scrub(str(e))[:200]}


def edit_task(
    board: Optional[str],
    task_id: str,
    title: Optional[str] = None,
    body: Optional[str] = None,
    assignee: Optional[str] = None,
) -> dict[str, Any]:
    """Edit a task. Triage → specify_triage_task (title/body/assignee).
    Done → edit_completed_task_result (body becomes result). Else: best effort."""
    try:
        K = _K()
        with K.connect_closing(board=board) as conn:
            t = K.get_task(conn, task_id)
            if t is None:
                return {"ok": False, "error": "Tugas tidak ditemukan"}
            if t.status == "done":
                ok = K.edit_completed_task_result(conn, task_id, result=body or "", summary=None)
                return {"ok": bool(ok)}
            kw: dict[str, Any] = {}
            if title is not None:
                kw["title"] = title
            if body is not None:
                kw["body"] = body
            if assignee is not None:
                kw["assignee"] = assignee
            ok = K.specify_triage_task(conn, task_id, **kw)
        return {"ok": bool(ok)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": _scrub(str(e))[:200]}


def decompose(board: Optional[str], task_id: str) -> dict[str, Any]:
    """Fan a triage task out into child tasks via the auxiliary LLM."""
    try:
        from hermes_cli import kanban_decompose as d
        out = d.decompose_task(task_id)
        return {
            "ok": bool(getattr(out, "ok", False)),
            "reason": getattr(out, "reason", None),
            "fanout": getattr(out, "fanout", 0),
            "childIds": list(getattr(out, "child_ids", []) or []),
            "newTitle": getattr(out, "new_title", None),
        }
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": _scrub(str(e))[:200]}


def reclaim(board: Optional[str], task_id: str, reason: Optional[str] = None) -> dict[str, Any]:
    try:
        K = _K()
        with K.connect_closing(board=board) as conn:
            ok = K.reclaim_task(conn, task_id, reason=reason)
            new = _status_of(K, conn, task_id)
        return {"ok": bool(ok), "status": new}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": _scrub(str(e))[:200]}


def worker_context(board: Optional[str], task_id: str) -> dict[str, Any]:
    try:
        K = _K()
        with K.connect_closing(board=board) as conn:
            text = K.build_worker_context(conn, task_id)
        return {"ok": True, "context": _scrub(text)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": _scrub(str(e))[:200], "context": None}


def diagnostics(board: Optional[str] = None) -> dict[str, Any]:
    """Board-wide diagnostics — same rule engine the engine dashboard uses."""
    try:
        K = _K()
        from hermes_cli import kanban_diagnostics as kd
        try:
            from hermes_cli.config import load_config
            cfg = kd.config_from_runtime_config(load_config())
        except Exception:  # noqa: BLE001
            cfg = None
        out = []
        with K.connect_closing(board=board) as conn:
            # Fleet diagnostics with bulk event/run fetch — mirrors the engine's
            # own hermes_cli/kanban.py:_cmd_diagnostics fleet mode (3 queries
            # total: tasks + task_events IN(...) + task_runs IN(...)), instead of
            # 1+2N (list_events + list_runs per task). compute_task_diagnostics
            # accepts raw sqlite rows here exactly as the engine fleet path does.
            rows = list(
                conn.execute("SELECT * FROM tasks WHERE status != 'archived'").fetchall()
            )
            ids = [r["id"] for r in rows]
            ev_by: dict = {i: [] for i in ids}
            run_by: dict = {i: [] for i in ids}
            if ids:
                placeholders = ",".join(["?"] * len(ids))
                for row in conn.execute(
                    f"SELECT * FROM task_events WHERE task_id IN ({placeholders}) ORDER BY id",
                    tuple(ids),
                ):
                    ev_by.setdefault(row["task_id"], []).append(row)
                for row in conn.execute(
                    f"SELECT * FROM task_runs WHERE task_id IN ({placeholders}) ORDER BY id",
                    tuple(ids),
                ):
                    run_by.setdefault(row["task_id"], []).append(row)
            for t in rows:
                tid = t["id"]
                try:
                    diags = kd.compute_task_diagnostics(
                        t, ev_by.get(tid, []), run_by.get(tid, []), config=cfg
                    )
                except Exception:  # noqa: BLE001
                    diags = []
                if diags:
                    out.append({
                        "taskId": t["id"],
                        "title": t["title"],
                        "status": t["status"],
                        "diagnostics": [
                            {
                                "kind": d.kind,
                                "severity": d.severity,
                                "title": _scrub(d.title),
                                "detail": _scrub(d.detail),
                                "count": getattr(d, "count", 1),
                            }
                            for d in diags
                        ],
                    })
        return {"items": out}
    except Exception as e:  # noqa: BLE001
        return {"items": [], "error": _scrub(str(e))[:200]}


def create_swarm(
    board: Optional[str],
    goal: str,
    workers: list,
    verifier: str,
    synthesizer: str,
    priority: int = 0,
) -> dict[str, Any]:
    """Create a multi-worker swarm task (parallel workers + verifier + synthesizer)."""
    try:
        K = _K()
        from hermes_cli import kanban_swarm as ks
        specs = []
        for w in workers or []:
            if isinstance(w, str):
                specs.append(ks.parse_worker_arg(w))
            elif isinstance(w, dict):
                raw = w.get("profile", "")
                title = w.get("title", "")
                arg = f"{raw}:{title}" if title else raw
                specs.append(ks.parse_worker_arg(arg))
        if not specs:
            return {"ok": False, "error": "Minimal satu worker diperlukan"}
        with K.connect_closing(board=board) as conn:
            created = ks.create_swarm(
                conn,
                goal=goal,
                workers=specs,
                verifier_assignee=verifier,
                synthesizer_assignee=synthesizer,
                created_by="user",
                priority=int(priority or 0),
            )
        root = created.get("root_id") if isinstance(created, dict) else getattr(created, "root_id", None)
        return {"ok": True, "rootId": root, "result": created if isinstance(created, dict) else None}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": _scrub(str(e))[:200]}


# ── Mutations (engine semantic transitions) ─────────────────────────────────

def create_task(
    board: Optional[str],
    title: str,
    body: Optional[str] = None,
    assignee: Optional[str] = None,
    priority: int = 0,
    triage: bool = False,
    skills: Optional[list] = None,
    initial_status: Optional[str] = None,
    max_runtime_seconds: Optional[int] = None,
    tenant: Optional[str] = None,
    max_retries: Optional[int] = None,
) -> dict[str, Any]:
    try:
        K = _K()
        kwargs: dict[str, Any] = {
            "title": title,
            "body": body or None,
            "assignee": assignee or None,
            "created_by": "user",
            "priority": int(priority or 0),
            "triage": bool(triage),
            "board": board or None,
        }
        if skills:
            kwargs["skills"] = list(skills)
        if initial_status:
            kwargs["initial_status"] = initial_status
        if max_runtime_seconds:
            kwargs["max_runtime_seconds"] = int(max_runtime_seconds)
        if tenant:
            kwargs["tenant"] = tenant
        if max_retries is not None:
            kwargs["max_retries"] = int(max_retries)
        with K.connect_closing(board=board) as conn:
            task_id = K.create_task(conn, **kwargs)
        return {"ok": True, "taskId": task_id}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": _scrub(str(e))[:200]}


def _status_of(K, conn, task_id: str) -> Optional[str]:
    t = K.get_task(conn, task_id)
    return getattr(t, "status", None) if t else None


def move_task(board: Optional[str], task_id: str, to_status: str) -> dict[str, Any]:
    """Map a target column to the engine's semantic transition."""
    try:
        K = _K()
        with K.connect_closing(board=board) as conn:
            cur = _status_of(K, conn, task_id)
            if cur is None:
                return {"ok": False, "error": "Tugas tidak ditemukan"}
            if cur == to_status:
                return {"ok": True, "noop": True, "status": cur}

            ok = False
            note = None
            if to_status == "blocked":
                ok = K.block_task(conn, task_id, reason="Dipindahkan manual")
            elif to_status == "scheduled":
                ok = K.schedule_task(conn, task_id)
            elif to_status == "done":
                ok = K.complete_task(conn, task_id, summary="Diselesaikan manual")
            elif to_status == "archived":
                ok = K.archive_task(conn, task_id)
            elif cur == "blocked":
                ok = K.unblock_task(conn, task_id)
                note = "unblocked"
            elif cur == "triage":
                res = K.promote_task(conn, task_id, actor="user", force=True)
                ok = bool(res[0]) if isinstance(res, tuple) else bool(res)
                note = "promoted"
            else:
                return {
                    "ok": False,
                    "error": f"Transisi {cur} → {to_status} tidak didukung engine",
                }
            new = _status_of(K, conn, task_id)
        return {"ok": bool(ok), "status": new, "note": note}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": _scrub(str(e))[:200]}


def _simple(fn_name: str):
    def _run(board: Optional[str], task_id: str, **kw) -> dict[str, Any]:
        try:
            K = _K()
            fn = getattr(K, fn_name)
            with K.connect_closing(board=board) as conn:
                if fn_name == "promote_task":
                    res = fn(conn, task_id, actor="user", force=True)
                    ok = bool(res[0]) if isinstance(res, tuple) else bool(res)
                else:
                    ok = fn(conn, task_id, **kw)
                new = _status_of(K, conn, task_id)
            return {"ok": bool(ok), "status": new}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": _scrub(str(e))[:200]}
    return _run


complete = _simple("complete_task")
block = _simple("block_task")
unblock = _simple("unblock_task")
promote = _simple("promote_task")
archive = _simple("archive_task")


def delete(board: Optional[str], task_id: str) -> dict[str, Any]:
    try:
        K = _K()
        with K.connect_closing(board=board) as conn:
            ok = K.delete_task(conn, task_id)
        return {"ok": bool(ok)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": _scrub(str(e))[:200]}


def add_comment(board: Optional[str], task_id: str, body: str) -> dict[str, Any]:
    try:
        K = _K()
        with K.connect_closing(board=board) as conn:
            cid = K.add_comment(conn, task_id, "user", body)
        return {"ok": True, "commentId": cid}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": _scrub(str(e))[:200]}


def reassign(board: Optional[str], task_id: str, assignee: Optional[str]) -> dict[str, Any]:
    try:
        K = _K()
        with K.connect_closing(board=board) as conn:
            ok = K.reassign_task(conn, task_id, assignee or None)
        return {"ok": bool(ok), "assignee": assignee}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": _scrub(str(e))[:200]}


def schedule(board: Optional[str], task_id: str) -> dict[str, Any]:
    try:
        K = _K()
        with K.connect_closing(board=board) as conn:
            ok = K.schedule_task(conn, task_id)
            new = _status_of(K, conn, task_id)
        return {"ok": bool(ok), "status": new}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": _scrub(str(e))[:200]}


def edit_triage(
    board: Optional[str],
    task_id: str,
    title: Optional[str] = None,
    body: Optional[str] = None,
    assignee: Optional[str] = None,
) -> dict[str, Any]:
    """Edit a triage task's title/body/assignee (engine only allows this in triage)."""
    try:
        K = _K()
        kw: dict[str, Any] = {}
        if title is not None:
            kw["title"] = title
        if body is not None:
            kw["body"] = body
        if assignee is not None:
            kw["assignee"] = assignee
        with K.connect_closing(board=board) as conn:
            ok = K.specify_triage_task(conn, task_id, **kw)
        return {"ok": bool(ok)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": _scrub(str(e))[:200]}


def known_assignees(board: Optional[str] = None) -> dict[str, Any]:
    try:
        K = _K()
        with K.connect_closing(board=board) as conn:
            rows = K.known_assignees(conn)
        return {"assignees": rows}
    except Exception as e:  # noqa: BLE001
        return {"assignees": [], "error": _scrub(str(e))[:200]}


# ── Board management (multi-board) ──────────────────────────────────────────

def create_board(
    slug: str,
    name: Optional[str] = None,
    description: Optional[str] = None,
    icon: Optional[str] = None,
    color: Optional[str] = None,
) -> dict[str, Any]:
    try:
        K = _K()
        kw: dict[str, Any] = {}
        if name:
            kw["name"] = name
        if description:
            kw["description"] = description
        if icon:
            kw["icon"] = icon
        if color:
            kw["color"] = color
        K.create_board(slug, **kw)
        return {"ok": True, "slug": slug}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": _scrub(str(e))[:200]}


def list_profiles_meta() -> dict[str, Any]:
    """Profiles on disk + their orchestrator routing descriptions."""
    try:
        K = _K()
        from hermes_cli import profiles as P
        out = []
        for name in K.list_profiles_on_disk():
            desc, auto = "", False
            try:
                meta = P.read_profile_meta(P.get_profile_dir(name))
                desc = meta.get("description") or ""
                auto = bool(meta.get("description_auto"))
            except Exception:  # noqa: BLE001
                pass
            out.append({"name": name, "description": desc, "descriptionAuto": auto})
        return {"profiles": out}
    except Exception as e:  # noqa: BLE001
        return {"profiles": [], "error": _scrub(str(e))[:200]}


def set_profile_description(name: str, description: str) -> dict[str, Any]:
    try:
        from hermes_cli import profiles as P
        P.write_profile_meta(
            P.get_profile_dir(name),
            description=description,
            description_auto=False,
        )
        return {"ok": True}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": _scrub(str(e))[:200]}


def auto_describe_profile(name: str) -> dict[str, Any]:
    try:
        from hermes_cli import profile_describer as pd
        out = pd.describe_profile(name, overwrite=True)
        return {
            "ok": bool(getattr(out, "ok", False)),
            "description": getattr(out, "description", None),
            "reason": getattr(out, "reason", None),
        }
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": _scrub(str(e))[:200]}


def nudge_dispatcher(board: Optional[str] = None) -> dict[str, Any]:
    """Run one dispatch tick (promote ready / reclaim stale). Worker spawning
    stays in the gateway daemon; this just advances bookkeeping immediately."""
    try:
        K = _K()
        with K.connect_closing(board=board) as conn:
            res = K.dispatch_once(conn, dry_run=False)
        return {
            "ok": True,
            "promoted": getattr(res, "promoted", 0),
            "reclaimed": getattr(res, "reclaimed", 0),
            "spawned": len(getattr(res, "spawned", []) or []),
        }
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": _scrub(str(e))[:200]}


def set_board(slug: str) -> dict[str, Any]:
    try:
        K = _K()
        K.set_current_board(slug)
        return {"ok": True, "current": slug}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": _scrub(str(e))[:200]}


def remove_board(slug: str) -> dict[str, Any]:
    try:
        K = _K()
        res = K.remove_board(slug, archive=True)
        return {"ok": True, "result": res}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": _scrub(str(e))[:200]}
