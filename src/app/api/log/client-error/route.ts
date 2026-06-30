/**
 * O3 — Client-side error sink. Receives JSON payloads from the /app error
 * boundary (`src/app/app/error.tsx`) and writes them to the server log
 * via `console.error`. Keeping the surface minimal: no DB persistence,
 * no Sentry SDK, no auth gate (errors can fire before auth is loaded —
 * we don't want to drop them). Per-IP rate-limited below so a malicious
 * client can't flood the server log / fill disk by hammering this route.
 */
import { NextResponse } from "next/server";
import { take, keyFromRequest } from "@/lib/security/rate-limit";

const MAX_PAYLOAD_BYTES = 16_000;
// A real error boundary fires a handful of times at most; 30/min/IP is
// generous for legit use while still capping a log-flood attack.
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

export async function POST(req: Request) {
  try {
    const limit = take(keyFromRequest("client-error", req), RATE_LIMIT, RATE_WINDOW_MS);
    if (!limit.ok) {
      return NextResponse.json({ ok: false }, { status: 429 });
    }
    // Reject obviously oversized payloads to avoid eating server memory.
    const text = await req.text();
    if (text.length > MAX_PAYLOAD_BYTES) {
      return NextResponse.json({ ok: false }, { status: 413 });
    }
    let payload: Record<string, unknown> | null = null;
    try {
      payload = JSON.parse(text);
    } catch {
      return NextResponse.json({ ok: false }, { status: 400 });
    }
    // Log with a stable prefix so ops can grep it.
    // eslint-disable-next-line no-console
    console.error("[client-error]", JSON.stringify(payload));
    return NextResponse.json({ ok: true });
  } catch (err) {
    // Don't let a bad request topple the server.
    // eslint-disable-next-line no-console
    console.error("[client-error] route crash:", err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
