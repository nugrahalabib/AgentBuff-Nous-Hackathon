// Throwaway: does createSnapTransaction actually produce a Snap token with the
// configured keys + endpoint? This is the root-cause check for "can't pay".
//   pnpm tsx --env-file=.env.local scripts/_test-snap.ts
import { createSnapTransaction } from "@/lib/midtrans";

async function main() {
  const isProd = process.env.MIDTRANS_IS_PRODUCTION;
  const sk = (process.env.MIDTRANS_SERVER_KEY ?? "").slice(0, 14);
  const endpoint = isProd === "true" ? "app.midtrans.com" : "app.sandbox.midtrans.com";
  console.log(`MIDTRANS_IS_PRODUCTION=${isProd} → endpoint ${endpoint}`);
  console.log(`serverKey prefix=${sk}...`);
  try {
    const snap = await createSnapTransaction({
      orderId: `SNAPTEST-${Date.now()}`,
      grossAmount: 99000,
      customerEmail: "test@agentbuff.id",
      itemDetails: [{ id: "op_buff", price: 99000, quantity: 1, name: "OP Buff (monthly)" }],
    });
    console.log("\nSUCCESS — Snap token created:");
    console.log("  token:", snap.token);
    console.log("  redirect_url:", snap.redirect_url);
  } catch (e) {
    console.error("\nFAILED to create Snap token");
    console.error("  message:", e instanceof Error ? e.message : e);
    const data = (e as { data?: unknown })?.data;
    if (data) console.error("  midtrans response:", JSON.stringify(data));
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
