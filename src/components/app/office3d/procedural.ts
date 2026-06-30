/**
 * office3d/procedural.ts — hand-built Three.js furniture for zones with no .glb
 * (gym, arcade, art studio, QA lab, server room, phone booth, reception, etc.).
 *
 * Every builder returns a THREE.Group sized in world units (1u ~= 1m) so it sits
 * correctly next to the .glb furniture and the ~1.6u-tall agents. Blinking /
 * glowing meshes are tagged `userData.blink = phase` so the scene's animation
 * loop can pulse them with a single pass. The caller positions + rotates the
 * returned group; builders always model the item centred at the origin, footed
 * on the floor (y=0).
 */
import * as THREE from "three";

type MatOpts = {
  rough?: number;
  metal?: number;
  emissive?: number;
  emissiveIntensity?: number;
  transparent?: boolean;
  opacity?: number;
};
function mat(color: number, o: MatOpts = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: o.rough ?? 0.7,
    metalness: o.metal ?? 0.1,
    emissive: o.emissive ?? 0x000000,
    emissiveIntensity: o.emissiveIntensity ?? 1,
    transparent: o.transparent ?? false,
    opacity: o.opacity ?? 1,
  });
}
function box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
function cyl(rt: number, rb: number, h: number, m: THREE.Material, x = 0, y = 0, z = 0, seg = 16): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  return mesh;
}
function screen(w: number, h: number, color: number, blink = false): THREE.Mesh {
  const m = mat(color, { emissive: color, emissiveIntensity: 0.8, rough: 0.3 });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
  if (blink) mesh.userData.blink = Math.random() * 6;
  return mesh;
}

const WOOD = 0x7a5028;
const METAL_DARK = 0x2b3038;
const METAL = 0x9aa3ad;

// ----------------------------------------------------------------------------
// Meeting / work
// ----------------------------------------------------------------------------
function whiteboard(): THREE.Group {
  const g = new THREE.Group();
  const frame = mat(0xd8d2c4, { rough: 0.6 });
  g.add(box(0.06, 1.0, 0.06, frame, -0.85, 0.5, 0));
  g.add(box(0.06, 1.0, 0.06, frame, 0.85, 0.5, 0));
  g.add(box(1.9, 1.15, 0.06, mat(0xf4f2ee, { rough: 0.5, emissive: 0xf4f2ee, emissiveIntensity: 0.08 }), 0, 1.25, 0));
  // scribbles
  g.add(box(0.7, 0.04, 0.07, mat(0x2563eb), -0.3, 1.45, 0.01));
  g.add(box(0.5, 0.04, 0.07, mat(0xdc2626), 0.2, 1.2, 0.01));
  g.add(box(0.4, 0.04, 0.07, mat(0x16a34a), -0.1, 1.0, 0.01));
  return g;
}
function printer(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.6, 0.5, 0.55, mat(0x404858, { rough: 0.6 }), 0, 0.55, 0));
  g.add(box(0.5, 0.04, 0.4, mat(0xe5e7eb), 0, 0.82, 0.05)); // paper tray
  g.add(box(0.08, 0.05, 0.02, mat(0x34d399, { emissive: 0x34d399, emissiveIntensity: 0.9 }), 0.2, 0.86, 0.28));
  // stand
  g.add(box(0.62, 0.3, 0.55, mat(METAL_DARK), 0, 0.15, 0));
  return g;
}
function standingTable(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(1.6, 0.08, 0.8, mat(WOOD, { rough: 0.6 }), 0, 1.05, 0));
  const leg = mat(METAL_DARK, { metal: 0.5 });
  for (const [x, z] of [[-0.7, -0.32], [0.7, -0.32], [-0.7, 0.32], [0.7, 0.32]] as const)
    g.add(box(0.07, 1.05, 0.07, leg, x, 0.52, z));
  return g;
}
function reception(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(3.4, 1.1, 0.55, mat(0x5d4037, { rough: 0.7 }), 0, 0.55, 0));
  g.add(box(3.6, 0.1, 0.8, mat(0xd7ccc8, { rough: 0.5, metal: 0.2 }), 0, 1.12, 0));
  const sign = screen(1.8, 0.5, 0x22d3ee);
  sign.position.set(0, 1.85, -0.28);
  g.add(sign);
  return g;
}

