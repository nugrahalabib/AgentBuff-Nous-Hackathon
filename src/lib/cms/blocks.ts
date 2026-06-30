// D8 editable-block catalog. Single source of truth shared by the admin editor
// (field rendering) and the API (validation + key allowlist). Each block's `key`
// is a real i18n dot-path; its `value` REPLACES that node. Adding a block here =
// it becomes editable (the landing already reads it via t.*), no other change.
import { z } from "zod/v4";

export type FieldKind = "text" | "textarea" | "number";
export interface ItemField {
  name: string;
  label: string;
  kind: FieldKind;
}

export interface CmsBlock {
  /** i18n dot-path of the node this block replaces. */
  key: string;
  /** Grouping header in the editor list. */
  section: string;
  label: string;
  kind: "scalar" | "array" | "json";
  /** scalar only: render a textarea instead of a single-line input. */
  multiline?: boolean;
  /** array only: the per-row object fields. */
  itemFields?: ItemField[];
  /** array only: max rows (matches the landing's design slot count). */
  cap?: number;
  /** Validates the whole value before it is stored/published. scalar/array use
   *  this; json blocks are shape-checked against the compiled-in default instead
   *  (the route supplies the default), so their schema is a permissive placeholder. */
  schema: z.ZodType;
}

const scalar = (
  key: string,
  section: string,
  label: string,
  max: number,
  multiline = false,
): CmsBlock => ({
  key,
  section,
  label,
  kind: "scalar",
  multiline,
  schema: z.string().trim().min(1).max(max),
});

// A whole-section node edited as raw JSON. Complex/nested landing sections (cards
// with nested badge/feature arrays) don't fit the flat scalar/array editors, so
// the admin edits the full node and we structurally validate it against the
// compiled-in default (same keys/types) — see shapeMatches + the route.
const jsonBlock = (key: string, section: string, label: string): CmsBlock => ({
  key,
  section,
  label,
  kind: "json",
  schema: z.unknown(),
});

/**
 * Structural validation for json blocks: `candidate` must mirror `template`
 * (the compiled-in default node) — same primitive types, object keys present,
 * array elements matching the template's first element. Extra object keys are
 * tolerated (harmless; the landing only reads known paths). An empty template
 * array accepts any array. This stops a shape-breaking save (e.g. a string where
 * the landing maps an array) without hand-writing a zod schema per section.
 */
export function shapeMatches(template: unknown, candidate: unknown): boolean {
  if (Array.isArray(template)) {
    if (!Array.isArray(candidate)) return false;
    if (template.length === 0) return true;
    return candidate.every((c) => shapeMatches(template[0], c));
  }
  if (template !== null && typeof template === "object") {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate))
      return false;
    const t = template as Record<string, unknown>;
    const c = candidate as Record<string, unknown>;
    return Object.keys(t).every(
      (k) => k in c && shapeMatches(t[k], c[k]),
    );
  }
  if (typeof template === "string") return typeof candidate === "string";
  if (typeof template === "number") return typeof candidate === "number";
  if (typeof template === "boolean") return typeof candidate === "boolean";
  // template null/undefined — can't infer; accept.
  return true;
}

const FAQ_ITEM = z.object({
  question: z.string().trim().min(1).max(2000),
  answer: z.string().trim().min(1).max(4000),
});

const REVIEW_ITEM = z.object({
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().min(1).max(200),
  quote: z.string().trim().min(1).max(2000),
  rating: z.number().int().min(1).max(5),
  buff: z.string().trim().max(120),
  metric: z.string().trim().max(120),
  metricLabel: z.string().trim().max(200),
});

export const CMS_BLOCKS: CmsBlock[] = [
  scalar("hero.badge", "Hero", "Badge", 120),
  scalar("hero.titleLine1", "Hero", "Judul baris 1", 200),
  scalar("hero.titleLine3", "Hero", "Judul baris 3", 200),
  scalar("hero.titleLine4", "Hero", "Judul baris 4", 200),
  scalar("hero.subtitle", "Hero", "Subjudul", 600, true),
  scalar("hero.ctaPrimary", "Hero", "Tombol utama", 80),
  scalar("hero.ctaSecondary", "Hero", "Tombol kedua", 80),
  {
    key: "faq.items",
    section: "FAQ",
    label: "Daftar pertanyaan",
    kind: "array",
    cap: 10,
    itemFields: [
      { name: "question", label: "Pertanyaan", kind: "textarea" },
      { name: "answer", label: "Jawaban", kind: "textarea" },
    ],
    schema: z.array(FAQ_ITEM).min(1).max(10),
  },
  {
    key: "wallOfFame.reviews",
    section: "Wall of Fame",
    label: "Testimoni",
    kind: "array",
    cap: 8,
    itemFields: [
      { name: "name", label: "Nama", kind: "text" },
      { name: "role", label: "Peran", kind: "text" },
      { name: "quote", label: "Testimoni", kind: "textarea" },
      { name: "rating", label: "Rating (1-5)", kind: "number" },
      { name: "buff", label: "Buff", kind: "text" },
      { name: "metric", label: "Metrik", kind: "text" },
      { name: "metricLabel", label: "Label metrik", kind: "text" },
    ],
    schema: z.array(REVIEW_ITEM).min(1).max(8),
  },
  // Model marquee — two friendly scalars.
  scalar("modelMarquee.title", "Model Marquee", "Judul", 120),
  scalar("modelMarquee.highlight", "Model Marquee", "Highlight", 120),
  // Nested / card sections — edited as whole-node JSON (shape-checked vs default).
  jsonBlock("hero.rotatingRoles", "Hero", "Persona berputar (JSON)"),
  jsonBlock("statusPanel", "Status Panel", "Seluruh blok (JSON)"),
  jsonBlock("skillTree", "Skill Tree", "Seluruh blok (JSON)"),
  jsonBlock("customAgent", "Custom Agent", "Seluruh blok (JSON)"),
  jsonBlock("vsComparison", "VS Comparison", "Seluruh blok (JSON)"),
  jsonBlock("itemShop", "Item Shop", "Seluruh blok (JSON)"),
  jsonBlock("footer", "Footer", "Seluruh blok (JSON)"),
];

const BY_KEY = new Map(CMS_BLOCKS.map((b) => [b.key, b]));

export function getBlock(key: string): CmsBlock | undefined {
  return BY_KEY.get(key);
}

export function isEditableKey(key: string): boolean {
  return BY_KEY.has(key);
}

/** Validate a value against its block. Returns the parsed value or null. */
export function validateBlockValue(
  key: string,
  value: unknown,
): { ok: true; value: unknown } | { ok: false } {
  const block = BY_KEY.get(key);
  if (!block) return { ok: false };
  const r = block.schema.safeParse(value);
  return r.success ? { ok: true, value: r.data } : { ok: false };
}
