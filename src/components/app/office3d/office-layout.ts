/**
 * office3d/office-layout.ts — the AgentBuff 3D office floor plan (denah).
 *
 * Hub-and-rooms architectural plan in a 44 x 30 world (1u ~= 1m). A central open
 * workspace is the circulation hub; perimeter rooms open onto it / the N-S
 * corridors (x[-11,-9] and x[9,11]) through doorway gaps in the interior walls.
 * Reception is at the south entrance; back-of-house (server, QA) sits north;
 * amenities (gym, game, lounge, art studio) are distributed. Furniture uses the
 * proportion/tint catalog (furniture-catalog.ts) + procedural builders
 * (procedural.ts). Palette mirrors hermes-office (MIT).
 */
import type { FurnitureType } from "./furniture-catalog";

export const ROOM = { w: 44, d: 30, wallH: 3.6 };
const HW = ROOM.w / 2;
const HD = ROOM.d / 2;

export const PALETTE = {
  floorWood: 0xc8a97e,
  wallOuter: 0x222a30,
  wallInner: 0x2b343b,
  baseboard: 0x3a3229,
  windowGlow: 0xeaf2ff,
  neonCyan: 0x22d3ee,
  neonViolet: 0x8b5cf6,
  neonPink: 0xf472b6,
} as const;

export type Placement = { type: FurnitureType; x: number; z: number; rot?: number; y?: number };
export type WallSeg = { cx: number; cz: number; sx: number; sz: number };
export type Rug = { cx: number; cz: number; w: number; d: number; color: number; opacity?: number };
export type WindowPanel = { cx: number; cz: number; w: number; h: number; axis: "x" | "z" };
export type WallArt = { cx: number; cz: number; w: number; h: number; axis: "x" | "z"; color: number; emissive?: boolean };
export type Workstation = { id: string; deskPos: [number, number]; rot: number; seat: [number, number] };
export type Lamp = { x: number; z: number; color?: number };

// ---- zone carpets ----------------------------------------------------------
export const RUGS: Rug[] = [
  { cx: 0, cz: 1, w: 17, d: 13, color: 0xb9a07f, opacity: 0.45 }, // workspace
  { cx: -16, cz: -10.5, w: 9.5, d: 6.5, color: 0x5f7e52, opacity: 0.7 }, // meeting
  { cx: -16, cz: -2, w: 9.5, d: 7.5, color: 0x6b5a44, opacity: 0.55 }, // art studio
  { cx: -16, cz: 8.5, w: 9.5, d: 10.5, color: 0x2f4a55, opacity: 0.55 }, // lounge
  { cx: 16, cz: -10.5, w: 9.5, d: 6.5, color: 0x243042, opacity: 0.6 }, // qa lab
  { cx: 16, cz: -2, w: 9.5, d: 7.5, color: 0xc9ae8d, opacity: 0.5 }, // pantry
  { cx: 16, cz: 8.5, w: 9.5, d: 10.5, color: 0x3b2d63, opacity: 0.6 }, // game
  { cx: -5.5, cz: -10.5, w: 6.5, d: 6.5, color: 0x141b22, opacity: 0.95 }, // server
  { cx: 3.5, cz: -10.5, w: 10.5, d: 6.5, color: 0x1f2937, opacity: 0.75 }, // gym
  { cx: 0, cz: 11.5, w: 12, d: 5.5, color: 0x9a8468, opacity: 0.5 }, // reception
];

// ---- interior walls (with door gaps) ---------------------------------------
const T = 0.25;
/** Build a straight wall line with door gaps. axis 'x' = vertical (constant x,
 *  spans z); axis 'z' = horizontal (constant z, spans x). gaps = ranges on the
 *  spanning axis to leave open. */