// ----------------------------------------------------------------------------
// Server room
// ----------------------------------------------------------------------------
function serverRack(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.9, 2.0, 0.7, mat(0x10141b, { rough: 0.55, metal: 0.5 }), 0, 1.0, 0));
  const colors = [0x34d399, 0x22d3ee, 0x8b5cf6];
  for (let r = 0; r < 7; r++) {
    const led = box(0.55, 0.07, 0.02, mat(colors[r % 3], { emissive: colors[r % 3], emissiveIntensity: 0.9 }), 0, 0.42 + r * 0.22, 0.36);
    led.userData.blink = r * 0.7;
    g.add(led);
  }
  return g;
}
function serverTerminal(): THREE.Group {
  const g = new THREE.Group();
  const top = 0.78;
  g.add(box(1.2, 0.06, 0.6, mat(METAL_DARK, { metal: 0.4 }), 0, top - 0.03, 0)); // desk top
  for (const [x, z] of [[-0.5, -0.24], [0.5, -0.24], [-0.5, 0.24], [0.5, 0.24]] as const) g.add(box(0.06, top - 0.06, 0.06, mat(METAL_DARK), x, (top - 0.06) / 2, z)); // 4 legs
  // monitor on a stand resting on the desk; solid box body (not a thin plane)
  g.add(box(0.2, 0.03, 0.12, mat(0x111418), 0, top + 0.015, -0.14)); // foot
  g.add(box(0.05, 0.2, 0.05, mat(0x111418), 0, top + 0.12, -0.16)); // neck
  const my = top + 0.32;
  g.add(box(0.62, 0.42, 0.05, mat(0x0a0a0a), 0, my, -0.18)); // monitor body
  const s = screen(0.54, 0.34, 0x22d3ee, true);
  s.position.set(0, my, -0.15);
  g.add(s);
  g.add(box(0.6, 0.03, 0.2, mat(0x1f2937), 0, top + 0.03, 0.16)); // keyboard
  return g;
}

// ----------------------------------------------------------------------------
// Gym
// ----------------------------------------------------------------------------
function treadmill(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.9, 0.18, 1.7, mat(0x1f2937, { metal: 0.3 }), 0, 0.12, 0.1)); // deck
  g.add(box(0.78, 0.04, 1.5, mat(0x111418), 0, 0.22, 0.1)); // belt
  for (const x of [-0.42, 0.42]) g.add(box(0.06, 1.0, 0.06, mat(METAL, { metal: 0.6 }), x, 0.6, -0.7)); // posts
  const console_ = screen(0.6, 0.3, 0x60a5fa, true);
  console_.position.set(0, 1.05, -0.72);
  g.add(console_);
  g.add(box(0.7, 0.08, 0.1, mat(METAL_DARK), 0, 1.0, -0.66)); // console bar
  return g;
}
function weightBench(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.45, 0.12, 1.3, mat(0xb91c1c, { rough: 0.6 }), 0, 0.5, 0)); // pad
  const fr = mat(METAL_DARK, { metal: 0.5 });
  g.add(box(0.5, 0.44, 0.1, fr, 0, 0.22, 0.55));
  g.add(box(0.5, 0.44, 0.1, fr, 0, 0.22, -0.55));
  // barbell uprights + bar
  for (const x of [-0.45, 0.45]) g.add(box(0.07, 1.1, 0.07, fr, x, 0.55, -0.6));
  g.add(cyl(0.04, 0.04, 1.2, mat(METAL, { metal: 0.8 }), 0, 1.05, -0.6).rotateZ(Math.PI / 2));
  for (const x of [-0.5, 0.5]) g.add(cyl(0.16, 0.16, 0.08, mat(0x111418), x, 1.05, -0.6).rotateZ(Math.PI / 2));
  return g;
}
function dumbbellRack(): THREE.Group {
  const g = new THREE.Group();
  const fr = mat(METAL_DARK, { metal: 0.5 });
  g.add(box(1.3, 0.08, 0.45, fr, 0, 0.7, 0));
  g.add(box(1.3, 0.08, 0.45, fr, 0, 0.4, 0.08));
  for (const x of [-0.6, 0.6]) {
    g.add(box(0.06, 0.75, 0.45, fr, x, 0.38, 0.04));
  }
  const dcol = [0x111418, 0x334155, 0x4b5563];
  for (let i = 0; i < 4; i++) {
    const x = -0.45 + i * 0.3;
    for (const [y, z] of [[0.78, 0], [0.48, 0.08]] as const) {
      const m = mat(dcol[i % 3], { metal: 0.4 });
      g.add(cyl(0.06, 0.06, 0.32, m, x, y, z).rotateZ(Math.PI / 2));
      for (const dx of [-0.14, 0.14]) g.add(cyl(0.1, 0.1, 0.06, m, x + dx, y, z).rotateZ(Math.PI / 2));
    }
  }
  return g;
}
function exerciseBike(): THREE.Group {
  const g = new THREE.Group();
  const fr = mat(0x1f2937, { metal: 0.4 });
  g.add(box(0.18, 0.1, 1.1, fr, 0, 0.08, 0)); // base
  g.add(cyl(0.34, 0.34, 0.1, mat(METAL_DARK, { metal: 0.6 }), 0, 0.5, -0.45).rotateZ(Math.PI / 2)); // flywheel
  g.add(box(0.1, 0.7, 0.1, fr, 0, 0.55, 0.35)); // seat post
  g.add(box(0.35, 0.08, 0.22, mat(0x111418), 0, 0.92, 0.35)); // seat
  g.add(box(0.1, 0.8, 0.1, fr, 0, 0.6, -0.4)); // handle post
  g.add(box(0.4, 0.06, 0.1, fr, 0, 1.0, -0.42)); // handlebar
  return g;
}
function yogaMat(): THREE.Group {
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.03, 1.8), mat(0x0f766e, { rough: 0.95 }));
  m.position.y = 0.015;
  m.receiveShadow = true;
  g.add(m);
  return g;
}
function waterCooler(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.4, 1.0, 0.4, mat(0xeef2f7, { rough: 0.4 }), 0, 0.5, 0));
  g.add(cyl(0.18, 0.2, 0.4, mat(0x60a5fa, { transparent: true, opacity: 0.6, rough: 0.2 }), 0, 1.2, 0));
  g.add(box(0.12, 0.06, 0.06, mat(0x2563eb), 0, 0.62, 0.22));
  return g;
}

