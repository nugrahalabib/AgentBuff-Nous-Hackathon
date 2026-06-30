import { NextResponse } from "next/server";

// Newsletter signup. Primary backend is Resend Audiences:
//   POST https://api.resend.com/audiences/{audienceId}/contacts
// Gated behind RESEND_API_KEY + RESEND_AUDIENCE_ID. When either is missing
// (dev, preview, or before the account is provisioned) we fall back to
// console.log so the signup form still "works" in testing. Resend's Contacts
// API is idempotent on email — re-subscribe returns 200 without duplicating.
//
// We intentionally do NOT import the `resend` npm package. One `fetch` call
// keeps the bundle lean and removes a dependency we'd otherwise need to keep
// version-pinned.

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESEND_ENDPOINT = "https://api.resend.com";

export async function POST(request: Request) {
  let email: string | undefined;
  try {
    const body = await request.json();
    email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : undefined;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!email) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }
  if (!EMAIL_REGEX.test(email)) {
    return NextResponse.json({ error: "Invalid email format" }, { status: 400 });
  }

  const apiKey = process.env.RESEND_API_KEY;
  const audienceId = process.env.RESEND_AUDIENCE_ID;

  // Dev / pre-provision fallback. Not an error — signup form should still feel
  // responsive during local work.
  if (!apiKey || !audienceId) {
    console.log(`[newsletter] (no Resend config) signup: ${email}`);
    return NextResponse.json({ success: true, stored: "log" });
  }

  try {
    const res = await fetch(
      `${RESEND_ENDPOINT}/audiences/${audienceId}/contacts`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, unsubscribed: false }),
      },
    );

    // 200 OK = newly added. 409-ish "already exists" also acceptable; Resend
    // currently returns 200 with the existing contact id on re-add, but we
    // stay defensive.
    if (!res.ok && res.status !== 409) {
      const detail = await res.text();
      console.error(`[newsletter] Resend error ${res.status}: ${detail}`);
      return NextResponse.json(
        { error: "Subscription failed, please try again." },
        { status: 502 },
      );
    }

    return NextResponse.json({ success: true, stored: "resend" });
  } catch (err) {
    console.error("[newsletter] Resend fetch failed:", err);
    return NextResponse.json(
      { error: "Subscription failed, please try again." },
      { status: 502 },
    );
  }
}
