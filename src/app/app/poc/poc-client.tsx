"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GatewayClient } from "@/lib/hermes/browser-gateway";

type ConnStatus = "idle" | "connecting" | "ready" | "reconnecting" | "closed";

type Props = {
  userEmail: string | null;
};

const SESSION_KEY = "main";

export function PocClient({ userEmail }: Props) {
  const clientRef = useRef<GatewayClient | null>(null);
  const [status, setStatus] = useState<ConnStatus>("idle");
  const [input, setInput] = useState("halo");
  const [output, setOutput] = useState("");
  const [sending, setSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [eventLog, setEventLog] = useState<string[]>([]);

  const log = useCallback((line: string) => {
    setEventLog((prev) => [
      `${new Date().toLocaleTimeString()} ${line}`,
      ...prev,
    ].slice(0, 40));
  }, []);

  useEffect(() => {
    const client = new GatewayClient({
      onOpen: () => {
        setStatus("connecting");
        log("ws open — waiting for proxy.ready");
      },
      onReady: () => {
        setStatus("ready");
        log("proxy.ready — gateway handshake complete");
      },
      onClose: (info) => {
        setStatus("reconnecting");
        log(`ws close (${info.code}) ${info.reason} — reconnecting`);
      },
    });
    clientRef.current = client;
    setStatus("connecting");
    client.start();

    // Permanent event listener. Streaming deltas arrive AS `event` frames AFTER
    // chat.send's `res` frame resolves — so a scoped `stream()` helper that
    // unsubscribes on `res` would drop every delta. See
    // `Docs/rpc-subset-contract.md` §6.1 for the full gotcha.
    //
    // Discriminate on `payload.state`, not event name: OpenClaw emits ONE
    // `event: "chat"` for delta / final / aborted / error.
    const off = client.onEvent((evt) => {
      if (evt.event !== "chat") return;
      const p = evt.payload as
        | {
            state?: "delta" | "final" | "aborted" | "error";
            message?: { content?: Array<{ type?: string; text?: string }> };
            errorMessage?: string;
          }
        | undefined;
      const state = p?.state ?? "?";
      const text = (p?.message?.content ?? [])
        .map((c) => (c?.type === "text" ? c.text ?? "" : ""))
        .join("");
      log(`chat state=${state} len=${text.length}`);
      // content[].text is FULL merged text so far, not an incremental chunk —
      // render by replacing, never accumulating.
      if (text) setOutput(text);
      if (state === "error" && p?.errorMessage) setErrorMsg(p.errorMessage);
    });

    return () => {
      off();
      setStatus("closed");
      client.stop();
      clientRef.current = null;
    };
  }, [log]);

  const handleSend = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    const message = input.trim();
    if (!message) return;

    setSending(true);
    setErrorMsg(null);
    setOutput("");

    const idempotencyKey = crypto.randomUUID();
    log(`chat.send sessionKey=${SESSION_KEY} idempotencyKey=${idempotencyKey.slice(0, 8)}…`);

    try {
      await client.request("chat.send", {
        sessionKey: SESSION_KEY,
        message,
        idempotencyKey,
      });
      log("chat.send resolved (waiting for streaming deltas)");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg);
      log(`chat.send error: ${msg}`);
    } finally {
      setSending(false);
    }
  }, [input, log]);

  return (
    <main
      style={{
        padding: 24,
        fontFamily: "system-ui, sans-serif",
        maxWidth: 960,
        margin: "0 auto",
        display: "grid",
        gap: 16,
      }}
    >
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>AgentBuff POC — chat pipe</h1>
        <div style={{ fontSize: 12, color: "#666" }}>
          {userEmail ?? "—"} · status: <StatusPill status={status} />
        </div>
      </header>

      <section style={{ display: "grid", gap: 8 }}>
        <label style={{ fontSize: 12, color: "#555" }}>Kirim pesan ke sessionKey <code>{SESSION_KEY}</code></label>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={3}
          style={{
            width: "100%",
            padding: 8,
            border: "1px solid #ccc",
            borderRadius: 6,
            fontFamily: "inherit",
            fontSize: 14,
          }}
          disabled={sending}
        />
        <div>
          <button
            type="button"
            onClick={handleSend}
            disabled={sending || status !== "ready" || !input.trim()}
            style={{
              padding: "8px 16px",
              border: "1px solid #333",
              borderRadius: 6,
              background: sending || status !== "ready" ? "#eee" : "#111",
              color: sending || status !== "ready" ? "#666" : "#fff",
              cursor: sending || status !== "ready" ? "not-allowed" : "pointer",
            }}
          >
            {sending ? "Mengirim…" : "Kirim"}
          </button>
        </div>
      </section>

      {errorMsg ? (
        <section
          style={{
            border: "1px solid #c33",
            background: "#fee",
            color: "#900",
            padding: 12,
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          Error: {errorMsg}
        </section>
      ) : null}

      <section>
        <div style={{ fontSize: 12, color: "#555", marginBottom: 4 }}>Output (streaming)</div>
        <pre
          style={{
            minHeight: 120,
            padding: 12,
            border: "1px solid #ccc",
            borderRadius: 6,
            whiteSpace: "pre-wrap",
            fontFamily: "ui-monospace, Menlo, Consolas, monospace",
            fontSize: 13,
            margin: 0,
            background: "#fafafa",
          }}
        >
          {output || <span style={{ color: "#999" }}>belum ada output</span>}
        </pre>
      </section>

      <section>
        <div style={{ fontSize: 12, color: "#555", marginBottom: 4 }}>Event log (terbaru di atas)</div>
        <pre
          style={{
            maxHeight: 200,
            overflow: "auto",
            padding: 12,
            border: "1px solid #ddd",
            borderRadius: 6,
            fontFamily: "ui-monospace, Menlo, Consolas, monospace",
            fontSize: 12,
            margin: 0,
            background: "#fafafa",
            color: "#333",
          }}
        >
          {eventLog.length === 0 ? <span style={{ color: "#999" }}>—</span> : eventLog.join("\n")}
        </pre>
      </section>
    </main>
  );
}

function StatusPill({ status }: { status: ConnStatus }) {
  const color = {
    idle: "#888",
    connecting: "#c80",
    ready: "#0a5",
    reconnecting: "#c80",
    closed: "#c33",
  }[status];
  return (
    <span style={{ color, fontWeight: 600 }}>
      {status}
    </span>
  );
}