// ----------------------------------------------------------------------------
// Game room
// ----------------------------------------------------------------------------
function arcade(): THREE.Group {
  const g = new THREE.Group();
  const body = mat(0x6d28d9, { rough: 0.5 });
  g.add(box(0.8, 1.7, 0.65, body, 0, 0.85, 0));
  const scr = screen(0.6, 0.5, 0x22d3ee, true);
  scr.position.set(0, 1.25, 0.34);
  scr.rotation.x = -0.25;
  g.add(scr);
  g.add(box(0.78, 0.25, 0.3, mat(0x1f2937), 0, 0.95, 0.42)); // control panel
  for (const [x, c] of [[-0.18, 0xef4444], [0.18, 0xfacc15]] as const) g.add(cyl(0.05, 0.05, 0.08, mat(c, { emissive: c, emissiveIntensity: 0.6 }), x, 1.08, 0.5));
  const marquee = screen(0.7, 0.25, 0xf472b6, true);
  marquee.position.set(0, 1.62, 0.34);
  g.add(marquee);
  return g;
}
/** Entertainment unit: media cabinet with a flat-screen TV resting on top,
 *  screen facing +Z (forward). */
function consoleTV(): THREE.Group {
  const g = new THREE.Group();
  const cabH = 0.55;
  g.add(box(2.6, cabH, 0.5, mat(0x2b3038, { rough: 0.5 }), 0, cabH / 2, 0)); // media cabinet
  g.add(box(2.6, 0.04, 0.5, mat(0x1a1f24, { metal: 0.3 }), 0, cabH, 0)); // cabinet top
  // TV standing on the cabinet
  const tvCenterY = cabH + 0.58;
  g.add(box(0.5, 0.16, 0.2, mat(0x111418), 0, cabH + 0.08, 0)); // stand foot
  g.add(box(1.95, 1.08, 0.07, mat(0x0a0a0a), 0, tvCenterY, 0.04)); // bezel
  const scr = screen(1.78, 0.92, 0x244a78, true);
  scr.position.set(0, tvCenterY, 0.08);
  g.add(scr);
  // soundbar + console + controllers on the shelf
  g.add(box(1.5, 0.08, 0.12, mat(0x111418), 0, cabH + 0.04, 0.22));
  g.add(box(0.42, 0.1, 0.3, mat(0x161b20, { metal: 0.2 }), -0.75, cabH + 0.09, 0.05));
  for (const x of [0.5, 0.75]) g.add(box(0.14, 0.06, 0.1, mat(0x4b5563), x, cabH + 0.07, 0.12));
  return g;
}

/** Squishy rounded bean bag with a seat depression. */
function beanbag(): THREE.Group {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.SphereGeometry(0.55, 18, 14), mat(0x7c3aed, { rough: 0.9 }));
  base.scale.set(1, 0.66, 1);
  base.position.y = 0.36;
  base.castShadow = true;
  base.receiveShadow = true;
  g.add(base);
  const dent = new THREE.Mesh(new THREE.SphereGeometry(0.34, 16, 12), mat(0x5b21b6, { rough: 0.95 }));
  dent.scale.set(1, 0.45, 1);
  dent.position.y = 0.52;
  g.add(dent);
  return g;
}

