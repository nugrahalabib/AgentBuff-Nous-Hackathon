// Exclusive checkout shell — dark, premium, on-brand (matches landing/app),
// deliberately NOT the old tiny popup. Centered card on an ambient gradient.
export default function CheckoutLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative min-h-screen bg-[#030014] text-white">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-40 -top-40 size-[520px] rounded-full bg-cyan-500/15 blur-[160px]" />
        <div className="absolute -bottom-40 -right-40 size-[560px] rounded-full bg-fuchsia-500/15 blur-[180px]" />
        <div
          className="absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(99,102,241,.4) 1px,transparent 1px),linear-gradient(90deg,rgba(99,102,241,.4) 1px,transparent 1px)",
            backgroundSize: "72px 72px",
            maskImage: "radial-gradient(ellipse at center, black 30%, transparent 80%)",
          }}
        />
      </div>
      <main className="relative z-10 mx-auto flex min-h-screen w-full max-w-2xl flex-col items-center justify-center px-4 py-10">
        {children}
      </main>
    </div>
  );
}
