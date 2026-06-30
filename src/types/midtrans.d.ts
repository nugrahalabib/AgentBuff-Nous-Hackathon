// Ambient type for the Midtrans snap.js runtime (loaded via <Script> from
// app.*.midtrans.com). Lets `window.snap.embed(...)` / `window.snap.pay(...)`
// typecheck in the /checkout client.

interface SnapResult {
  status_code?: string;
  status_message?: string;
  transaction_status?: string;
  order_id?: string;
  payment_type?: string;
  [k: string]: unknown;
}

interface SnapEmbedOptions {
  embedId: string;
  onSuccess?: (result: SnapResult) => void;
  onPending?: (result: SnapResult) => void;
  onError?: (result: SnapResult) => void;
  onClose?: () => void;
  language?: "id" | "en";
}

interface MidtransSnap {
  embed: (snapToken: string, options: SnapEmbedOptions) => void;
  pay: (snapToken: string, callbacks?: Omit<SnapEmbedOptions, "embedId">) => void;
  hide: () => void;
  show: () => void;
}

declare global {
  interface Window {
    snap?: MidtransSnap;
  }
}

export {};
