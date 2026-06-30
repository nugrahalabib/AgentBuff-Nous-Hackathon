"use client";

import { MotionConfig } from "framer-motion";

/**
 * Wraps a tree so every Framer Motion animation inside it respects the user's
 * `prefers-reduced-motion` setting. `reducedMotion="user"` disables transform
 * and layout animations (the infinite particle/rotation loops on the landing)
 * while keeping opacity transitions, so the page stays legible without the
 * vestibular-trigger motion. CSS keyframe animations are handled separately by
 * the blanket reset in globals.css.
 */
export function MotionProvider({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