/** Foosball / table-football table. */
function foosball(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(1.5, 0.12, 0.8, mat(0x14532d, { rough: 0.7 }), 0, 0.78, 0)); // play field
  const rail = mat(0x4a3520, { rough: 0.6 });
  g.add(box(1.5, 0.18, 0.08, rail, 0, 0.85, 0.4));
  g.add(box(1.5, 0.18, 0.08, rail, 0, 0.85, -0.4));
  const leg = mat(0x1f2937, { metal: 0.3 });
  for (const [x, z] of [[-0.65, -0.32], [0.65, -0.32], [-0.65, 0.32], [0.65, 0.32]] as const) g.add(box(0.1, 0.78, 0.1, leg, x, 0.39, z));
  // rods with players
  const rodMat = mat(0xc4c9d1, { metal: 0.8 });
  for (let i = 0; i < 4; i++) {
    const x = -0.55 + i * 0.37;
    g.add(cyl(0.02, 0.02, 1.0, rodMat, x, 0.96, 0).rotateX(Math.PI / 2));
    const pc = i % 2 ? 0xef4444 : 0x3b82f6;
    for (const z of [-0.25, 0, 0.25]) g.add(box(0.06, 0.14, 0.05, mat(pc), x, 0.9, z));
  }
  return g;
}
function pingpong(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(2.6, 0.1, 1.5, mat(0x14532d, { rough: 0.7 }), 0, 0.76, 0));
  g.add(box(2.6, 0.02, 0.04, mat(0xffffff), 0, 0.815, 0)); // center line
  g.add(box(0.03, 0.16, 1.5, mat(0xe5e7eb, { transparent: true, opacity: 0.7 }), 0, 0.86, 0)); // net
  const leg = mat(0x1f2937, { metal: 0.3 });
  for (const [x, z] of [[-1.15, -0.6], [1.15, -0.6], [-1.15, 0.6], [1.15, 0.6]] as const) g.add(box(0.08, 0.76, 0.08, leg, x, 0.38, z));
  return g;
}

// ----------------------------------------------------------------------------
// Art studio
// ----------------------------------------------------------------------------
/** A-frame artist's easel: two splayed front uprights + a rear support leg, a
 *  ledge holding a tilted canvas (painting on the +z face). */
function easel(): THREE.Group {
  const g = new THREE.Group();
  const wood = mat(0x8b5e32, { rough: 0.7 });
  const upL = box(0.05, 1.7, 0.05, wood, -0.26, 0.85, 0.05);
  upL.rotation.z = 0.13;
  g.add(upL);
  const upR = box(0.05, 1.7, 0.05, wood, 0.26, 0.85, 0.05);
  upR.rotation.z = -0.13;
  g.add(upR);
  const back = box(0.05, 1.7, 0.05, wood, 0, 0.85, -0.42);
  back.rotation.x = 0.36;
  g.add(back);
  g.add(box(0.56, 0.05, 0.05, wood, 0, 1.42, 0.06)); // top brace
  g.add(box(0.64, 0.05, 0.05, wood, 0, 0.6, 0.06)); // lower brace
  g.add(box(0.66, 0.06, 0.13, wood, 0, 0.78, 0.12)); // canvas ledge
  const canvas = box(0.62, 0.82, 0.04, mat(0xf5f2ea, { rough: 0.6 }), 0, 1.22, 0.1);
  canvas.rotation.x = -0.07;
  g.add(canvas);
  const art = box(0.5, 0.66, 0.02, mat(0x7c3aed, { rough: 0.5 }), 0, 1.22, 0.13);
  art.rotation.x = -0.07;
  g.add(art);
  return g;
}
function paintTable(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(1.4, 0.08, 0.7, mat(0x6b4a2f, { rough: 0.7 }), 0, 0.75, 0));
  const leg = mat(0x4a3520);
  for (const [x, z] of [[-0.6, -0.28], [0.6, -0.28], [-0.6, 0.28], [0.6, 0.28]] as const) g.add(box(0.07, 0.75, 0.07, leg, x, 0.37, z));
  const cans = [0xef4444, 0x3b82f6, 0xfacc15, 0x22c55e];
  cans.forEach((c, i) => g.add(cyl(0.06, 0.06, 0.13, mat(c), -0.5 + i * 0.16, 0.85, -0.18)));
  // palette with paint blobs
  const palette = box(0.42, 0.02, 0.28, mat(0xc9a36a, { rough: 0.5 }), 0.2, 0.8, 0.12);
  g.add(palette);
  for (const [dx, dz, c] of [[0.08, 0.06, 0xef4444], [0.2, 0.1, 0x3b82f6], [0.3, 0.04, 0xfacc15], [0.16, -0.04, 0x22c55e]] as const) {
    const blob = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), mat(c));
    blob.position.set(dx, 0.82, dz);
    blob.scale.y = 0.4;
    g.add(blob);
  }
  // brush jar
  g.add(cyl(0.05, 0.06, 0.16, mat(0xd7e0e6, { transparent: true, opacity: 0.55, rough: 0.2 }), -0.5, 0.87, 0.15));
  for (const a of [-0.04, 0, 0.04]) g.add(cyl(0.008, 0.008, 0.24, mat(0x8b5e32), -0.5 + a, 1.0, 0.15));
  return g;
}
/** Sculpture / still-life pedestal with a vase + fruit on top. */
function pedestal(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.4, 1.0, 0.4, mat(0xe8e3d8, { rough: 0.6 }), 0, 0.5, 0));
  g.add(box(0.52, 0.08, 0.52, mat(0xd7ccc8, { rough: 0.5 }), 0, 1.02, 0));
  g.add(box(0.52, 0.08, 0.52, mat(0xd7ccc8, { rough: 0.5 }), 0, 0.04, 0));
  g.add(cyl(0.1, 0.15, 0.32, mat(0x2563eb, { rough: 0.3 }), 0, 1.22, 0)); // vase
  for (const [dx, dz, c] of [[0.14, 0.02, 0xef4444], [-0.12, 0.1, 0xf59e0b], [0.04, -0.12, 0x84cc16]] as const) {
    const f = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), mat(c, { rough: 0.6 }));
    f.position.set(dx, 1.13, dz);
    g.add(f);
  }
  return g;
}
/** Open shelving stocked with art supplies (paint tubes / jars). */
function supplyShelf(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(1.6, 1.6, 0.4, mat(0x6b4a2f, { rough: 0.7 }), 0, 0.8, 0));
  for (const y of [0.45, 0.95, 1.45]) g.add(box(1.5, 0.04, 0.42, mat(0x8b5e32, { rough: 0.6 }), 0, y, 0.02));
  const cols = [0xef4444, 0x3b82f6, 0xf59e0b, 0x22c55e, 0xa855f7, 0xec4899, 0x06b6d4];
  for (const y of [0.45, 0.95, 1.45]) for (let i = 0; i < 5; i++) g.add(cyl(0.05, 0.05, 0.16, mat(cols[(i * 2 + Math.round(y)) % cols.length], { rough: 0.5 }), -0.58 + i * 0.29, y + 0.12, 0.12));
  return g;
}
function artRack(): THREE.Group {
  const g = new THREE.Group();
  const wood = mat(0x5c3520, { rough: 0.7 });
  g.add(box(1.2, 0.1, 0.55, wood, 0, 0.05, 0)); // base tray
  g.add(box(1.2, 0.5, 0.06, wood, 0, 0.3, -0.24)); // back rail to lean against
  // canvases leaning against the rail, each offset in depth so they never
  // overlap in the same plane (no z-fighting)
  const cols = [0xf472b6, 0x60a5fa, 0xfbbf24, 0x34d399, 0xa855f7];
  cols.forEach((c, i) => {
    const cv = box(0.46, 0.62, 0.03, mat(c, { rough: 0.5 }), -0.02, 0.42, -0.16 + i * 0.08);
    cv.rotation.x = -0.16;
    g.add(cv);
  });
  return g;
}

