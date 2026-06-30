/**
 * office3d/furniture-catalog.ts — single source of truth for furniture scale,
 * material tint, vertical offset and collision footprint.
 *
 * Scale + tint values are ported from github.com/fathah/hermes-office (MIT) —
 * which dresses the SAME Kenney .glb models we ship under public/office3d. The
 * raw .glb come with low-poly default vertex colours (e.g. the desk chair is a
 * pink/salmon), so a per-type tint is applied on load to get realistic
 * materials, and a per-type non-uniform scale fixes proportions (a round
 * meeting table is ~3.2x, a desk ~1.5x, a chair ~1.2x).
 *
 * `footprint` is the unrotated [width(x), depth(z)] in world units (1u ~= 1m),
 * used by nav.ts to block pathfinding cells so agents route AROUND furniture.
 * Items with blocks=false (rugs, computers on desks, ceiling lamps, flat mats)
 * never block navigation.
 */

const G = "/office3d/furniture";

export type CatalogEntry = {
  /** glb file (mutually exclusive with `proc`). */
  glb?: string;
  /** procedural builder key in procedural.ts (mutually exclusive with `glb`). */
  proc?: string;
  scale?: [number, number, number];
  /** hex tint applied to every mesh material; null = keep raw glb colours. */
  tint?: number | null;
  /** raise the model so it sits on a surface (e.g. a monitor on a desk). */
  yOffset?: number;
  /** does it block agent navigation? */
  blocks: boolean;
  /** unrotated [w(x), d(z)] world-unit footprint for the nav grid. */
  footprint: [number, number];
};

export type FurnitureType = keyof typeof CATALOG;