function wallLine(axis: "x" | "z", at: number, from: number, to: number, gaps: [number, number][] = []): WallSeg[] {
  const segs: WallSeg[] = [];
  const cuts = [from, ...gaps.flat(), to];
  for (let i = 0; i < cuts.length; i += 2) {
    const a = cuts[i];
    const b = cuts[i + 1];
    if (b - a < 0.05) continue;
    const mid = (a + b) / 2;
    const len = b - a;
    if (axis === "x") segs.push({ cx: at, cz: mid, sx: T, sz: len });
    else segs.push({ cx: mid, cz: at, sx: len, sz: T });
  }
  return segs;
}

export const INTERIOR_WALLS: WallSeg[] = [
  // West rooms east wall (x=-11) with doors to corridor
  ...wallLine("x", -11, -HD, HD, [[-10.6, -9.0], [-2.8, -1.2], [6.4, 8.0]]),
  // East rooms west wall (x=11) with doors to corridor
  ...wallLine("x", 11, -HD, HD, [[-10.6, -9.0], [-2.8, -1.2], [6.4, 8.0]]),
  // West room separators
  ...wallLine("z", -7, -HW, -11),
  ...wallLine("z", 2, -HW, -11),
  // East room separators
  ...wallLine("z", -7, 11, HW),
  ...wallLine("z", 2, 11, HW),
  // North rooms (server/gym) | workspace, doors into workspace
  ...wallLine("z", -7, -9, 9, [[-7, -5.4], [3.0, 4.6]]),
  // Server | Gym divider
  ...wallLine("x", -2, -HD, -7),
  // Enclose server (west) + gym (east) from the N-S corridors — these sides
  // were left open. Each room is still reached via its door in the z=-7 wall.
  ...wallLine("x", -9, -HD, -7),
  ...wallLine("x", 9, -HD, -7),
  // Reception partition stubs (wide lobby opening x[-6,6])
  ...wallLine("z", 8.5, -9, 9, [[-6, 6]]),
];

// ---- exterior windows ------------------------------------------------------
export const WINDOWS: WindowPanel[] = [
  { cx: -16, cz: HD, w: 5, h: 1.9, axis: "x" },
  { cx: 16, cz: HD, w: 5, h: 1.9, axis: "x" },
  { cx: -16, cz: -HD, w: 4, h: 1.9, axis: "x" },
  { cx: 16, cz: -HD, w: 4, h: 1.9, axis: "x" },
  { cx: -HW, cz: -10.5, w: 4, h: 1.9, axis: "z" },
  { cx: -HW, cz: 8, w: 5, h: 1.9, axis: "z" },
  { cx: HW, cz: -10.5, w: 4, h: 1.9, axis: "z" },
  { cx: HW, cz: 8, w: 5, h: 1.9, axis: "z" },
];

// ---- wall art / neon signs -------------------------------------------------
export const WALL_ART: WallArt[] = [
  { cx: -16, cz: -HD + 0.16, w: 2.6, h: 1.6, axis: "x", color: PALETTE.neonViolet, emissive: true }, // meeting
  { cx: -16, cz: 2 - 0.16, w: 2.2, h: 1.4, axis: "x", color: 0xf59e0b, emissive: true }, // art studio sign
  { cx: -HW + 0.12, cz: -4.6, w: 1.5, h: 1.1, axis: "z", color: 0xd97706 }, // framed painting
  { cx: -HW + 0.12, cz: -0.2, w: 1.5, h: 1.1, axis: "z", color: 0x9333ea }, // framed painting
  { cx: 16, cz: 14.5, w: 3.2, h: 1.0, axis: "x", color: PALETTE.neonCyan, emissive: true }, // GAME neon
];

// ---- open-workspace desk pods ----------------------------------------------
export const WORKSTATIONS: Workstation[] = (() => {
  const out: Workstation[] = [];
  let i = 0;
  // three back-to-back benches; each bench = 4 desks in a row, seats on +z side
  const rows: { z: number; rot: number; seatDz: number }[] = [
    { z: -4.2, rot: 0, seatDz: 0.95 },
    { z: 0.6, rot: 0, seatDz: 0.95 },
    { z: 5.4, rot: 0, seatDz: 0.95 },
  ];
  const cols = [-6.5, -2.4, 2.4, 6.5];
  for (const r of rows) {
    for (const x of cols) {
      out.push({ id: `desk-${i++}`, deskPos: [x, r.z], rot: r.rot, seat: [x, r.z + r.seatDz] });
    }
  }
  return out;
})();