// ----------------------------------------------------------------------------
// QA lab
// ----------------------------------------------------------------------------
function qaTerminal(): THREE.Group {
  const g = new THREE.Group();
  const top = 0.78; // desk surface height
  g.add(box(1.5, 0.06, 0.7, mat(METAL_DARK, { metal: 0.4 }), 0, top - 0.03, 0));
  for (const [x, z] of [[-0.65, -0.28], [0.65, -0.28], [-0.65, 0.28], [0.65, 0.28]] as const) g.add(box(0.06, top - 0.06, 0.06, mat(METAL_DARK), x, (top - 0.06) / 2, z));
  // dual monitors on stands that rest on the desk, screens facing +z (the user)
  for (const x of [-0.4, 0.4]) {
    g.add(box(0.22, 0.03, 0.14, mat(0x111418), x, top + 0.015, -0.16)); // foot
    g.add(box(0.05, 0.22, 0.05, mat(0x111418), x, top + 0.13, -0.18)); // neck
    const my = top + 0.34;
    g.add(box(0.6, 0.42, 0.05, mat(0x0a0a0a), x, my, -0.2)); // bezel
    const s = screen(0.54, 0.36, 0x22d3ee, true);
    s.position.set(x, my, -0.17);
    g.add(s);
  }
  g.add(box(0.7, 0.03, 0.22, mat(0x1f2937), 0, top + 0.03, 0.18)); // keyboard
  g.add(box(0.16, 0.04, 0.11, mat(0x1f2937), 0.5, top + 0.04, 0.18)); // mouse
  return g;
}
function deviceRack(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(1.05, 1.6, 0.6, mat(0x2b3038, { metal: 0.4, rough: 0.5 }), 0, 0.8, 0));
  for (let s = 0; s < 3; s++) {
    const y = 0.45 + s * 0.5;
    for (let d = 0; d < 3; d++) {
      const dev = box(0.26, 0.18, 0.04, mat(0x111418), -0.32 + d * 0.32, y, 0.31);
      g.add(dev);
      g.add(box(0.16, 0.1, 0.02, mat(0x34d399, { emissive: 0x34d399, emissiveIntensity: 0.7 }), -0.32 + d * 0.32, y, 0.34));
    }
  }
  return g;
}
function testBench(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(1.7, 0.08, 0.9, mat(0x3f4853, { metal: 0.3 }), 0, 0.85, 0));
  for (const [x, z] of [[-0.75, -0.38], [0.75, -0.38], [-0.75, 0.38], [0.75, 0.38]] as const) g.add(box(0.07, 0.85, 0.07, mat(METAL_DARK), x, 0.42, z));
  const osc = screen(0.5, 0.34, 0x22c55e, true);
  osc.position.set(-0.45, 1.18, -0.2);
  g.add(osc);
  g.add(box(0.55, 0.42, 0.3, mat(0x111418), -0.45, 1.1, -0.32)); // scope body
  g.add(box(0.3, 0.15, 0.25, mat(0x4b5563), 0.4, 0.97, 0)); // device under test
  return g;
}

