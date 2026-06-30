import { Suspense } from "react";
import { TermsClient } from "@/components/legal/terms-client";

export const metadata = {
  title: "Ketentuan Layanan — AgentBuff",
};

export default function TermsPage() {
  return (
    <Suspense>
      <TermsClient />
    </Suspense>
  );
}
