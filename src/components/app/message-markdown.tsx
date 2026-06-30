"use client";

import React, { memo, useCallback, useMemo, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import "katex/dist/katex.min.css";
import { cn } from "@/lib/utils";
import { BuffhubSkills, BuffhubPurchase, BuffhubPosReport } from "./buffhub-cards";

// XSS / safety notes:
// - react-markdown v10 escapes raw HTML by default (no rehype-raw plugged in here).
// - We override urlTransform with an EXPLICIT whitelist below (defense in depth) —
//   it rejects javascript:, vbscript:, data: (except image/* MIME types on <img>),
//   file:, blob:, view-source:, and only allows http(s)://, mailto:, tel:, mms:,
//   relative URLs, and hash fragments.
// - rehypeHighlight operates on text nodes only; it cannot inject <script> etc.
// - Anchor component below forces target=_blank + rel=noopener noreferrer nofollow.
// - Image component restricts to safe schemes + loading=lazy + onError fallback.

/**
 * Strict URL scheme whitelist for anchor + image hrefs. Rejects payloads
 * that the default react-markdown sanitizer permits (notably `data:` URIs
 * pointing at non-image MIME types).
 *
 * Allowed schemes:
 *   - relative paths: "/foo", "foo", "./bar", "../baz"
 *   - hash fragments: "#anchor"
 *   - protocol-relative: "//host.com/path"
 *   - http://, https://, mailto:, tel:, mms:
 *
 * For anchors: data: + blob: + javascript: + vbscript: + file: + view-source:
 * are stripped (replaced with "#").
 *
 * For images: data:image/(png|jpg|jpeg|gif|webp|svg+xml);base64,... is allowed;
 * blob: URLs from our own attachment pipeline are allowed; everything else
 * stripped same as anchors.
 */
function safeUrlForAnchor(url: string | undefined): string {
  if (!url) return "";
  const trimmed = url.trim();
  if (!trimmed) return "";
  // Fragment-only or relative paths: allow.
  if (trimmed.startsWith("#") || trimmed.startsWith("/") || trimmed.startsWith(".")) {
    return trimmed;
  }
  // Protocol-relative (//host/path) — treated as same-protocol by browsers, safe.
  if (trimmed.startsWith("//")) {
    return trimmed;
  }
  // Lowercase scheme prefix check (case-insensitive).
  const colonIndex = trimmed.indexOf(":");
  if (colonIndex === -1) {
    // No scheme: treat as relative.
    return trimmed;
  }
  const scheme = trimmed.slice(0, colonIndex).toLowerCase();
  if (scheme === "http" || scheme === "https" || scheme === "mailto" || scheme === "tel" || scheme === "mms") {
    return trimmed;
  }
  // Disallow data:, blob:, javascript:, vbscript:, file:, view-source:, anything else.
  return "";
}

function safeUrlForImage(url: string | undefined): string {
  if (!url) return "";
  const trimmed = url.trim();
  if (!trimmed) return "";
  // Relative + fragment + protocol-relative same as anchor.
  if (trimmed.startsWith("#") || trimmed.startsWith("/") || trimmed.startsWith(".") || trimmed.startsWith("//")) {
    return trimmed;
  }
  const colonIndex = trimmed.indexOf(":");
  if (colonIndex === -1) return trimmed;
  const scheme = trimmed.slice(0, colonIndex).toLowerCase();
  if (scheme === "http" || scheme === "https") {
    return trimmed;
  }
  // blob: from our own attachment pipeline (composer paste/drag) — safe.
  if (scheme === "blob") {
    return trimmed;
  }
  // data:image/* only — block data:text/html, data:application/javascript, etc.
  if (scheme === "data") {
    const lower = trimmed.toLowerCase();
    // Match data:image/(allowed-mime); — explicit allowlist.
    if (
      lower.startsWith("data:image/png") ||
      lower.startsWith("data:image/jpeg") ||
      lower.startsWith("data:image/jpg") ||
      lower.startsWith("data:image/gif") ||
      lower.startsWith("data:image/webp") ||
      lower.startsWith("data:image/svg+xml")
    ) {
      return trimmed;
    }
  }
  return "";
}

/** react-markdown urlTransform — runs for every href/src before the components
 *  receive it. Belt-and-suspenders with `safeUrlForAnchor`/`safeUrlForImage`
 *  in the components below: catches anchors/images in deeply-nested rendering
 *  paths (custom plugins) where we don't have a component override. */
function urlTransform(url: string, key: string): string {
  if (key === "src") return safeUrlForImage(url);
  // href + cite + action + formaction + everything else: treat as anchor.
  return safeUrlForAnchor(url);
}

type CodeProps = ComponentPropsWithoutRef<"code"> & { inline?: boolean };

function extractCodeBlock(children: ReactNode): { text: string; lang: string | null } {
  // react-markdown passes <pre><code class="language-xyz">…</code></pre>; we receive
  // the <code> child here with its props embedded in children.
  let text = "";
  let lang: string | null = null;
  const walk = (node: ReactNode): void => {
    if (node == null || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") {
      text += String(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === "object" && "props" in node) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const el = node as { props: any };
      if (el.props?.className && typeof el.props.className === "string" && !lang) {
        const m = el.props.className.match(/language-([\w-]+)/);
        if (m) lang = m[1];
      }
      walk(el.props?.children);
    }
  };
  walk(children);
  return { text, lang };
}

// P2 — large code block lazy highlighting threshold. rehypeHighlight has to
// tokenize the full code text on every render; for replies that dump 5-10K
// lines of code (rare but possible), this dominates streaming render cost.
// Above this threshold we drop the `hljs` class so rehypeHighlight skips the
// tokenization pass and the block renders as plain monospace text.
const LARGE_CODE_THRESHOLD = 6000;

function CodeBlock({ children }: { children: ReactNode }) {
  const { text, lang } = useMemo(() => extractCodeBlock(children), [children]);
  const [copied, setCopied] = useState(false);
  const isLarge = text.length > LARGE_CODE_THRESHOLD;

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API blocked (insecure context or permissions). Fail silent.
    }
  }, [text]);

  return (
    <div className="group relative my-3 overflow-hidden rounded-lg border border-border bg-[#0d1117]">
      <div className="flex items-center justify-between border-b border-border/60 bg-black/20 px-3 py-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {lang ?? "code"}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className={cn(
            "rounded border border-border/60 bg-background/40 px-2 py-0.5 text-[10px] font-medium transition",
            copied
              ? "text-emerald-400"
              : "text-muted-foreground hover:text-foreground",
          )}
          aria-label={copied ? "Tersalin" : "Salin kode"}
        >
          {copied ? "Tersalin" : "Salin"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-[13px] leading-relaxed">
        {isLarge ? (
          // For very large blocks, skip the syntax-highlighted children and
          // render the plain text. Preserves performance + still copyable.
          <code className="block whitespace-pre font-mono text-foreground/85">
            {text}
          </code>
        ) : (
          children
        )}
      </pre>
      {isLarge ? (
        <div className="border-t border-border/60 bg-black/20 px-3 py-1 text-[10px] text-muted-foreground">
          Syntax highlight dimatikan untuk kode besar ({text.length.toLocaleString("id-ID")} karakter)
        </div>
      ) : null}
    </div>
  );
}