// ----------------------------------------------------------------------------
// Kitchen / pantry — proper counter run with cabinets, sink, stove, fridge
// ----------------------------------------------------------------------------
const KCAB = 0xe8e3d8; // cream cabinet
const KTOP = 0x3b4046; // dark stone countertop
const KSTEEL = 0xc4c9d1;
const KBACK = 0xe4ddd0; // backsplash tile (warm, matches cabinets)

function counterBase(W: number, g: THREE.Group) {
  g.add(box(W, 0.82, 0.6, mat(KCAB, { rough: 0.55 }), 0, 0.43, 0));
  g.add(box(W + 0.04, 0.06, 0.64, mat(KTOP, { rough: 0.4, metal: 0.2 }), 0, 0.88, 0.02)); // countertop
  const n = Math.max(1, Math.round(W / 0.62));
  const dw = W / n;
  for (let i = 0; i < n; i++) {
    const x = -W / 2 + dw * (i + 0.5);
    g.add(box(dw - 0.07, 0.62, 0.03, mat(0xdcd6c8, { rough: 0.5 }), x, 0.45, 0.31)); // door
    g.add(box(0.05, 0.13, 0.04, mat(KSTEEL, { metal: 0.7 }), x + dw / 2 - 0.09, 0.55, 0.34)); // handle
  }
  g.add(box(W, 0.5, 0.03, mat(KBACK, { rough: 0.4 }), 0, 1.16, -0.285)); // backsplash
}
function upperCab(W: number, g: THREE.Group) {
  g.add(box(W, 0.62, 0.32, mat(KCAB, { rough: 0.55 }), 0, 1.82, -0.14));
  const n = Math.max(1, Math.round(W / 0.62));
  const dw = W / n;
  for (let i = 0; i < n; i++) g.add(box(0.05, 0.1, 0.04, mat(KSTEEL, { metal: 0.7 }), -W / 2 + dw * (i + 0.5), 1.56, 0.03));
}
function kitchenCounter(): THREE.Group {
  const g = new THREE.Group();
  counterBase(2.2, g);
  upperCab(2.2, g);
  return g;
}
function kitchenSink(): THREE.Group {
  const g = new THREE.Group();
  const W = 2.0;
  counterBase(W, g);
  g.add(box(0.74, 0.05, 0.44, mat(0x9aa3ad, { metal: 0.7 }), 0, 0.9, 0.05)); // basin rim
  g.add(box(0.62, 0.16, 0.34, mat(0x6b7280, { metal: 0.6 }), 0, 0.82, 0.05)); // basin
  g.add(cyl(0.03, 0.03, 0.3, mat(KSTEEL, { metal: 0.8 }), 0, 1.05, -0.12)); // faucet stem
  g.add(box(0.04, 0.04, 0.22, mat(KSTEEL, { metal: 0.8 }), 0, 1.18, -0.02)); // faucet neck
  upperCab(W, g);
  return g;
}
function kitchenStove(): THREE.Group {
  const g = new THREE.Group();
  const W = 1.0;
  g.add(box(W, 0.85, 0.6, mat(0xb8bdc4, { metal: 0.5, rough: 0.4 }), 0, 0.43, 0)); // oven body
  g.add(box(W + 0.02, 0.06, 0.64, mat(0x23272c, { rough: 0.3 }), 0, 0.88, 0.02)); // cooktop
  for (const [x, z] of [[-0.22, -0.12], [0.22, -0.12], [-0.22, 0.16], [0.22, 0.16]] as const)
    g.add(cyl(0.1, 0.1, 0.02, mat(0x111418), x, 0.92, z));
  g.add(box(W - 0.1, 0.45, 0.03, mat(0x1f2329, { rough: 0.3 }), 0, 0.4, 0.31)); // oven door
  g.add(box(W - 0.3, 0.2, 0.02, mat(0x0a0a0a, { emissive: 0x3a1a00, emissiveIntensity: 0.4 }), 0, 0.45, 0.33)); // window
  g.add(box(W - 0.2, 0.05, 0.05, mat(KSTEEL, { metal: 0.8 }), 0, 0.66, 0.34)); // handle
  for (const x of [-0.32, -0.11, 0.11, 0.32]) g.add(cyl(0.04, 0.04, 0.04, mat(0x111418), x, 0.72, 0.32).rotateX(Math.PI / 2)); // knobs
  const hood = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.55, 0.32, 4), mat(KSTEEL, { metal: 0.6 }));
  hood.position.set(0, 1.72, -0.08);
  hood.rotation.y = Math.PI / 4;
  hood.castShadow = true;
  g.add(hood);
  g.add(box(0.3, 0.5, 0.1, mat(KSTEEL, { metal: 0.6 }), 0, 2.05, -0.22)); // hood duct
  return g;
}
function fridgeTall(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.9, 1.9, 0.72, mat(KSTEEL, { metal: 0.5, rough: 0.35 }), 0, 0.95, 0));
  g.add(box(0.92, 0.04, 0.74, mat(0x9aa3ad, { metal: 0.6 }), 0, 1.3, 0)); // door split
  for (const y of [0.55, 1.62]) g.add(box(0.05, 0.5, 0.06, mat(0x6b7280, { metal: 0.7 }), 0.36, y, 0.38)); // handles
  return g;
}
function microwave(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.56, 0.32, 0.38, mat(0x23272c, { rough: 0.4 }), 0, 0.16, 0));
  g.add(box(0.34, 0.24, 0.02, mat(0x111418, { emissive: 0x16263a, emissiveIntensity: 0.4 }), -0.07, 0.16, 0.2)); // window
  g.add(box(0.12, 0.24, 0.02, mat(0x4b5563), 0.2, 0.16, 0.2)); // panel
  return g;
}
function kitchenIsland(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(1.8, 0.85, 0.9, mat(KCAB, { rough: 0.55 }), 0, 0.43, 0));
  g.add(box(1.95, 0.07, 1.05, mat(KTOP, { rough: 0.4, metal: 0.2 }), 0, 0.89, 0)); // overhanging top
  for (const zs of [0.46, -0.46]) {
    for (const x of [-0.5, 0, 0.5]) {
      g.add(box(0.42, 0.6, 0.02, mat(0xdcd6c8, { rough: 0.5 }), x, 0.45, zs));
      g.add(box(0.04, 0.12, 0.03, mat(KSTEEL, { metal: 0.7 }), x + 0.15, 0.55, zs + Math.sign(zs) * 0.02));
    }
  }
  // worktop props: fruit bowl + cutting board + jar
  g.add(cyl(0.16, 0.12, 0.09, mat(0xb45309, { rough: 0.6 }), -0.55, 0.96, 0));
  for (const [dx, dz, c] of [[-0.55, 0, 0xef4444], [-0.46, 0.06, 0xf59e0b], [-0.62, -0.05, 0x84cc16]] as const)
    g.add(new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), mat(c, { rough: 0.6 })).translateX(dx).translateY(1.02).translateZ(dz));
  g.add(box(0.42, 0.03, 0.28, mat(0x8b5e32, { rough: 0.6 }), 0.5, 0.93, 0)); // cutting board
  g.add(cyl(0.07, 0.07, 0.18, mat(0xd7e0e6, { transparent: true, opacity: 0.6, rough: 0.2 }), 0.2, 0.99, 0.2)); // jar
  return g;
}
function barStool(): THREE.Group {
  const g = new THREE.Group();
  const woodSeat = mat(0x5d4037, { rough: 0.6 });
  const metal = mat(0x9aa3ad, { metal: 0.7 });
  g.add(cyl(0.18, 0.18, 0.06, woodSeat, 0, 0.74, 0));
  g.add(cyl(0.03, 0.03, 0.74, metal, 0, 0.37, 0));
  g.add(cyl(0.22, 0.22, 0.03, metal, 0, 0.02, 0));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.015, 8, 18), metal);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.3;
  g.add(ring);
  return g;
}
function vendingMachine(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(1.0, 2.0, 0.72, mat(0xb91c3c, { rough: 0.45 }), 0, 1.0, 0)); // body
  g.add(box(0.72, 1.4, 0.03, mat(0x0a0f18, { emissive: 0x123a5a, emissiveIntensity: 0.4 }), -0.1, 1.25, 0.37)); // glass
  const cols = [0x3b82f6, 0xf59e0b, 0x22c55e, 0xef4444, 0xa855f7];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) g.add(box(0.15, 0.18, 0.02, mat(cols[(r * 3 + c) % cols.length]), -0.32 + c * 0.19, 0.75 + r * 0.28, 0.38));
  g.add(box(0.7, 0.14, 0.05, mat(0x111418), -0.1, 0.42, 0.38)); // dispenser slot
  g.add(box(0.16, 0.5, 0.04, mat(0x1f2937), 0.32, 1.35, 0.38)); // button panel
  g.add(box(0.1, 0.05, 0.02, mat(0x34d399, { emissive: 0x34d399, emissiveIntensity: 0.8 }), 0.32, 1.55, 0.4));
  return g;
}
function trashBin(): THREE.Group {
  const g = new THREE.Group();
  g.add(cyl(0.19, 0.16, 0.52, mat(0x4b5563, { metal: 0.3 }), 0, 0.26, 0));
  g.add(cyl(0.2, 0.2, 0.04, mat(0x6b7280, { metal: 0.4 }), 0, 0.54, 0));
  g.add(box(0.12, 0.02, 0.06, mat(0x374151), 0, 0.57, 0)); // lid flap
  return g;
}
/** Long communal dining table (seats 6, 3 per side). */
function diningTableLong(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(2.4, 0.08, 0.95, mat(0x7a5028, { rough: 0.6 }), 0, 0.74, 0)); // top
  const leg = mat(0x4a3520, { rough: 0.6 });
  for (const [x, z] of [[-1.05, -0.38], [1.05, -0.38], [-1.05, 0.38], [1.05, 0.38]] as const) g.add(box(0.1, 0.74, 0.1, leg, x, 0.37, z));
  g.add(box(2.3, 0.04, 0.12, leg, 0, 0.5, 0)); // apron rail
  return g;
}

