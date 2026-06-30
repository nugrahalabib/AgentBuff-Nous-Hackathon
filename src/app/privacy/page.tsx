import { Suspense } from "react";
import { PrivacyClient } from "@/components/legal/privacy-client";

export const metadata = {
  title: "Kebijakan Privasi — AgentBuff",
};

export default function PrivacyPage() {
  return (
    <Suspense>
      <PrivacyClient />
    </Suspense>
  );
}