// ---- furniture placements (per zone) ---------------------------------------
function ring(type: FurnitureType, cx: number, cz: number, radius: number, n: number, faceIn = true): Placement[] {
  const out: Placement[] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const x = cx + Math.cos(a) * radius;
    const z = cz + Math.sin(a) * radius;
    // chairDesk faces +z at rot 0; aim each chair at the ring centre
    const inward = Math.atan2(-Math.cos(a), -Math.sin(a));
    out.push({ type, x, z, rot: faceIn ? inward : inward + Math.PI });
  }
  return out;
}

export const PLACEMENTS: Placement[] = [
  // ===== Meeting room (W-N) =====
  { type: "roundTable", x: -16, z: -10.5 },
  ...ring("chair", -16, -10.5, 1.55, 6),
  { type: "whiteboard", x: -20.6, z: -10.5, rot: Math.PI / 2 },
  { type: "plant", x: -12, z: -13.2 },

  // ===== Art studio (W-C) x[-21,-11] z[-6,2] =====
  // supply shelf on the north wall
  { type: "supplyShelf", x: -16, z: -6.35, rot: 0 },
  // a row of easels (canvases facing the room) + a stool per artist
  { type: "easel", x: -18.8, z: -4, rot: 0.25 },
  { type: "easel", x: -16, z: -4.3, rot: 0 },
  { type: "easel", x: -13.2, z: -4, rot: -0.25 },
  { type: "barStool", x: -18.8, z: -2.9 },
  { type: "barStool", x: -16, z: -3.2 },
  { type: "barStool", x: -13.2, z: -2.9 },
  // still-life pedestal (sculpture / drawing subject)
  { type: "pedestal", x: -19.4, z: 0.6 },
  // paint-mixing table + stool
  { type: "paintTable", x: -14.5, z: 0.7, rot: 0 },
  { type: "barStool", x: -14.5, z: 1.5 },
  // canvas storage rack on the west wall
  { type: "artRack", x: -20.6, z: -2, rot: Math.PI / 2 },
  // studio lighting + greenery
  { type: "floorLamp", x: -12, z: -5.4 },
  { type: "plant", x: -11.9, z: 1.4 },

  // ===== Lounge (W-S) x[-21,-11] z[3,14] — breakout lounge =====
  // focal wall (north): media console TV flanked by bookshelves
  { type: "consoleTV", x: -16, z: 3.8, rot: 0 },
  { type: "bookshelf", x: -19.6, z: 3.7, rot: 0 },
  { type: "bookshelf", x: -12.4, z: 3.7, rot: 0 },
  // conversation grouping around a coffee table (U opens toward the TV)
  { type: "couch", x: -16, z: 11.4, rot: Math.PI },
  { type: "loungeChair", x: -18.9, z: 8.8, rot: Math.PI / 2 },
  { type: "loungeChair", x: -13.1, z: 8.8, rot: -Math.PI / 2 },
  { type: "coffeeTable", x: -16, z: 8.9 },
  // accents
  { type: "floorLamp", x: -19.7, z: 11.9 },
  { type: "coffeeTable", x: -12.8, z: 11.9 },
  { type: "plant", x: -20.5, z: 13.2 },
  { type: "plant", x: -12, z: 13.2 },

  // ===== QA lab (E-N) x[11,21] z[-14,-7] =====
  // workstation + benches along the north wall, facing south into the room
  { type: "qaTerminal", x: 13, z: -13.3, rot: 0 },
  { type: "testBench", x: 16.2, z: -13.3, rot: 0 },
  { type: "testBench", x: 18.9, z: -13.3, rot: 0 },
  // device racks along the east wall
  { type: "deviceRack", x: 20.5, z: -9.4, rot: -Math.PI / 2 },
  { type: "deviceRack", x: 20.5, z: -11.2, rot: -Math.PI / 2 },
  { type: "plantSmall", x: 12, z: -7.8 },
  { type: "plant", x: 20.4, z: -7.6 },

  // ===== Pantry / kitchen (E-C) x[11,21] z[-6,2] — break room =====
  // counter run along the east wall (faces west into the room)
  { type: "kitchenStove", x: 21.45, z: -4.8, rot: -Math.PI / 2 },
  { type: "kitchenSink", x: 21.45, z: -2.7, rot: -Math.PI / 2 },
  { type: "kitchenCounter", x: 21.45, z: -0.3, rot: -Math.PI / 2 },
  { type: "fridgeTall", x: 21.5, z: 1.4, rot: -Math.PI / 2 },
  { type: "microwave", x: 21.25, z: 0.3, rot: -Math.PI / 2, y: 0.9 },
  { type: "coffeeMachine", x: 21.2, z: -1.1, rot: -Math.PI / 2, y: 0.9 },
  // north wall: pantry cupboard, vending, water cooler, trash
  { type: "bookshelf", x: 12.5, z: -6.4, rot: 0 },
  { type: "vendingMachine", x: 14.6, z: -6.4, rot: 0 },
  { type: "waterCooler", x: 16.6, z: -6.4, rot: 0 },
  { type: "trashBin", x: 18.8, z: -6.3 },
  // two kitchen islands in a row (berjejer), each a breakfast bar with stools
  { type: "kitchenIsland", x: 13.8, z: -3, rot: 0 },
  { type: "barStool", x: 13.2, z: -2 },
  { type: "barStool", x: 14.4, z: -2 },
  { type: "barStool", x: 13.2, z: -4 },
  { type: "barStool", x: 14.4, z: -4 },
  { type: "kitchenIsland", x: 17.2, z: -3, rot: 0 },
  { type: "barStool", x: 16.6, z: -2 },
  { type: "barStool", x: 17.8, z: -2 },
  { type: "barStool", x: 16.6, z: -4 },
  { type: "barStool", x: 17.8, z: -4 },
  // west wall storage (kept clear of the doorway at z[-2.8,-1.2])
  { type: "bookshelf", x: 11.45, z: -4.4, rot: Math.PI / 2 },
  // greenery
  { type: "plant", x: 11.7, z: 1.4 },
  { type: "plant", x: 20.4, z: 1.5 },

  // ===== Game room (E-S) x[11,21] z[3,14] =====
  // lounge/TV corner (north): TV on the back wall, couch + bean bags facing it
  { type: "consoleTV", x: 16, z: 3.5, rot: 0 }, // screen faces +z into the room
  { type: "coffeeTable", x: 16, z: 6.3 },
  { type: "couch", x: 16, z: 8.4, rot: Math.PI }, // faces the TV
  { type: "beanbag", x: 12.8, z: 7.4 },
  { type: "beanbag", x: 19.2, z: 7.4 },
  // games (south): ping-pong + foosball + arcades along the east wall
  { type: "pingpong", x: 13.8, z: 12.3 },
  { type: "foosball", x: 18, z: 12.4 },
  { type: "arcade", x: 20.4, z: 9.4, rot: -Math.PI / 2 },
  { type: "arcade", x: 20.4, z: 11.1, rot: -Math.PI / 2 },
  // fill: shelf, mini-fridge, greenery
  { type: "bookshelf", x: 20.5, z: 5, rot: -Math.PI / 2 },
  { type: "fridge", x: 12, z: 13.4, rot: Math.PI / 2 },
  { type: "plant", x: 12, z: 4 },
  { type: "plantSmall", x: 12, z: 10.2 },

  // ===== Server room (N-CL) =====
  { type: "serverRack", x: -8.3, z: -9, rot: Math.PI / 2 },
  { type: "serverRack", x: -8.3, z: -10.8, rot: Math.PI / 2 },
  { type: "serverRack", x: -8.3, z: -12.6, rot: Math.PI / 2 },
  { type: "serverRack", x: -5, z: -13.6, rot: 0 }, // faces into the room (was facing the wall)
  { type: "serverTerminal", x: -4, z: -9.6, rot: 0 },

  // ===== Gym (N-CR) =====
  { type: "treadmill", x: 0.4, z: -9.6, rot: Math.PI },
  { type: "treadmill", x: 2.2, z: -9.6, rot: Math.PI },
  { type: "weightBench", x: 5, z: -10.5, rot: 0 },
  { type: "dumbbellRack", x: 8.2, z: -9, rot: -Math.PI / 2 },
  { type: "exerciseBike", x: 7, z: -12.4, rot: 0 },
  { type: "yogaMat", x: 3, z: -12.8, rot: 0 },
  { type: "waterCooler", x: 8.4, z: -13.2, rot: -Math.PI / 2 },

  // ===== Reception / entrance (S-C) =====
  { type: "reception", x: 0, z: 13.4, rot: Math.PI },
  { type: "couch", x: -4.4, z: 10.6, rot: Math.PI / 2 },
  { type: "couch", x: 4.4, z: 10.6, rot: -Math.PI / 2 },
  { type: "coffeeTable", x: 0, z: 10.6 },
  { type: "plant", x: -5.6, z: 13.4 },
  { type: "plant", x: 5.6, z: 13.4 },
  { type: "phoneBooth", x: -8.5, z: 12 },
  { type: "phoneBooth", x: 8.5, z: 12 },

  // ===== Open workspace extras =====
  { type: "printer", x: -8, z: 3.5, rot: Math.PI / 2 },
  { type: "plant", x: -8, z: -5 },
  { type: "plant", x: 8, z: -5 },
  { type: "plantSmall", x: 0, z: 7.4 },
];

