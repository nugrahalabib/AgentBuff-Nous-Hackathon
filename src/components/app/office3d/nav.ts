/**
 * office3d/nav.ts — grid navigation + A* pathfinding (mirrors hermes-office's
 * buildNavGrid + astar). Furniture and walls register axis-aligned footprints
 * that block grid cells (plus a small pad), so agents pathfind AROUND them and
 * never clip through. World is the XZ plane centred at origin.
 */

export type AABB = [minX: number, minZ: number, maxX: number, maxZ: number];
export type Pt = { x: number; z: number };

const CELL = 0.5;
const PAD = 0.28; // expand obstacles so agents keep clearance

export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  private readonly originX: number;
  private readonly originZ: number;
  private readonly blocked: Uint8Array;

  constructor(roomW: number, roomD: number, obstacles: AABB[]) {
    this.cols = Math.ceil(roomW / CELL);
    this.rows = Math.ceil(roomD / CELL);
    this.originX = -roomW / 2;
    this.originZ = -roomD / 2;
    this.blocked = new Uint8Array(this.cols * this.rows);

    for (const [minX, minZ, maxX, maxZ] of obstacles) {
      const c1 = this.clampC(Math.floor((minX - PAD - this.originX) / CELL));
      const c2 = this.clampC(Math.floor((maxX + PAD - this.originX) / CELL));
      const r1 = this.clampR(Math.floor((minZ - PAD - this.originZ) / CELL));
      const r2 = this.clampR(Math.floor((maxZ + PAD - this.originZ) / CELL));
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) this.blocked[r * this.cols + c] = 1;
    }
    // seal the outer border
    for (let c = 0; c < this.cols; c++) {
      this.blocked[c] = 1;
      this.blocked[(this.rows - 1) * this.cols + c] = 1;
    }
    for (let r = 0; r < this.rows; r++) {
      this.blocked[r * this.cols] = 1;
      this.blocked[r * this.cols + this.cols - 1] = 1;
    }
  }

  private clampC(c: number) {
    return Math.min(this.cols - 1, Math.max(0, c));
  }
  private clampR(r: number) {
    return Math.min(this.rows - 1, Math.max(0, r));
  }
  private toCol(x: number) {
    return this.clampC(Math.floor((x - this.originX) / CELL));
  }
  private toRow(z: number) {
    return this.clampR(Math.floor((z - this.originZ) / CELL));
  }
  private cellX(c: number) {
    return this.originX + (c + 0.5) * CELL;
  }
  private cellZ(r: number) {
    return this.originZ + (r + 0.5) * CELL;
  }
  private isFree(c: number, r: number) {
    return this.blocked[r * this.cols + c] === 0;
  }

  /** Nearest free cell to (c,r), spiralling outward. */
  private findFree(c: number, r: number): [number, number] | null {
    if (this.isFree(c, r)) return [c, r];
    for (let d = 1; d < 18; d++) {
      for (let dr = -d; dr <= d; dr++) {
        for (let dc = -d; dc <= d; dc++) {
          if (Math.abs(dr) !== d && Math.abs(dc) !== d) continue;
          const nc = c + dc;
          const nr = r + dr;
          if (nc < 0 || nr < 0 || nc >= this.cols || nr >= this.rows) continue;
          if (this.isFree(nc, nr)) return [nc, nr];
        }
      }
    }
    return null;
  }

  /** A* path of world waypoints from (sx,sz) to (gx,gz), inclusive of goal. */
  findPath(sx: number, sz: number, gx: number, gz: number): Pt[] {
    const start = this.findFree(this.toCol(sx), this.toRow(sz));
    const goal = this.findFree(this.toCol(gx), this.toRow(gz));
    if (!start || !goal) return [{ x: gx, z: gz }];
    const [sc, sr] = start;
    const [gc, gr] = goal;
    if (sc === gc && sr === gr) return [{ x: gx, z: gz }];

    const n = this.cols * this.rows;
    const open: number[] = [sr * this.cols + sc];
    const came = new Int32Array(n).fill(-1);
    const g = new Float32Array(n).fill(Infinity);
    const f = new Float32Array(n).fill(Infinity);
    const inOpen = new Uint8Array(n);
    const startIdx = sr * this.cols + sc;
    const goalIdx = gr * this.cols + gc;
    g[startIdx] = 0;
    f[startIdx] = this.h(sc, sr, gc, gr);
    inOpen[startIdx] = 1;

    const dirs = [
      [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
      [1, 1, 1.41421], [1, -1, 1.41421], [-1, 1, 1.41421], [-1, -1, 1.41421],
    ];

    while (open.length) {
      // pop lowest f (linear scan — grid is small)
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (f[open[i]] < f[open[bi]]) bi = i;
      const cur = open.splice(bi, 1)[0];
      inOpen[cur] = 0;
      if (cur === goalIdx) return this.reconstruct(came, cur, gx, gz);
      const cc = cur % this.cols;
      const cr = (cur - cc) / this.cols;
      for (const [dc, dr, cost] of dirs) {
        const nc = cc + dc;
        const nr = cr + dr;
        if (nc < 0 || nr < 0 || nc >= this.cols || nr >= this.rows) continue;
        if (!this.isFree(nc, nr)) continue;
        // prevent diagonal corner-cutting through blocked cells
        if (dc !== 0 && dr !== 0 && (!this.isFree(cc + dc, cr) || !this.isFree(cc, cr + dr))) continue;
        const ni = nr * this.cols + nc;
        const tentative = g[cur] + cost;
        if (tentative < g[ni]) {
          came[ni] = cur;
          g[ni] = tentative;
          f[ni] = tentative + this.h(nc, nr, gc, gr);
          if (!inOpen[ni]) {
            open.push(ni);
            inOpen[ni] = 1;
          }
        }
      }
    }
    return [{ x: gx, z: gz }];
  }

  private h(c: number, r: number, gc: number, gr: number) {
    const dx = Math.abs(c - gc);
    const dz = Math.abs(r - gr);
    return (dx + dz) + (1.41421 - 2) * Math.min(dx, dz);
  }

  private reconstruct(came: Int32Array, end: number, gx: number, gz: number): Pt[] {
    const cells: number[] = [];
    let cur = end;
    while (cur !== -1) {
      cells.push(cur);
      cur = came[cur];
    }
    cells.reverse();
    const pts: Pt[] = cells.map((idx) => {
      const c = idx % this.cols;
      const r = (idx - c) / this.cols;
      return { x: this.cellX(c), z: this.cellZ(r) };
    });
    // replace the final cell-centre with the exact goal for a clean arrival
    if (pts.length) pts[pts.length - 1] = { x: gx, z: gz };
    return pts;
  }
}

/** Build an AABB obstacle from a centre + (already rotated) footprint. */
export function footprintAABB(cx: number, cz: number, w: number, d: number): AABB {
  return [cx - w / 2, cz - d / 2, cx + w / 2, cz + d / 2];
}
