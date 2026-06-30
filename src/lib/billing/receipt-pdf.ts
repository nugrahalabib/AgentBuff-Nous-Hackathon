// Official payment-receipt PDF. Generated on every settled payment and (a)
// attached to the receipt email + (b) downloadable from the billing UI.
//
// Design: a "thermal receipt" slip — white paper on a soft surface, torn
// perforated edges, monospace body, a punchy display title, dashed dividers
// and a decorative barcode. Printable (light ink) yet on-brand. Pure pdf-lib
// (no native deps / no runtime font-file tracing) so it builds the same in dev
// + prod. Bilingual labels follow the user's locale.
import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { formatPaymentMethod } from "@/lib/billing/payment-method";

export type Locale = "id" | "en";

export interface ReceiptData {
  receiptNo: string;
  dateIso: string;
  description: string;
  amountRp: number;
  paymentRef: string | null;
  paymentMethod?: string | null;
  orderId: string | null;
  billedToEmail: string;
  billedToName?: string | null;
  locale: Locale;
}

/**
 * Stable + unique receipt number per transaction. Derived from the FULL
 * transaction id (a uuid, the table's unique primary key) so it inherits that
 * uniqueness — it never collides across payments and never changes for the same
 * payment, i.e. receipts can't overwrite each other. (A truncated hash would
 * only be *probably* unique; the full uuid is *guaranteed* unique.) The Midtrans
 * Order ID + Payment Ref are also printed as the authoritative gateway refs.
 *   AGB-<YYYYMMDD utc>-<32 hex uuid>
 */
export function receiptNumber(txId: string, createdAt: Date): string {
  const ymd = createdAt.toISOString().slice(0, 10).replace(/-/g, "");
  const full = txId.replace(/-/g, "").toUpperCase();
  return `AGB-${ymd}-${full}`;
}

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;

const INK = rgb(0.06, 0.09, 0.15);
const MUTED = rgb(0.42, 0.47, 0.55);
const ACCENT = rgb(0.39, 0.4, 0.95); // #6366f1
const GREEN = rgb(0.02, 0.59, 0.41); // #059669
const LINE = rgb(0.78, 0.8, 0.85);
const PAPER = rgb(1, 1, 1);
const PAGE_BG = rgb(0.92, 0.93, 0.955);

interface L {
  title: string;
  bigTitle: string;
  receiptNo: string;
  date: string;
  status: string;
  paid: string;
  billedTo: string;
  desc: string;
  amount: string;
  total: string;
  orderId: string;
  payRef: string;
  method: string;
  thanks: string;
  note: string;
}

const LABELS: Record<Locale, L> = {
  id: {
    title: "STRUK PEMBAYARAN",
    bigTitle: "STRUK.",
    receiptNo: "No. Struk",
    date: "Tanggal",
    status: "Status",
    paid: "LUNAS",
    billedTo: "Ditagihkan kepada",
    desc: "Deskripsi",
    amount: "Jumlah",
    total: "TOTAL",
    orderId: "ID Pesanan",
    payRef: "Ref. Pembayaran",
    method: "Metode Bayar",
    thanks: "Terima kasih atas pembayaran kamu.",
    note: "Dokumen ini adalah bukti pembayaran yang sah dari AgentBuff. Dibuat otomatis oleh sistem dan sah tanpa tanda tangan. Simpan struk ini untuk verifikasi jika ada kendala.",
  },
  en: {
    title: "PAYMENT RECEIPT",
    bigTitle: "RECEIPT.",
    receiptNo: "Receipt No.",
    date: "Date",
    status: "Status",
    paid: "PAID",
    billedTo: "Billed to",
    desc: "Description",
    amount: "Amount",
    total: "TOTAL",
    orderId: "Order ID",
    payRef: "Payment Ref.",
    method: "Payment Method",
    thanks: "Thank you for your payment.",
    note: "This is a valid proof of payment from AgentBuff. Computer-generated and valid without a signature. Keep this receipt for verification if any issue arises.",
  },
};

function rupiah(n: number): string {
  return `Rp ${n.toLocaleString("id-ID")}`;
}

function fmtDate(iso: string, locale: Locale): string {
  try {
    return (
      new Intl.DateTimeFormat(locale === "en" ? "en-US" : "id-ID", {
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Jakarta",
      }).format(new Date(iso)) + " WIB"
    );
  } catch {
    return iso;
  }
}

function rightText(
  page: PDFPage,
  text: string,
  xRight: number,
  y: number,
  size: number,
  font: PDFFont,
  color = INK,
): void {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: xRight - w, y, size, font, color });
}

async function loadLogo(): Promise<Uint8Array | null> {
  try {
    const file = path.join(process.cwd(), "public", "images", "apple-icon.png");
    // Guard against embedding a multi-MB icon into EVERY receipt (the launch
    // blocker is a 13MB apple-icon.png) — skip the logo if it's oversized so a
    // bad asset can't spike memory on each render. Shrink the icon to re-enable.
    const stat = await fs.stat(file);
    if (stat.size > 512 * 1024) return null;
    const buf = await fs.readFile(file);
    return new Uint8Array(buf);
  } catch {
    return null; // logo is optional — wordmark still identifies the doc
  }
}

