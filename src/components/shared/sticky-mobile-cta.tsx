"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/context";

export function StickyMobileCTA() {
  const { t } = useI18n();
  const [show, setShow] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      const heroHeight = window.innerHeight;
      setShow(window.scrollY > heroHeight * 0.8);
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ y: 100 }}
          animate={{ y: 0 }}
          exit={{ y: 100 }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/90 p-3 backdrop-blur-lg md:hidden"
        >
          <Button
            className="w-full bg-emerald-600 font-semibold text-white hover:bg-emerald-700"
            size="lg"
            asChild
          >
            <Link href="#item-shop">
              {t.hero.ctaPrimary}
              <ArrowRight className="ml-2 size-4" />
            </Link>
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