// ----------------------------------------------------------------------------
// Phone booth
// ----------------------------------------------------------------------------
function phoneBooth(): THREE.Group {
  const g = new THREE.Group();
  const frame = mat(0x1f2937, { metal: 0.4 });
  const glass = mat(0x67c5ff, { transparent: true, opacity: 0.22, rough: 0.1, metal: 0.2 });
  // corner posts
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) g.add(box(0.1, 2.2, 0.1, frame, x, 1.1, z));
  // glass panels: back + left + right (front open)
  g.add(box(2.0, 2.0, 0.06, glass, 0, 1.1, -1)); // back
  g.add(box(0.06, 2.0, 2.0, glass, -1, 1.1, 0)); // left
  g.add(box(0.06, 2.0, 2.0, glass, 1, 1.1, 0)); // right
  // roof + floor pad
  g.add(box(2.1, 0.1, 2.1, mat(0x111418), 0, 2.2, 0));
  g.add(box(2.0, 0.04, 2.0, mat(0x334155, { rough: 0.9 }), 0, 0.02, 0));
  // ceiling light
  g.add(box(0.7, 0.05, 0.3, mat(0xfff6e0, { emissive: 0xfff6e0, emissiveIntensity: 0.8 }), 0, 2.12, 0));
  // small high stool + shelf
  g.add(cyl(0.22, 0.22, 0.06, mat(0x4a5568), 0, 0.62, 0.3));
  g.add(cyl(0.05, 0.05, 0.6, mat(METAL_DARK), 0, 0.3, 0.3));
  g.add(box(0.7, 0.05, 0.3, mat(WOOD), 0, 1.0, -0.85)); // shelf
  return g;
}