export async function generateReceiptPdf(d: ReceiptData): Promise<Buffer> {
  const t = LABELS[d.locale];
  const doc = await PDFDocument.create();
  doc.setTitle(`${t.title} ${d.receiptNo}`);
  doc.setAuthor("AgentBuff");
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const monoB = await doc.embedFont(StandardFonts.CourierBold);
  const page = doc.addPage([PAGE_W, PAGE_H]);

  // optional brand mark (small, top of the slip)
  let logoImg: Awaited<ReturnType<typeof doc.embedPng>> | null = null;
  const logoBytes = await loadLogo();
  if (logoBytes) {
    try {
      logoImg = await doc.embedPng(logoBytes);
    } catch {
      /* wordmark only */
    }
  }

  // Truncate any value that would overflow its column so nothing can ever
  // collide (the bug the old layout had).
  const fit = (text: string, font: PDFFont, size: number, maxW: number): string => {
    if (font.widthOfTextAtSize(text, size) <= maxW) return text;
    let s = text;
    while (s.length > 1 && font.widthOfTextAtSize(s + "…", size) > maxW) s = s.slice(0, -1);
    return s + "…";
  };

  // ── Slip geometry ───────────────────────────────────────────────
  const RW = 392; // receipt slip width
  const RX = (PAGE_W - RW) / 2;
  const RR = RX + RW;
  const PAD = 30;
  const xL = RX + PAD;
  const xR = RR - PAD;
  const innerW = xR - xL;
  const TY = PAGE_H - 46; // paper top edge (before the perforation teeth)

  // The paper is sized to its content, so we lay everything out into a queue of
  // draw-ops first (tracking the cursor), then paint the paper + torn edges
  // BEHIND the queued content. Each op captures its y via the call args.
  const ops: Array<() => void> = [];
  const qText = (text: string, x: number, yy: number, size: number, font: PDFFont, color = INK) =>
    ops.push(() => page.drawText(text, { x, y: yy, size, font, color }));
  const qRight = (text: string, xr: number, yy: number, size: number, font: PDFFont, color = INK) =>
    ops.push(() => rightText(page, text, xr, yy, size, font, color));
  const dash = (yy: number) =>
    ops.push(() =>
      page.drawLine({
        start: { x: xL, y: yy },
        end: { x: xR, y: yy },
        thickness: 1,
        color: LINE,
        dashArray: [2, 3],
      }),
    );

  let y = TY - 38;

  // eyebrow: brand mark + handle, "BUKTI SAH" on the right
  if (logoImg) {
    const img = logoImg;
    const logoY = y - 5; // snapshot — `y` mutates below; the op runs after layout
    ops.push(() => page.drawImage(img, { x: xL, y: logoY, width: 18, height: 18 }));
  }
  qText("AGENTBUFF.ID", logoImg ? xL + 24 : xL, y, 8, monoB, MUTED);
  qRight(d.locale === "en" ? "VALID RECEIPT" : "BUKTI SAH", xR, y, 8, mono, MUTED);
  y -= 52;

  // punchy display title + PAID chip on the right
  qText(t.bigTitle, xL, y, 46, bold, ACCENT);
  const titleY = y;
  const chipW = monoB.widthOfTextAtSize(t.paid, 9) + 26;
  ops.push(() => {
    page.drawRectangle({
      x: xR - chipW,
      y: titleY + 30,
      width: chipW,
      height: 19,
      color: rgb(0.9, 0.97, 0.94),
      borderColor: GREEN,
      borderWidth: 1.2,
    });
    page.drawCircle({ x: xR - chipW + 11, y: titleY + 39.5, size: 2.3, color: GREEN });
    page.drawText(t.paid, { x: xR - chipW + 18, y: titleY + 35.5, size: 9, font: monoB, color: GREEN });
  });
  y -= 16;
  qText(t.title, xL, y, 8.5, mono, MUTED);
  y -= 16;
  dash(y);
  y -= 24;

  // meta — stacked label/value, monospace
  const metaField = (lab: string, value: string, font: PDFFont = mono) => {
    qText(lab.toUpperCase(), xL, y, 7.5, monoB, MUTED);
    y -= 14;
    qText(fit(value, font, 9.5, innerW), xL, y, 9.5, font, INK);
    y -= 22;
  };
  metaField(t.receiptNo, d.receiptNo);
  metaField(t.date, fmtDate(d.dateIso, d.locale));
  if (d.billedToName) {
    qText(t.billedTo.toUpperCase(), xL, y, 7.5, monoB, MUTED);
    y -= 14;
    qText(fit(d.billedToName, monoB, 9.5, innerW), xL, y, 9.5, monoB, INK);
    y -= 13;
    qText(fit(d.billedToEmail, mono, 8.5, innerW), xL, y, 8.5, mono, MUTED);
    y -= 22;
  } else {
    metaField(t.billedTo, d.billedToEmail);
  }
  y -= 2;
  dash(y);
  y -= 22;

  // line item with a header row
  qText(t.desc.toUpperCase(), xL, y, 7.5, monoB, MUTED);
  qRight(t.amount.toUpperCase(), xR, y, 7.5, monoB, MUTED);
  y -= 20;
  const amtStr = rupiah(d.amountRp);
  const amtW = mono.widthOfTextAtSize(amtStr, 9.5);
  qText(fit(d.description, mono, 9.5, innerW - amtW - 16), xL, y, 9.5, mono, INK);
  qRight(amtStr, xR, y, 9.5, mono, INK);
  y -= 20;
  dash(y);
  y -= 34;

  // TOTAL — big, the climax of the slip
  qText(t.total, xL, y, 22, bold, INK);
  qRight(rupiah(d.amountRp), xR, y + 1, 22, bold, ACCENT);
  y -= 20;
  dash(y);
  y -= 22;

  // payment provenance — label left, value right (so "siapa bayar apa" is clear)
  const refRow = (lab: string, value: string) => {
    qText(lab.toUpperCase(), xL, y, 7.5, monoB, MUTED);
    const labW = monoB.widthOfTextAtSize(lab.toUpperCase(), 7.5);
    qRight(fit(value, mono, 8.5, innerW - labW - 12), xR, y, 8.5, mono, INK);
    y -= 18;
  };
  const method = formatPaymentMethod(d.paymentMethod);
  if (method) refRow(t.method, method);
  if (d.orderId) refRow(t.orderId, d.orderId);
  if (d.paymentRef) refRow(t.payRef, d.paymentRef);
  y -= 16;

  // decorative barcode (bar widths derived from the receipt no.) + the number
  const bcW = 220;
  const bcX = RX + (RW - bcW) / 2;
  const bcTop = y;
  const bcH = 38;
  ops.push(() => {
    let bx = bcX;
    let i = 0;
    while (bx < bcX + bcW - 1) {
      const c = d.receiptNo.charCodeAt(i % d.receiptNo.length) + i * 7;
      const bw = (c % 3) + 1;
      const gap = (c % 2) + 1.5;
      if ((c >> 1) % 4 !== 0) {
        page.drawRectangle({ x: bx, y: bcTop - bcH, width: bw, height: bcH, color: INK });
      }
      bx += bw + gap;
      i++;
    }
  });
  y -= bcH + 12;
  qText(
    d.receiptNo,
    RX + (RW - mono.widthOfTextAtSize(d.receiptNo, 7)) / 2,
    y,
    7,
    mono,
    MUTED,
  );
  y -= 22;
  dash(y);
  y -= 18;

  // legal note (wrapped, mono) + thank-you line
  const noteWords = t.note.split(" ");
  const noteLines: string[] = [];
  let lb = "";
  for (const w of noteWords) {
    const test = lb ? `${lb} ${w}` : w;
    if (mono.widthOfTextAtSize(test, 7) > innerW) {
      noteLines.push(lb);
      lb = w;
    } else {
      lb = test;
    }
  }
  if (lb) noteLines.push(lb);
  for (const ln of noteLines) {
    qText(ln, xL, y, 7, mono, MUTED);
    y -= 11;
  }
  y -= 8;
  qText(t.thanks.toUpperCase(), xL, y, 8, monoB, ACCENT);
  y -= 8;

  // ── Paint: surface, slip (sized to content), torn edges, content ──
  const paperBottom = y - 22;
  const paperH = TY - paperBottom;

  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: PAGE_BG });
  // soft drop shadow
  page.drawRectangle({ x: RX + 5, y: paperBottom - 5, width: RW, height: paperH, color: rgb(0, 0, 0), opacity: 0.07 });
  // the paper
  page.drawRectangle({ x: RX, y: paperBottom, width: RW, height: paperH, color: PAPER });

  // torn perforated edges — adjacent bg-coloured teeth carve a sawtooth into
  // the white paper at the top and bottom edges.
  const TOOTH_W = 11;
  const TOOTH_H = 6;
  const carve = (yEdge: number, into: number) => {
    let x0 = RX;
    while (x0 < RR) {
      const x1 = Math.min(x0 + TOOTH_W, RR);
      page.drawSvgPath(`M ${x0} 0 L ${x1} 0 L ${(x0 + x1) / 2} ${into} Z`, {
        x: 0,
        y: yEdge,
        color: PAGE_BG,
      });
      x0 = x1;
    }
  };
  carve(TY, TOOTH_H); // top edge: teeth point down into the paper
  carve(paperBottom, -TOOTH_H); // bottom edge: teeth point up into the paper

  for (const op of ops) op();

  const bytes = await doc.save();
  return Buffer.from(bytes);
}
