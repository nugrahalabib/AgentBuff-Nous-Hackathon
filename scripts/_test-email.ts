// Throwaway: send the FINAL receipt email WITH the official PDF attached —
// exactly what the real settle flow produces (id + en). Sends to SMTP_USER.
//   pnpm tsx --env-file=.env.local scripts/_test-email.ts
import { sendEmail, mailerConfigured } from "@/lib/email/mailer";
import { paymentReceiptEmail } from "@/lib/email/templates";
import { generateReceiptPdf, receiptNumber } from "@/lib/billing/receipt-pdf";

async function main() {
  console.log("mailerConfigured:", mailerConfigured());
  const to = process.env.SMTP_USER;
  if (!to) {
    console.error("SMTP_USER not set — nothing to send to.");
    process.exit(1);
  }

  const txId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  const createdAt = new Date();
  const receiptNo = receiptNumber(txId, createdAt);
  const description = "OP Buff (langganan bulanan)";
  const amountRp = 99000;

  for (const locale of ["id", "en"] as const) {
    const pdf = await generateReceiptPdf({
      receiptNo,
      dateIso: createdAt.toISOString(),
      description,
      amountRp,
      paymentRef: "T1781600000000XYZ",
      orderId: "SUB-1606ca50-1781600000000",
      billedToEmail: to,
      locale,
    });
    const content = paymentReceiptEmail({ description, amountRp }, locale);
    const ok = await sendEmail({
      to,
      subject: `[FINAL ${locale}] ${content.subject}`,
      html: content.html,
      text: content.text,
      attachments: [{ filename: `Struk-${receiptNo}.pdf`, content: pdf }],
    });
    console.log(
      `  ${ok ? "✓" : "✗"} ${locale} receipt + attachment Struk-${receiptNo}.pdf → ${content.subject}`,
    );
  }
  console.log(`\nsent to ${to} — open the email and check the PDF attachment.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
