import type { ReactNode } from "react";

export default function BillingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[#030014] text-white flex items-start justify-center py-6 px-4">
      <div className="w-full max-w-[440px]">{children}</div>
    </div>
  );
}
