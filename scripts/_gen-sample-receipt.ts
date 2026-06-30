// Throwaway: render sample receipt PDFs (id + en) to the project root so the
// design can be eyeballed. Synthetic data only.
//   pnpm tsx --env-file=.env.local scripts/_gen-sample-receipt.ts
import fs from "node:fs/promises";
import { generateReceiptPdf, receiptNumber } from "@/lib/billing/receipt-pdf";

async function main() {
  const txId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  const createdAt = new Date();
  const receiptNo = receiptNumber(txId, createdAt);

  for (const locale of ["id", "en"] as const) {
    const pdf = await generateReceiptPdf({
      receiptNo,
      dateIso: createdAt.toISOString(),
      description: locale === "id" ? "OP Buff - Perpanjang (Bulanan)" : "OP Buff - Renewal (Monthly)",
      amountRp: 99000,
      paymentRef: "ddaa756f-e14e-4856-9667-a0537f654179",
      paymentMethod: "bank_transfer:bca",
      orderId: "SUB-c41b6c18-1781682319858",
      billedToEmail: "nugrahalabib@gmail.com",
      billedToName: "Nugraha Labib",
      locale,
    });
    const out = `_sample-struk-${locale}.pdf`;
    await fs.writeFile(out, pdf);
    const isPdf = pdf.subarray(0, 5).toString() === "%PDF-";
    console.log(`  ${out} — ${pdf.length} bytes — valid PDF: ${isPdf} — no: ${receiptNo}`);
  }
  console.log("\nopen _sample-struk-id.pdf / _sample-struk-en.pdf to review.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