export const CATALOG = {
  // ---- glb workstation + office ----
  desk: { glb: `${G}/desk.glb`, scale: [1.5, 1.5, 1.5], tint: 0x8b5e32, blocks: true, footprint: [1.7, 0.95] },
  executiveDesk: { glb: `${G}/deskCorner.glb`, scale: [1.8, 1.8, 1.8], tint: 0x6b3c1a, blocks: true, footprint: [2.0, 1.3] },
  chair: { glb: `${G}/chairDesk.glb`, scale: [1.5, 1.5, 1.5], tint: 0x4a5568, blocks: false, footprint: [0.7, 0.7] },
  chairCushion: { glb: `${G}/chairModernCushion.glb`, scale: [1.45, 1.45, 1.45], tint: 0x4a5568, blocks: false, footprint: [0.7, 0.7] },
  computer: { glb: `${G}/computerScreen.glb`, scale: [1.1, 1.1, 1.1], tint: 0x363c58, yOffset: 0.61, blocks: false, footprint: [0, 0] },

  // ---- tables ----
  roundTable: { glb: `${G}/tableRound.glb`, scale: [2.3, 2.3, 2.3], tint: 0x9a6332, blocks: true, footprint: [1.75, 1.75] },
  diningTable: { glb: `${G}/table.glb`, scale: [1.5, 1.2, 1.1], tint: 0x7a5028, blocks: true, footprint: [1.7, 1.0] },
  coffeeTable: { glb: `${G}/tableCoffee.glb`, scale: [1.5, 1.2, 1.5], tint: 0x6b4a2f, blocks: true, footprint: [1.2, 0.8] },

  // ---- soft seating ----
  couch: { glb: `${G}/loungeSofa.glb`, scale: [1.8, 1.8, 1.8], tint: 0x3d5575, blocks: true, footprint: [2.2, 0.95] },
  loungeChair: { glb: `${G}/loungeDesignChair.glb`, scale: [1.4, 1.4, 1.4], tint: 0x5a4870, blocks: true, footprint: [1.0, 1.0] },
  beanbag: { proc: "beanbag", blocks: false, footprint: [1.0, 1.0] },

  // ---- storage / kitchen ----
  bookshelf: { glb: `${G}/bookcaseClosed.glb`, scale: [1.5, 2.0, 1.5], tint: 0x5c3520, blocks: true, footprint: [1.5, 0.55] },
  cabinet: { glb: `${G}/kitchenCabinet.glb`, scale: [2.6, 1.2, 1.0], tint: 0x3c4248, blocks: true, footprint: [2.4, 0.7] },
  fridge: { glb: `${G}/kitchenFridgeSmall.glb`, scale: [1.0, 1.4, 1.0], tint: 0x505a60, blocks: true, footprint: [0.9, 0.9] },
  coffeeMachine: { glb: `${G}/kitchenCoffeeMachine.glb`, scale: [0.85, 0.85, 0.85], tint: 0x2d2d38, blocks: false, footprint: [0.5, 0.5] },

  // ---- greenery / lighting ----
  plant: { glb: `${G}/pottedPlant.glb`, scale: [1.2, 1.8, 1.2], tint: null, blocks: false, footprint: [0.6, 0.6] },
  plantSmall: { glb: `${G}/plantSmall1.glb`, scale: [1.0, 1.5, 1.0], tint: null, blocks: false, footprint: [0.45, 0.45] },
  floorLamp: { glb: `${G}/lampRoundFloor.glb`, scale: [1.2, 1.2, 1.2], tint: 0xc8a060, blocks: false, footprint: [0.5, 0.5] },

  // ---- procedural: meeting / work ----
  whiteboard: { proc: "whiteboard", blocks: true, footprint: [1.9, 0.25] },
  printer: { proc: "printer", blocks: true, footprint: [0.8, 0.7] },
  standingTable: { proc: "standingTable", blocks: true, footprint: [1.6, 0.8] },
  reception: { proc: "reception", blocks: true, footprint: [3.6, 0.95] },

  // ---- procedural: server room ----
  serverRack: { proc: "serverRack", blocks: true, footprint: [0.95, 0.75] },
  serverTerminal: { proc: "serverTerminal", blocks: true, footprint: [1.2, 0.7] },

  // ---- procedural: gym ----
  treadmill: { proc: "treadmill", blocks: true, footprint: [1.0, 2.0] },
  weightBench: { proc: "weightBench", blocks: true, footprint: [0.7, 1.7] },
  dumbbellRack: { proc: "dumbbellRack", blocks: true, footprint: [1.4, 0.5] },
  exerciseBike: { proc: "exerciseBike", blocks: true, footprint: [0.7, 1.3] },
  yogaMat: { proc: "yogaMat", blocks: false, footprint: [0.7, 1.8] },
  waterCooler: { proc: "waterCooler", blocks: true, footprint: [0.55, 0.55] },

  // ---- procedural: game room ----
  arcade: { proc: "arcade", blocks: true, footprint: [0.95, 0.85] },
  consoleTV: { proc: "consoleTV", blocks: true, footprint: [2.6, 0.5] },
  pingpong: { proc: "pingpong", blocks: true, footprint: [2.6, 1.5] },
  foosball: { proc: "foosball", blocks: true, footprint: [1.5, 0.8] },

  // ---- procedural: art studio ----
  easel: { proc: "easel", blocks: true, footprint: [0.7, 0.7] },
  paintTable: { proc: "paintTable", blocks: true, footprint: [1.5, 0.8] },
  artRack: { proc: "artRack", blocks: true, footprint: [1.3, 0.45] },
  pedestal: { proc: "pedestal", blocks: true, footprint: [0.55, 0.55] },
  supplyShelf: { proc: "supplyShelf", blocks: true, footprint: [1.6, 0.4] },

  // ---- procedural: QA lab ----
  qaTerminal: { proc: "qaTerminal", blocks: true, footprint: [1.5, 0.8] },
  deviceRack: { proc: "deviceRack", blocks: true, footprint: [1.1, 0.7] },
  testBench: { proc: "testBench", blocks: true, footprint: [1.7, 0.9] },

  // ---- procedural: phone booth ----
  phoneBooth: { proc: "phoneBooth", blocks: false, footprint: [2.0, 2.0] }, // open so agents can step inside

  // ---- procedural: kitchen / pantry ----
  kitchenCounter: { proc: "kitchenCounter", blocks: true, footprint: [2.2, 0.6] },
  kitchenSink: { proc: "kitchenSink", blocks: true, footprint: [2.0, 0.6] },
  kitchenStove: { proc: "kitchenStove", blocks: true, footprint: [1.0, 0.6] },
  fridgeTall: { proc: "fridgeTall", blocks: true, footprint: [0.9, 0.72] },
  microwave: { proc: "microwave", blocks: false, footprint: [0.56, 0.38] },
  kitchenIsland: { proc: "kitchenIsland", blocks: true, footprint: [1.95, 1.05] },
  barStool: { proc: "barStool", blocks: false, footprint: [0.45, 0.45] },
  vendingMachine: { proc: "vendingMachine", blocks: true, footprint: [1.0, 0.72] },
  trashBin: { proc: "trashBin", blocks: false, footprint: [0.4, 0.4] },
  diningTableLong: { proc: "diningTableLong", blocks: true, footprint: [2.4, 0.95] },
} satisfies Record<string, CatalogEntry>;

/** Returns the [w,d] footprint after a Y-rotation (swaps for ~90/270deg). */
export function rotatedFootprint(fp: [number, number], rot: number): [number, number] {
  const q = Math.abs(Math.round(rot / (Math.PI / 2)) % 2);
  return q === 1 ? [fp[1], fp[0]] : [fp[0], fp[1]];
}
