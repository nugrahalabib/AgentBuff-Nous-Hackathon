// English display overrides for the marketplace catalog.
//
// The skill_catalog DB (seeded from skill-catalog.ts) holds Indonesian copy —
// that's the real product/market language. For the international demo (English
// locale) we overlay English title/tagline/description/capabilities at RENDER
// time, keyed by the stable skill `key`. The DB is untouched; backend
// enums/keys/prices stay the same. Used by the Item Shop cards AND the in-chat
// BuffHub search/detail cards (they share this catalog data).

export type SkillI18n = {
  title: string;
  tagline: string;
  description: string;
  capabilities: string[];
};

export const SKILL_EN: Record<string, SkillI18n> = {
  "cs-toko-autopilot": {
    title: "Store CS Auto-Pilot",
    tagline: "24/7 shop support, no overtime.",
    description:
      "Full customer service for your online shop. The agent answers product " +
      "FAQs, checks stock and order status, handles complaints, and escalates to " +
      "you when needed. New-order alerts land straight in your WhatsApp, and it " +
      "can auto-send PDF invoices to customers.",
    capabilities: [
      "Answer product FAQs + auto stock checks",
      "Track customer order status in real time",
      "Handle complaints + escalate to you",
      "New-order alerts straight to WhatsApp",
      "Auto-send PDF invoices to buyers",
    ],
  },
  "pencatat-keuangan": {
    title: "Finance Tracker",
    tagline: "Track your money just by chatting.",
    description:
      "Just chat \"spent 50k on lunch\" and the agent logs it instantly. Every " +
      "month-end you get a full income/expense report with charts, delivered as a " +
      "file to your chat. Manage your finances with no clunky app.",
    capabilities: [
      "Log income/expenses just by chatting",
      "Automatic monthly report + charts (PDF)",
      "Tidy transaction categories, no hassle",
      "Bill reminders & savings goals",
    ],
  },
  "researcher-analyst": {
    title: "Researcher Analyst",
    tagline: "Deep research, ready-to-use results.",
    description:
      "A deep-research + detailed-analysis web app. Give it a topic and the agent " +
      "researches across many sources, then sends you a clean report plus the " +
      "data. Great for market research, competitor analysis, or business decisions.",
    capabilities: [
      "Deep research from many sources",
      "Structured market & competitor analysis",
      "Clean, ready-to-use report with cited sources",
      "Results delivered as a file to chat",
    ],
  },
  "business-builder": {
    title: "Build a Business Pro",
    tagline: "From idea to proposal + deck.",
    description:
      "An end-to-end business-building assistant: planning, market research, " +
      "analysis, logo creation, mood boards, mockups, all the way to a business " +
      "proposal + pitch deck. Each result is delivered in stages. Uses BYOK (your " +
      "own API key) for flexibility and savings.",
    capabilities: [
      "End-to-end planning + market research",
      "Generate logo, mood board & mockup",
      "Build a business proposal + pitch deck",
      "Output delivered to you in stages",
      "Save money: use your own API key (BYOK)",
    ],
  },
  "marketing-content": {
    title: "Marketing Content Studio",
    tagline: "All-in-one viral content factory.",
    description:
      "A complete marketing-content web app: generate images with ready-made " +
      "social templates, build mood boards, generate video from a mood board, " +
      "plus content analysis to chase virality. Everything is delivered to chat. " +
      "Uses BYOK (your own API key).",
    capabilities: [
      "Generate images with social templates",
      "Build mood boards + video from them",
      "Content analysis to chase virality",
      "Results sent to chat, ready to post",
      "Save money: use your own API key (BYOK)",
    ],
  },
  "pos-umkm": {
    title: "POS UMKM Cashier",
    tagline: "A digital cashier in your pocket.",
    description:
      "A Point-of-Sale (POS) web app for small businesses. Record transactions, " +
      "manage stock, and view sales reports. The agent sends low-stock alerts plus " +
      "a daily revenue recap straight to your chat.",
    capabilities: [
      "Record sales transactions fast",
      "Manage product stock automatically",
      "Daily revenue report to chat",
      "Low-stock alerts so you never run out",
    ],
  },
  "manajemen-kos": {
    title: "Boarding-House Manager",
    tagline: "Run your boarding house, stress-free.",
    description:
      "A boarding-house management web app: room data, tenants, and rent bills. " +
      "The agent sends automatic due-date reminders to you and tenants via " +
      "WhatsApp. No late payments, nothing forgotten.",
    capabilities: [
      "Organized room & tenant data",
      "Rent bills auto-calculated",
      "Due-date alerts to you + tenants",
      "Monthly boarding-house income recap",
    ],
  },
  "absensi-karyawan": {
    title: "Employee Attendance",
    tagline: "Team attendance, auto-recapped.",
    description:
      "An employee attendance web app. Check-in/check-out, attendance recaps, and " +
      "automatic reports. The agent sends you a daily recap so you can monitor " +
      "your team without opening an app.",
    capabilities: [
      "Practical employee check-in/check-out",
      "Automatic attendance recap",
      "Daily report delivered to you",
      "Monitor your team without opening an app",
    ],
  },
};

/** Overlay English catalog copy at render time when locale is "en". Keyed by the
 *  item's `key` (or `slug`). Returns the item unchanged for "id" or unknown keys.
 *  Shape-agnostic: overrides whichever of title/name/tagline/description/
 *  capabilities the item actually carries. */
export function localizeSkill<T>(item: T, locale: "id" | "en"): T {
  if (locale !== "en" || !item || typeof item !== "object") return item;
  const rec = item as Record<string, unknown>;
  const key = (rec.key ?? rec.slug) as string | undefined;
  const en = key ? SKILL_EN[key] : undefined;
  if (!en) return item;
  const out: Record<string, unknown> = { ...rec };
  if ("title" in rec) out.title = en.title;
  if ("name" in rec) out.name = en.title;
  if ("tagline" in rec) out.tagline = en.tagline;
  if ("description" in rec && rec.description != null) out.description = en.description;
  if ("capabilities" in rec && Array.isArray(rec.capabilities)) {
    out.capabilities = en.capabilities;
  }
  return out as T;
}
