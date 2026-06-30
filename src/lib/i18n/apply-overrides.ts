// D8 landing-CMS overlay helpers. CMS keys are real i18n dot-paths (e.g.
// "hero.titleLine1", "faq.items"); an override REPLACES the whole node at that
// path. Immutable: clones along the path, never mutates the base dictionary, so
// an unset key always falls back to the compiled-in i18n value.

/** Read the node at a dot-path (used for "current default" + reset-to-default). */
export function getAtPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Return a copy of `obj` with the node at `path` replaced by `value`. Clones
 *  only the spine touched; sibling nodes are shared (cheap). Missing segments
 *  are created as objects. */
function setAtPath<T>(obj: T, path: string, value: unknown): T {
  const segs = path.split(".");
  const root: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    const next = cur[seg];
    cur[seg] =
      next && typeof next === "object" && !Array.isArray(next)
        ? { ...(next as Record<string, unknown>) }
        : {};
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]] = value;
  return root as T;
}

/** Apply a flat map of { "dot.path": value } overrides onto a dictionary,
 *  replacing each addressed node. Returns a new dictionary (base untouched). */
export function applyDotPathOverrides<T>(
  dict: T,
  overrides: Record<string, unknown> | undefined,
): T {
  if (!overrides) return dict;
  let out = dict;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) continue;
    out = setAtPath(out, key, value);
  }
  return out;
}