// ---- pendant lamps (hang over tables) --------------------------------------
export const LAMPS: Lamp[] = [
  { x: -16, z: -10.5, color: 0xfff3d6 }, // meeting
  { x: -16, z: 8.6, color: 0xffe6c0 }, // lounge
  { x: 14.5, z: -1.5, color: 0xfff0d0 }, // dining
  { x: 0, z: 11, color: 0xeaf2ff }, // reception
  { x: -4.5, z: 0.6, color: 0xfff6e0 }, // workspace
  { x: 4.5, z: 0.6, color: 0xfff6e0 },
  { x: 0, z: -4.2, color: 0xfff6e0 },
];

/** Random idle wander targets across the open workspace + corridors (walkable). */
export function randomWanderPoint(): [number, number] {
  const spots: [number, number][] = [
    [0, 1], [-6, 2], [6, 2], [-10, 0], [10, 0], [0, 6.5], [-7, 7], [7, -3], [0, -5.5], [4, 4],
  ];
  const s = spots[Math.floor(Math.random() * spots.length)];
  return [s[0] + (Math.random() - 0.5) * 2.5, s[1] + (Math.random() - 0.5) * 2.5];
}

// ---- agent activity spots --------------------------------------------------
// Where idle agents roam to, and the animation they play once there. Spread
// across every room so agents visit the whole office.
export type Activity =
  | "stand"
  | "sit"
  | "relax"
  | "work"
  | "standwork"
  | "drink"
  | "paint"
  | "run"
  | "lift"
  | "bike"
  | "stretch"
  | "pingpong"
  | "arcade"
  | "browse"
  | "phone"
  | "dance";
