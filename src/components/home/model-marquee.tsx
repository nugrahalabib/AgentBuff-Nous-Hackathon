"use client";

import { motion } from "framer-motion";
import Image from "next/image";
import { useI18n } from "@/lib/i18n/context";

/* ─── Providers we actually support — mirrors /app/providers (logos +
   names from providers-tab.tsx LOGO_BY_BASE / FULL_NAME). OpenClaw kept and
   merged in per Chief. Logos are the optimized 96px webp in
   public/images/providers/* (OpenClaw keeps its existing asset). ─── */
const models = [
  { name: "OpenAI", logo: "/images/providers/openai.webp" },
  { name: "Anthropic", logo: "/images/providers/anthropic.webp" },
  { name: "Gemini", logo: "/images/providers/gemini.webp" },
  { name: "DeepSeek", logo: "/images/providers/deepseek.webp" },
  { name: "xAI", logo: "/images/providers/xai.webp" },
  { name: "Groq", logo: "/images/providers/groq.webp" },
  { name: "Mistral", logo: "/images/providers/mistral.webp" },
  { name: "OpenRouter", logo: "/images/providers/openrouter.webp" },
  { name: "Qwen", logo: "/images/providers/qwen.webp" },
  { name: "Kimi", logo: "/images/providers/kimi.webp" },
  { name: "MiniMax", logo: "/images/providers/minimax.webp" },
  { name: "Z.AI", logo: "/images/providers/zai.webp" },
  { name: "Cerebras", logo: "/images/providers/cerebras.webp" },
  { name: "Fireworks", logo: "/images/providers/fireworks.webp" },
  { name: "NVIDIA", logo: "/images/providers/nvidia.webp" },
  { name: "Novita", logo: "/images/providers/novita.webp" },
  { name: "Ollama", logo: "/images/providers/ollama.webp" },
  { name: "LM Studio", logo: "/images/providers/lm.webp" },
  { name: "Azure", logo: "/images/providers/azure.webp" },
  { name: "Alibaba", logo: "/images/providers/alibaba.webp" },
  { name: "StepFun", logo: "/images/providers/stepfun.webp" },
  { name: "GMI", logo: "/images/providers/gmi.webp" },
  { name: "Arcee AI", logo: "/images/providers/arcee.webp" },
  { name: "KiloCode", logo: "/images/providers/kilocode.webp" },
  { name: "Xiaomi MiMo", logo: "/images/providers/xiaomi.webp" },
  { name: "OpenCode", logo: "/images/providers/opencode.webp" },
  { name: "Hermes", logo: "/images/providers/nous.webp" },
  { name: "OpenClaw", logo: "/images/integration/models/Openclaw.webp" },
];

/* ─── Single logo card ─── */
function ModelCard({ name, logo }: { name: string; logo: string }) {
  return (
    <div className="group relative flex shrink-0 items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-3 backdrop-blur-md transition-all duration-300 hover:border-cyan-500/30 hover:bg-cyan-50/50 hover:shadow-[0_0_20px_-5px_rgba(34,211,238,0.15)] dark:border-white/[0.06] dark:bg-white/[0.03] dark:hover:border-cyan-400/20 dark:hover:bg-white/[0.06]">
      <div className="relative size-8 overflow-hidden rounded-lg sm:size-9">
        <Image
          src={logo}
          alt={name}
          fill
          unoptimized
          className="object-contain transition-transform duration-300 group-hover:scale-110"
          sizes="36px"
        />
      </div>
      <span className="text-sm font-medium text-slate-600 transition-colors duration-300 group-hover:text-slate-900 dark:text-white/50 dark:group-hover:text-white/80">
        {name}
      </span>
    </div>
  );
}

/* ─── Seamless Marquee row ─── */
function MarqueeRow({
  items,
  direction = "left",
  speed = 40,
}: {
  items: typeof models;
  direction?: "left" | "right";
  speed?: number;
}) {
  const animClass = direction === "left" ? "animate-marquee-left" : "animate-marquee-right";

  return (
    <div className="relative flex overflow-hidden">
      {/* Fade edges */}
      <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-16 bg-gradient-to-r from-slate-50 to-transparent dark:from-[#030014] sm:w-28" />
      <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-16 bg-gradient-to-l from-slate-50 to-transparent dark:from-[#030014] sm:w-28" />

      {/* Two identical tracks side by side = truly seamless loop */}
      <div
        className={`flex shrink-0 ${animClass}`}
        style={{ animationDuration: `${speed}s` }}
      >
        {/* Track A */}
        <div className="flex shrink-0 gap-4 pr-4">
          {items.map((model, i) => (
            <ModelCard key={`a-${i}`} name={model.name} logo={model.logo} />
          ))}
        </div>
        {/* Track B (identical clone) */}
        <div className="flex shrink-0 gap-4 pr-4">
          {items.map((model, i) => (
            <ModelCard key={`b-${i}`} name={model.name} logo={model.logo} />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════
   MAIN — Model Integration Marquee
   ═══════════════════════════════════════════════════ */
export function HomeModelMarquee() {
  // Row 2 rotated by half so it reads differently from row 1 (works for any
  // list length — no hardcoded index list to drift out of sync).
  const half = Math.ceil(models.length / 2);
  const row2Order = [...models.slice(half), ...models.slice(0, half)];
  const { t } = useI18n();

  return (
    <section className="relative overflow-hidden bg-slate-50 py-6 dark:bg-[#030014] sm:py-8">
      {/* ── Title ── */}
      <motion.h2
        className="mb-5 text-center text-base font-bold text-slate-600 dark:text-white/40 sm:mb-6 sm:text-lg"
        style={{ fontFamily: "var(--font-display), var(--font-sans)" }}
        initial={{ y: 10 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.4 }}
      >
        {t.modelMarquee.title}{" "}
        <span className="bg-gradient-to-r from-cyan-400 to-violet-400 bg-clip-text text-transparent">
          {t.modelMarquee.highlight}
        </span>
      </motion.h2>

      {/* ── Row 1 — all 12 models, scrolls left ── */}
      <div className="mb-3">
        <MarqueeRow items={models} direction="left" speed={45} />
      </div>

      {/* ── Row 2 — all 12 models shuffled, scrolls right ── */}
      <MarqueeRow items={row2Order} direction="right" speed={50} />

      {/* Marquee keyframes */}
      <style>{`
        @keyframes marquee-left {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        @keyframes marquee-right {
          0% { transform: translateX(-50%); }
          100% { transform: translateX(0); }
        }
        .animate-marquee-left {
          animation: marquee-left 45s linear infinite;
        }
        .animate-marquee-right {
          animation: marquee-right 50s linear infinite;
        }
      `}</style>
    </section>
  );
}