/**
 * Markdown image with a graceful broken-image fallback. If the URL fails to
 * load (durable file evicted, 404, network), we replace the native broken
 * glyph with a small labelled card — so a missing image never looks like a
 * rendering bug. (Chief: "kalau sudah hilang atau rusak ya jangan di munculin".)
 */
function MarkdownImage({ src, alt }: { src: string; alt: string }) {
  const [errored, setErrored] = useState(false);
  if (errored) {
    return (
      <span className="my-2 inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
        {alt || "Gambar tidak bisa dimuat"}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setErrored(true)}
      className="my-2 max-h-[480px] max-w-full rounded-md border border-border/60 bg-muted/20 object-contain"
    />
  );
}

// ── Inline media kind dispatch ───────────────────────────────────────────────
// The agent (esp. gpt/codex) embeds non-image media using IMAGE markdown syntax
// `![alt](http://.../x.mp4)` / `![alt](http://.../x.mp3)`. A raw <img> can't
// decode those → broken glyph. We classify the URL by extension and render a
// real <video>/<audio> player (or a download chip for documents) instead, so
// EVERY file the agent inlines displays/plays — not just images.
const VIDEO_EXTS = new Set([
  "mp4", "webm", "mov", "mkv", "avi", "m4v", "ogv", "3gp", "3g2", "mpeg", "mpg", "qt",
]);
const AUDIO_EXTS = new Set([
  "mp3", "ogg", "oga", "opus", "wav", "m4a", "flac", "aac", "amr", "weba", "3ga", "mid", "midi",
]);
const IMAGE_EXTS = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "bmp", "heic", "heif", "ico", "apng", "jfif",
]);