export type ActivitySpot = { x: number; z: number; facing: number; activity: Activity; sitY?: number };

/** seats facing the centre of a ring (for meeting chairs). */
function ringSpots(cx: number, cz: number, radius: number, n: number, activity: Activity): ActivitySpot[] {
  const out: ActivitySpot[] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    out.push({ x: cx + Math.cos(a) * radius, z: cz + Math.sin(a) * radius, facing: Math.atan2(-Math.cos(a), -Math.sin(a)), activity });
  }
  return out;
}

export const ACTIVITY_SPOTS: ActivitySpot[] = [
  // Meeting room — sit around the table
  ...ringSpots(-16, -10.5, 1.55, 6, "sit"),
  // Lounge
  { x: -16, z: 11.0, facing: Math.PI, activity: "relax" },
  { x: -18.5, z: 8.8, facing: Math.PI / 2, activity: "relax" },
  { x: -13.5, z: 8.8, facing: -Math.PI / 2, activity: "relax" },
  { x: -19.6, z: 4.7, facing: Math.PI, activity: "browse" },
  // Gym
  { x: 0.4, z: -9.1, facing: Math.PI, activity: "run" },
  { x: 2.2, z: -9.1, facing: Math.PI, activity: "run" },
  { x: 5, z: -10.5, facing: 0, activity: "lift" },
  { x: 7, z: -12.0, facing: 0, activity: "bike" },
  { x: 3, z: -12.8, facing: Math.PI, activity: "stretch" },
  // Game room
  { x: 12.3, z: 12.3, facing: Math.PI / 2, activity: "pingpong" },
  { x: 15.3, z: 12.3, facing: -Math.PI / 2, activity: "pingpong" },
  { x: 12.8, z: 7.4, facing: Math.PI, activity: "relax", sitY: 0.34 }, // beanbag (low)
  { x: 19.2, z: 7.4, facing: Math.PI, activity: "relax", sitY: 0.34 }, // beanbag (low)
  { x: 13.7, z: 4.4, facing: -Math.PI / 2, activity: "arcade" },
  { x: 13.7, z: 6.4, facing: -Math.PI / 2, activity: "arcade" },
  // Art studio
  { x: -18.8, z: -3.0, facing: Math.PI, activity: "paint" },
  { x: -16, z: -3.3, facing: Math.PI, activity: "paint" },
  { x: -13.2, z: -3.0, facing: Math.PI, activity: "paint" },
  { x: -14.5, z: 1.5, facing: Math.PI, activity: "standwork" },
  // Pantry — bar stools are tall
  { x: 13.2, z: -2, facing: Math.PI, activity: "sit", sitY: 0.66 },
  { x: 17.8, z: -2, facing: Math.PI, activity: "sit", sitY: 0.66 },
  { x: 16.6, z: -5.6, facing: Math.PI, activity: "drink" },
  { x: 20.6, z: -0.3, facing: Math.PI / 2, activity: "standwork" },
  { x: 14.6, z: -5.6, facing: Math.PI, activity: "standwork" },
  // QA lab
  { x: 13, z: -12.3, facing: Math.PI, activity: "standwork" },
  { x: 16.2, z: -12.3, facing: Math.PI, activity: "standwork" },
  { x: 18.9, z: -12.3, facing: Math.PI, activity: "standwork" },
  // Server room
  { x: -4, z: -8.7, facing: Math.PI, activity: "standwork" },
  { x: -6.6, z: -11, facing: Math.PI / 2, activity: "standwork" },
  // Reception
  { x: -4.2, z: 10.6, facing: Math.PI / 2, activity: "relax" },
  { x: 4.2, z: 10.6, facing: -Math.PI / 2, activity: "relax" },
  { x: 0, z: 12.4, facing: 0, activity: "standwork" },
  // Phone booths
  { x: -8.5, z: 12, facing: 0, activity: "phone" },
  { x: 8.5, z: 12, facing: 0, activity: "phone" },
  // open-floor stretch / dance
  { x: 0, z: 1, facing: 0, activity: "dance" },
  { x: -3, z: 6, facing: Math.PI, activity: "stand" },
  { x: 5, z: -3, facing: 0, activity: "stand" },
];
