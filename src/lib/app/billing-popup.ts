"use client";

// Shared "open a billing surface in a popup" helper — the SINGLE entry point
// every upgrade/checkout button uses (trial banner, topbar pill, trial-locked
// overlay, Item Shop, energy vault). ALWAYS appends ?parent=<portal origin> so
// the popup can postMessage its settle signal back to a parent that validates
// the origin (see billing/_lib/parent-origin + use-billing-settle). Falls back
// to same-tab navigation if the popup is blocked, so the user still reaches
// checkout. Extracted verbatim from the verified shop-tab implementation.
export function openBillingPopup(
  path: string,
  name = "agentbuff-billing",
): Window | null {
  if (typeof window === "undefined") return null;
  // The exclusive subscription checkout (/checkout) is a FULL-PAGE experience
  // (Chief's explicit choice — "halaman checkout, bukan popup"): navigate to it
  // instead of popping a window. After payment /checkout redirects back to /app.
  // Other billing surfaces (energy/skill, currently gated) still open a popup.
  if (path.startsWith("/checkout")) {
    window.location.href = path;
    return null;
  }
  const parent = encodeURIComponent(window.location.origin);
  const url = `${path}${path.includes("?") ? "&" : "?"}parent=${parent}`;
  const popup = window.open(url, name, "popup=yes,width=480,height=720");
  if (!popup || popup.closed) {
    window.location.href = url;
    return null;
  }
  try {
    popup.focus();
  } catch {
    /* ignore */
  }
  return popup;
}