function urlBasename(url: string): string {
  const clean = url.split("?")[0].split("#")[0];
  const seg = clean.slice(clean.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(seg) || "berkas";
  } catch {
    return seg || "berkas";
  }
}

function urlExtension(url: string): string {
  const seg = url.split("?")[0].split("#")[0];
  const base = seg.slice(seg.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Classify a media URL by its file extension. Unknown / extensionless URLs
 *  default to "image" — the markdown `![]()` author intent — so existing image
 *  behaviour is unchanged; only clearly-video/audio/doc URLs are re-routed. */
function classifyMediaUrl(url: string): "image" | "video" | "audio" | "other" {
  const ext = urlExtension(url);
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (IMAGE_EXTS.has(ext) || ext === "") return "image";
  return "other";
}

/** Clickable open/download chip for media that can't render inline (player
 *  load failure) OR a non-media document that slipped into `![]()` image
 *  syntax. Always gives the user a way to GET the file rather than a dead
 *  broken-image glyph. */
function MediaFileChip({ src, label }: { src: string; label?: string }) {
  return (
    <a
      href={src}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="my-2 inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5 text-xs text-foreground/80 transition hover:border-primary/40 hover:text-foreground"
    >
      <span className="truncate">{label || urlBasename(src)}</span>
      <span className="shrink-0 text-muted-foreground">· open</span>
    </a>
  );
}

function MarkdownVideo({ src, alt }: { src: string; alt: string }) {
  const [errored, setErrored] = useState(false);
  if (errored) {
    return <MediaFileChip src={src} label={alt || "Video tidak bisa dimuat"} />;
  }
  return (
    <video
      src={src}
      controls
      preload="metadata"
      onError={() => setErrored(true)}
      className="my-2 max-h-[480px] max-w-full rounded-md border border-border/60 bg-black"
    />
  );
}

function MarkdownAudio({ src, alt }: { src: string; alt: string }) {
  const [errored, setErrored] = useState(false);
  if (errored) {
    return <MediaFileChip src={src} label={alt || "Audio tidak bisa dimuat"} />;
  }
  return (
    <audio
      src={src}
      controls
      preload="metadata"
      onError={() => setErrored(true)}
      className="my-2 w-full max-w-[420px]"
    />
  );
}

const components: Components = {
  // Block code: BuffHub structured blocks render as rich cards; everything else
  // wraps in CodeBlock (copy button + language tag).
  pre: ({ children }) => {
    const { text, lang } = extractCodeBlock(children);
    if (lang === "agentbuff-skills") return <BuffhubSkills raw={text} />;
    if (lang === "agentbuff-purchase") return <BuffhubPurchase raw={text} />;
    if (lang === "agentbuff-pos-report") return <BuffhubPosReport raw={text} />;
    return <CodeBlock>{children}</CodeBlock>;
  },
  code: ({ className, children, ...rest }: CodeProps) => {
    const isBlock =
      typeof className === "string" && /language-[\w-]+/.test(className);
    if (isBlock) {
      // Let <pre> wrap via CodeBlock; keep the className so rehypeHighlight
      // attaches hljs-* tokens.
      return (
        <code className={cn("hljs", className)} {...rest}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground"
        {...rest}
      >
        {children}
      </code>
    );
  },
  a: ({ href, children, ...rest }) => {
    // Strip any prop that could re-introduce inline JS injection vectors.
    const safe = safeUrlForAnchor(typeof href === "string" ? href : undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const props = rest as any;
    delete props.onClick;
    delete props.onMouseOver;
    delete props.onMouseEnter;
    delete props.onMouseLeave;
    delete props.onFocus;
    delete props.onBlur;
    delete props.onError;
    delete props.onLoad;
    return (
      <a
        href={safe || undefined}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
        {...props}
      >
        {children}
      </a>
    );
  },
  img: ({ src, alt, ...rest }) => {
    const safe = safeUrlForImage(typeof src === "string" ? src : undefined);
    if (!safe) {
      // Show alt text as fallback when URL was stripped (XSS attempt).
      return (
        <span className="rounded border border-border/60 bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
          {alt || "[gambar tidak valid]"}
        </span>
      );
    }
    // Dispatch by media kind so video/audio inlined via `![]()` syntax play in a
    // real player instead of a broken <img>, and non-media docs become a usable
    // download chip. Images keep the existing MarkdownImage (size cap + lazy +
    // labelled load-failure card).
    const kind = classifyMediaUrl(safe);
    if (kind === "video") return <MarkdownVideo src={safe} alt={alt || ""} />;
    if (kind === "audio") return <MarkdownAudio src={safe} alt={alt || ""} />;
    if (kind === "other") return <MediaFileChip src={safe} label={alt || undefined} />;
    return <MarkdownImage src={safe} alt={alt || ""} />;
  },
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  p: ({ children }) => (
    <p className="my-2 whitespace-pre-wrap leading-relaxed first:mt-0 last:mb-0">
      {children}
    </p>
  ),
  h1: ({ children }) => (
    <h1 className="mt-4 mb-2 text-xl font-semibold tracking-tight">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-4 mb-2 text-lg font-semibold tracking-tight">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-3 mb-1.5 text-base font-semibold tracking-tight">{children}</h3>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 italic text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-border" />,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="border-b border-border bg-muted/30">{children}</thead>
  ),
  th: ({ children }) => (
    <th className="px-3 py-1.5 text-left font-medium">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border-b border-border/50 px-3 py-1.5 align-top">{children}</td>
  ),
};

/** Discord-style spoiler text `||hidden||` → HTML-safe placeholder
 *  marker that we convert to a click-to-reveal span via a custom
 *  component override below. Pre-process before ReactMarkdown so the
 *  markdown lib doesn't choke on the unfamiliar syntax.
 *
 *  Also handles Discord time formatting `<t:1234567890:R>` →
 *  human-readable relative time (Intl.RelativeTimeFormat).
 */
function preprocessRichMarkdown(input: string): string {
  // Discord time format: <t:UNIX:STYLE>
  // Styles: t=time, T=time-with-sec, d=date, D=long-date, f=date-time,
  // F=long-date-time, R=relative. We render as locale-aware string.
  const DISCORD_TIME_RE = /<t:(\d+)(?::([tTdDfFR]))?>/g;
  let out = input.replace(DISCORD_TIME_RE, (_, secs, style) => {
    const ms = parseInt(secs, 10) * 1000;
    if (!Number.isFinite(ms)) return `<t:${secs}:${style}>`;
    const d = new Date(ms);
    try {
      if (style === "R") {
        // Relative time (e.g. "2 jam lalu", "dalam 3 hari")
        const diff = ms - Date.now();
        const abs = Math.abs(diff);
        const rtf = new Intl.RelativeTimeFormat("id-ID", { numeric: "auto" });
        if (abs < 60_000) {
          return rtf.format(Math.round(diff / 1000), "second");
        }
        if (abs < 3_600_000) {
          return rtf.format(Math.round(diff / 60_000), "minute");
        }
        if (abs < 86_400_000) {
          return rtf.format(Math.round(diff / 3_600_000), "hour");
        }
        if (abs < 2_592_000_000) {
          return rtf.format(Math.round(diff / 86_400_000), "day");
        }
        return d.toLocaleDateString("id-ID");
      }
      const opts: Intl.DateTimeFormatOptions =
        style === "T"
          ? { hour: "2-digit", minute: "2-digit", second: "2-digit" }
          : style === "d"
            ? { dateStyle: "short" }
            : style === "D"
              ? { dateStyle: "long" }
              : style === "F"
                ? { dateStyle: "full", timeStyle: "short" }
                : style === "f"
                  ? { dateStyle: "long", timeStyle: "short" }
                  : { hour: "2-digit", minute: "2-digit" };
      return new Intl.DateTimeFormat("id-ID", opts).format(d);
    } catch {
      return d.toISOString();
    }
  });

  // Discord-style spoilers: ||text|| → custom marker syntax that
  // ReactMarkdown handles as plain text but our `text` component
  // override post-processes into a click-to-reveal span. We pick a
  // sentinel string `​§SPOILER§​...​§/SPOILER§​`
  // (zero-width-space wraps + uncommon §) that won't collide with
  // any reasonable user content.
  out = out.replace(
    /\|\|([^|]+?)\|\|/g,
    (_, inner) => `​§SPOILER§​${inner}​§/SPOILER§​`,
  );

  return out;
}

function MessageMarkdownImpl({
  children,
  searchQuery = "",
  streaming = false,
}: {
  children: string;
  searchQuery?: string;
  /** True while this text is part of a still-streaming reply. Throttles the
   *  heavy markdown/KaTeX/highlight re-parse so a long growing message doesn't
   *  re-tokenize on every ~150ms delta. */
  streaming?: boolean;
}) {
  // Skip the (regex) preprocess while streaming — see the plain-text branch.
  const preprocessed = useMemo(
    () => (streaming ? "" : preprocessRichMarkdown(children)),
    [children, streaming],
  );
  // Stable components ref per (searchQuery) so a parent re-render that
  // changes UNRELATED state doesn't blow away the entire ReactMarkdown
  // subtree. Matches the memoization the spoiler-only `richComponents`
  // constant used to provide for free.
  const liveComponents = useMemo(
    () => makeRichComponents(searchQuery),
    [searchQuery],
  );
  // While streaming, render PLAIN text. Re-parsing markdown + KaTeX + syntax
  // highlight on EVERY ~150ms delta is an O(n) task over the WHOLE growing
  // reply — for a long reply it blocks the main thread so hard that Next route
  // navigation freezes (tab clicks queue until the reply ends, then jump) and
  // the 3D office stutters. Plain text is a cheap DOM text update with no
  // tokenization, so the thread stays free. The fully-formatted markdown
  // renders the instant the reply finalizes (this component is then called with
  // streaming=false). The hooks above run unconditionally → rules-of-hooks safe.
  if (streaming) {
    return (
      <div className="prose-sm max-w-none whitespace-pre-wrap break-words text-sm text-foreground">
        {children}
      </div>
    );
  }
  return (
    <div className="prose-sm max-w-none break-words text-sm text-foreground">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          // B4 — LaTeX math via $...$ inline and $$...$$ block syntax.
          // strict: "ignore" keeps malformed math from killing the whole
          // render — we'd rather show source than a fatal error.
          [rehypeKatex, { strict: "ignore", output: "html" }],
          [rehypeHighlight, { detect: true, ignoreMissing: true }],
        ]}
        components={liveComponents}
        urlTransform={urlTransform}
      >
        {preprocessed}
      </ReactMarkdown>
    </div>
  );
}

const SPOILER_RE =
  /​§SPOILER§​([\s\S]*?)​§\/SPOILER§​/g;

/** Click-to-reveal spoiler span (Discord/Telegram parity). */
function SpoilerSpan({ children }: { children: string }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={() => setRevealed(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") setRevealed(true);
      }}
      className={cn(
        "cursor-pointer rounded transition-all",
        revealed
          ? "bg-white/[0.06] text-white/90"
          : "bg-white/15 text-transparent select-none hover:bg-white/20",
      )}
      title={revealed ? undefined : "Klik untuk lihat spoiler"}
    >
      {children}
    </span>
  );
}

/** Wrap matches of the (case-insensitive) `query` string in a `<mark>`
 *  pill so the user can SEE which words triggered the result, not just
 *  WHICH bubble. Empty query returns the text untouched (no allocation).
 *
 *  Highlight color is amber — the universal search-highlight convention
 *  in Google + browser Find. The shadow-inset gives a subtle "tape"
 *  feel that reads clearly on the dark #0B0E14 surface without making
 *  long matches glow too hot to read (chief feedback 2026-05-24: "biar
 *  benar benar terlihat dan mata tidak pusing"). */
function processSearchHighlight(
  text: string,
  query: string,
): React.ReactNode {
  if (!query || !text) return text;
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  if (!lower.includes(q)) return text;
  const parts: React.ReactNode[] = [];
  const qLen = query.length;
  let cursor = 0;
  let idx = lower.indexOf(q);
  while (idx !== -1) {
    if (idx > cursor) parts.push(text.slice(cursor, idx));
    parts.push(
      <mark
        key={`sm-${idx}`}
        className="rounded-sm bg-amber-300/35 px-0.5 text-amber-50 shadow-[inset_0_-1px_0_rgba(252,211,77,0.55)]"
      >
        {text.slice(idx, idx + qLen)}
      </mark>,
    );
    cursor = idx + qLen;
    idx = lower.indexOf(q, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

/** Process a text node for BOTH spoiler markers AND search highlights.
 *  Spoiler split runs first so we never wrap a `§SPOILER§` token in a
 *  `<mark>` (which would render the invisible marker literal). Within
 *  each non-spoiler segment, search highlights are applied. */
function processTextNode(text: string, query: string): React.ReactNode {
  if (!text.includes("§SPOILER§")) {
    return processSearchHighlight(text, query);
  }
  const parts: React.ReactNode[] = [];
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  SPOILER_RE.lastIndex = 0;
  while ((m = SPOILER_RE.exec(text)) !== null) {
    if (m.index > lastEnd) {
      parts.push(
        <React.Fragment key={`pre-${m.index}`}>
          {processSearchHighlight(text.slice(lastEnd, m.index), query)}
        </React.Fragment>,
      );
    }
    parts.push(<SpoilerSpan key={`sp-${m.index}`}>{m[1]}</SpoilerSpan>);
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd < text.length) {
    parts.push(
      <React.Fragment key={`post-${lastEnd}`}>
        {processSearchHighlight(text.slice(lastEnd), query)}
      </React.Fragment>,
    );
  }
  return <>{parts}</>;
}

function walkAndProcessText(
  node: React.ReactNode,
  query: string,
): React.ReactNode {
  if (typeof node === "string") return processTextNode(node, query);
  if (Array.isArray(node)) {
    return node.map((child, i) => (
      <React.Fragment key={i}>
        {walkAndProcessText(child, query)}
      </React.Fragment>
    ));
  }
  return node;
}

function makeRichComponents(query: string): Components {
  return {
    ...components,
    // Override block + inline text containers so each text child gets
    // scanned for both spoiler markers AND search-query matches. The
    // factory pattern (vs. a module-level constant) is what threads
    // `query` into the walker without React context.
    p: ({ children: c }) => (
      <p className="my-2 leading-relaxed">{walkAndProcessText(c, query)}</p>
    ),
    li: ({ children: c }) => <li>{walkAndProcessText(c, query)}</li>,
    strong: ({ children: c }) => (
      <strong className="font-semibold">
        {walkAndProcessText(c, query)}
      </strong>
    ),
    em: ({ children: c }) => <em>{walkAndProcessText(c, query)}</em>,
  };
}

// Streaming re-parses on every delta (~150ms). Memoize by text identity so React
// skips reconciliation when parent re-renders for unrelated state (status pill etc.).
export const MessageMarkdown = memo(MessageMarkdownImpl);