// ----------------------------------------------------------------------------
// Registry
// ----------------------------------------------------------------------------
export const PROC: Record<string, () => THREE.Group> = {
  whiteboard,
  printer,
  standingTable,
  reception,
  serverRack,
  serverTerminal,
  treadmill,
  weightBench,
  dumbbellRack,
  exerciseBike,
  yogaMat,
  waterCooler,
  arcade,
  consoleTV,
  beanbag,
  foosball,
  pingpong,
  easel,
  paintTable,
  artRack,
  pedestal,
  supplyShelf,
  qaTerminal,
  deviceRack,
  testBench,
  phoneBooth,
  kitchenCounter,
  kitchenSink,
  kitchenStove,
  fridgeTall,
  microwave,
  kitchenIsland,
  barStool,
  vendingMachine,
  trashBin,
  diningTableLong,
};

/** A hanging pendant lamp (cord + shade). Returns the group; the caller adds a
 *  matching PointLight. Modelled hanging DOWN from y=0 (caller places at ceiling). */
export function pendantLamp(shadeColor = 0xfff3d6): THREE.Group {
  const g = new THREE.Group();
  g.add(cyl(0.012, 0.012, 1.0, mat(0x111418), 0, -0.5, 0)); // cord
  const shade = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.3, 20, 1, true), mat(0x222a30, { rough: 0.5, metal: 0.3 }));
  shade.position.y = -1.05;
  g.add(shade);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 12), mat(shadeColor, { emissive: shadeColor, emissiveIntensity: 1.2 }));
  bulb.position.y = -1.12;
  g.add(bulb);
  return g;
}
