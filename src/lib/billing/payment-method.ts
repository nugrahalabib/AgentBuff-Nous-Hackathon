// Friendly label for the Midtrans payment_type we capture at settlement.
// Shared by the receipt PDF (server) + the Riwayat history (client) so the
// "paid via what" string is identical everywhere. Pure, no deps.
//
// `raw` is what we store on transactions.paymentMethod: the Midtrans
// payment_type, optionally suffixed with the VA bank — e.g. "qris", "gopay",
// "credit_card", "bank_transfer:bca".

const LABELS: Record<string, string> = {
  qris: "QRIS",
  gopay: "GoPay",
  shopeepay: "ShopeePay",
  shopeepay_qris: "ShopeePay",
  dana: "DANA",
  ovo: "OVO",
  linkaja: "LinkAja",
  credit_card: "Kartu Kredit/Debit",
  bank_transfer: "Transfer Bank (VA)",
  echannel: "Mandiri Bill Payment",
  permata: "Permata VA",
  bca_klikpay: "BCA KlikPay",
  bca_klikbca: "KlikBCA",
  cimb_clicks: "CIMB Clicks",
  danamon_online: "Danamon Online",
  bri_epay: "BRImo / BRI ePay",
  cstore: "Gerai Retail",
  akulaku: "Akulaku PayLater",
  kredivo: "Kredivo",
  uob_ezpay: "UOB EZPAY",
};

/**
 * Build the stored method string from a Midtrans settlement payload. For a bank
 * transfer we append the VA bank so the receipt can say which bank (e.g.
 * "bank_transfer:bca"); everything else is just the payment_type.
 */
export function midtransMethodString(
  paymentType: string | null | undefined,
  vaNumbers?: { bank?: string | null }[] | null,
): string | null {
  if (!paymentType) return null;
  const bank = vaNumbers?.[0]?.bank;
  if (paymentType === "bank_transfer" && bank) {
    return `bank_transfer:${bank.toLowerCase()}`;
  }
  return paymentType;
}

/** Human-readable payment method, e.g. "Transfer Bank (BCA)" or "QRIS". */
export function formatPaymentMethod(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const [type, bank] = raw.split(":");
  if (type === "bank_transfer" && bank) {
    return `Transfer Bank (${bank.toUpperCase()})`;
  }
  const known = LABELS[type];
  if (known) return known;
  // Fallback: title-case the raw type so an unmapped method still reads cleanly.
  return type
    .split(/[_\s]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}
