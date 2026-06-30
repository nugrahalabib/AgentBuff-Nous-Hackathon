"use client";

/**
 * Native AgentBuff 3D office — imperative Three.js (no react-three-fiber).
 *
 * r3f's reconciler doesn't mount under Next 16 + Turbopack + React 19 (blank
 * canvas), so we drive Three.js directly. A hub-and-rooms office (office-layout.ts)
 * with 10 zones, proportional .glb furniture (furniture-catalog.ts: per-type
 * scale + tint) and procedural builds (procedural.ts). Agents pathfind around
 * furniture via a nav grid (nav.ts) — idle agents wander, working agents walk to
 * a desk and sit. Palette + proportions mirror hermes-office (MIT).
 */
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  ROOM,
  PALETTE,
  RUGS,
  INTERIOR_WALLS,
  WINDOWS,
  WALL_ART,
  WORKSTATIONS,
  PLACEMENTS,
  LAMPS,
  ACTIVITY_SPOTS,
  randomWanderPoint,
  type Activity,
  type ActivitySpot,
} from "./office-layout";
import { CATALOG, rotatedFootprint, type CatalogEntry } from "./furniture-catalog";
import { PROC, pendantLamp } from "./procedural";
import { NavGrid, footprintAABB, type AABB, type Pt } from "./nav";

export type OfficeAgentInput = {
  id: string;
  name: string;
  status: "idle" | "working" | "blocked";
};

const AGENT_COLORS = [0x22d3ee, 0xa78bfa, 0xf472b6, 0x34d399, 0xfbbf24, 0x60a5fa, 0xfb7185, 0x4ade80];
function colorFor(id: string, i: number): number {
  let h = 0;
  for (let k = 0; k < id.length; k++) h = (h * 31 + id.charCodeAt(k)) >>> 0;
  return AGENT_COLORS[(h + i) % AGENT_COLORS.length];
}
const STATUS_RING: Record<OfficeAgentInput["status"], number> = {
  idle: 0x64748b,
  working: 0x34d399,
  blocked: 0xf87171,
};

type AgentRuntime = {
  group: THREE.Group;
  body: THREE.Group; // pelvis
  ring: THREE.Mesh;
  // articulated joints (groups) so seated/working poses bend at knee + elbow
  hipL: THREE.Group;
  hipR: THREE.Group;
  kneeL: THREE.Group;
  kneeR: THREE.Group;
  shoulderL: THREE.Group;
  shoulderR: THREE.Group;
  elbowL: THREE.Group;
  elbowR: THREE.Group;
  pos: THREE.Vector3;
  goal: { x: number; z: number };
  path: Pt[];
  pathIdx: number;
  phase: number;
  facing: number;
  mode: "work" | "roam";
  spot: ActivitySpot | null;
  activity: Activity | ""; // "" while walking to the spot
  dwellUntil: number;
  spotIndex: number; // claimed ACTIVITY_SPOTS index, or -1
  deskIndex: number; // claimed WORKSTATIONS index, or -1
  moving: boolean; // transient, set each frame
  stuckPos: THREE.Vector3; // position sampled at the last deadlock check
  stuckStrikes: number; // consecutive checks with no real progress
  nextStuckCheck: number; // clock time of the next deadlock check
  frameX: number; // pos.x at the start of the current frame (for real velocity)
  frameZ: number;
  velX: number; // low-pass smoothed velocity (drives facing + gait, jitter-free)
  velZ: number;
};

function nameSprite(text: string): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext("2d")!;
  ctx.font = "bold 34px Inter, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgba(11,14,20,0.92)";
  ctx.strokeText(text, 128, 34);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  s.scale.set(2.2, 0.55, 1);
  s.position.set(0, 1.95, 0);
  return s;
}

function buildAgent(agent: OfficeAgentInput, color: number, spawn: [number, number]): AgentRuntime {
  const group = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.34, 0.46, 24),
    new THREE.MeshBasicMaterial({ color: STATUS_RING[agent.status], transparent: true, opacity: 0.9 }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  group.add(ring);

  // pelvis — the root of the body; legs hang down, torso/arms/head go up.
  const body = new THREE.Group();
  body.position.y = 0.82;
  const skin = new THREE.MeshStandardMaterial({ color, roughness: 0.55 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.7 });
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.52, 0.28), skin);
  torso.position.y = 0.28;
  body.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 16), new THREE.MeshStandardMaterial({ color: 0xf1d3b8, roughness: 0.5 }));
  head.position.y = 0.68;
  body.add(head);

  // arm: shoulder group -> upper arm + elbow group -> forearm
  const makeArm = (sx: number) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(sx * 0.28, 0.46, 0);
    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.067, 0.24, 4, 8), skin);
    upper.position.y = -0.15;
    shoulder.add(upper);
    const elbow = new THREE.Group();
    elbow.position.y = -0.3;
    shoulder.add(elbow);
    const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.24, 4, 8), skin);
    fore.position.y = -0.15;
    elbow.add(fore);
    body.add(shoulder);
    return { shoulder, elbow };
  };
  // leg: hip group -> thigh + knee group -> shin + foot
  const makeLeg = (sx: number) => {
    const hip = new THREE.Group();
    hip.position.set(sx * 0.12, 0, 0);
    const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.083, 0.32, 4, 8), dark);
    thigh.position.y = -0.21;
    hip.add(thigh);
    const knee = new THREE.Group();
    knee.position.y = -0.42;
    hip.add(knee);
    const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.32, 4, 8), dark);
    shin.position.y = -0.21;
    knee.add(shin);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.22), dark);
    foot.position.set(0, -0.42, 0.05);
    knee.add(foot);
    body.add(hip);
    return { hip, knee };
  };
  const aL = makeArm(-1);
  const aR = makeArm(1);
  const lL = makeLeg(-1);
  const lR = makeLeg(1);
  group.add(body);
  group.add(nameSprite(agent.name));
  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
  });

  return {
    group,
    body,
    ring,
    hipL: lL.hip,
    hipR: lR.hip,
    kneeL: lL.knee,
    kneeR: lR.knee,
    shoulderL: aL.shoulder,
    shoulderR: aR.shoulder,
    elbowL: aL.elbow,
    elbowR: aR.elbow,
    pos: new THREE.Vector3(spawn[0], 0, spawn[1]),
    goal: { x: spawn[0], z: spawn[1] },
    path: [],
    pathIdx: 0,
    phase: Math.random() * 6,
    facing: 0,
    mode: "roam",
    spot: null,
    activity: "",
    dwellUntil: 0,
    spotIndex: -1,
    deskIndex: -1,
    moving: false,
    stuckPos: new THREE.Vector3(spawn[0], 0, spawn[1]),
    stuckStrikes: 0,
    nextStuckCheck: 0,
    frameX: spawn[0],
    frameZ: spawn[1],
    velX: 0,
    velZ: 0,
  };
}

const STAND_Y = 0.82;
const SIT_Y = 0.52; // pelvis height when sitting on a seat
const SIT_HIP = -1.45; // thigh forward (horizontal)
const SIT_KNEE = 1.5; // shin bends back down

/**
 * Pose the articulated agent for an activity. Sets hip/knee (legs) + shoulder/
 * elbow (arms) rotations + pelvis height/tilt. Seated poses bend the thigh
 * forward and the shin down so the agent actually sits on the seat instead of
 * its legs sticking straight out.
 */
function applyPose(r: AgentRuntime, act: Activity | "walk", dt: number) {
  r.phase += dt * (act === "walk" ? 9 : 3);
  const p = r.phase;
  const sy = r.spot?.sitY ?? SIT_Y; // seat height for this furniture
  // defaults: standing straight
  let hl = 0, hr = 0, kl = 0, kr = 0; // hips, knees
  let sl = 0, sr = 0, el = 0, er = 0; // shoulders, elbows
  let pelvisY = STAND_Y, tilt = 0, bob = 0;
  const seat = () => { hl = SIT_HIP; hr = SIT_HIP; kl = SIT_KNEE; kr = SIT_KNEE; pelvisY = sy; };
  switch (act) {
    case "walk": { const s = Math.sin(p) * 0.5; hl = s; hr = -s; kl = Math.max(0, -s) * 0.7; kr = Math.max(0, s) * 0.7; sl = -s * 0.6; sr = s * 0.6; bob = Math.abs(Math.sin(p)) * 0.05; break; }
    case "run": { const s = Math.sin(p * 3) * 0.85; hl = s; hr = -s; kl = Math.max(0, -s) * 1.1 + 0.2; kr = Math.max(0, s) * 1.1 + 0.2; sl = -s; sr = s; el = -0.5; er = -0.5; bob = Math.abs(Math.sin(p * 3)) * 0.06; break; }
    case "sit": { seat(); sl = 0.15; sr = 0.15; el = -0.4; er = -0.4; break; }
    case "work": { seat(); sl = -1.0; sr = -1.0 + Math.sin(p * 4) * 0.1; el = -0.7; er = -0.7; break; }
    case "relax": { hl = -1.15; hr = -1.15; kl = 1.0; kr = 1.0; pelvisY = sy; tilt = -0.16; sl = 0.3; sr = 0.3; el = -0.35; er = -0.35; break; }
    case "bike": { const s = Math.sin(p * 4); hl = -1.35 + s * 0.28; hr = -1.35 - s * 0.28; kl = 1.3 - s * 0.45; kr = 1.3 + s * 0.45; pelvisY = 0.6; tilt = -0.18; sl = -1.0; sr = -1.0; el = -0.6; er = -0.6; break; }
    case "lift": { const s = Math.sin(p * 2); sl = -0.35; sr = -0.35; el = -1.4 - s * 1.0; er = -1.4 - s * 1.0; break; } // dumbbell curl
    case "stretch": { sl = -2.75; sr = -2.75; tilt = Math.sin(p) * 0.16; break; }
    case "standwork": { sl = -1.05; sr = -1.05 + Math.sin(p * 4) * 0.12; el = -0.75; er = -0.75; bob = Math.sin(p * 2) * 0.01; break; }
    case "paint": { sl = -0.3; sr = -1.2 + Math.sin(p * 3) * 0.28; er = -0.55; break; }
    case "pingpong": { sr = -1.0 + Math.sin(p * 4) * 0.7; er = -0.6; sl = -0.4; hl = Math.sin(p * 4) * 0.18; hr = -Math.sin(p * 4) * 0.18; bob = Math.abs(Math.sin(p * 4)) * 0.03; break; }
    case "arcade": { sl = -1.2; sr = -1.2; el = -0.9; er = -0.9 + Math.sin(p * 6) * 0.2; break; }
    case "browse": { sl = -0.2; sr = -2.2 + Math.sin(p * 1.5) * 0.2; er = -0.4; break; }
    case "phone": { sl = -0.2; sr = -2.2; er = -1.6; break; } // hand to ear
    case "drink": { sl = -0.2; sr = -2.0 - Math.sin(p) * 0.1; er = -1.6; break; }
    case "dance": { const s = Math.sin(p * 3); sl = -2.4 - s * 0.4; sr = -2.4 + s * 0.4; el = -0.5; er = -0.5; hl = Math.sin(p * 4) * 0.12; hr = -Math.sin(p * 4) * 0.12; bob = Math.abs(Math.sin(p * 4)) * 0.13; tilt = Math.sin(p * 3) * 0.12; break; }
    default: { sl = Math.sin(p) * 0.05; sr = -Math.sin(p) * 0.05; bob = Math.sin(p) * 0.02; }
  }
  r.hipL.rotation.x = hl;
  r.hipR.rotation.x = hr;
  r.kneeL.rotation.x = kl;
  r.kneeR.rotation.x = kr;
  r.shoulderL.rotation.x = sl;
  r.shoulderR.rotation.x = sr;
  r.elbowL.rotation.x = el;
  r.elbowR.rotation.x = er;
  r.body.rotation.x = tilt;
  r.body.position.y = pelvisY + bob;
}

// Persist view + agent positions across route remounts (tab switches). Each
// /app tab is its own Next route, so leaving the Office UNMOUNTS this scene and
// returning REMOUNTS it from scratch. Stashing the camera + per-agent positions
// at module scope lets the rebuilt scene RESUME where it left off instead of
// snapping back to an empty room with everyone walking in again.
const _viewState: {
  cam?: { pos: [number, number, number]; target: [number, number, number] };
} = {};
const _agentState = new Map<string, { x: number; z: number; facing: number }>();

export function OfficeScene({ agents }: { agents: OfficeAgentInput[] }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const agentsRef = useRef<OfficeAgentInput[]>(agents);
  agentsRef.current = agents;
  const runtimeRef = useRef<Map<string, AgentRuntime>>(new Map());
  // Set inside the mount effect; lets the agents-prop effect re-sync the roster
  // the instant agents.list resolves (no waiting for the 4s plan timer).
  const syncFnRef = useRef<() => void>(() => {});
  // Bumped to force a full scene rebuild when the WebGL context is lost (the
  // canvas stops painting while the rAF loop keeps moving agents in JS — the
  // "agents move but nothing shows until a full reload" symptom). Capped so a
  // persistently-failing context can't loop forever.
  const [gen, setGen] = useState(0);
  const rebuildCountRef = useRef(0);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const HW = ROOM.w / 2;
    const HD = ROOM.d / 2;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0e14);
    scene.fog = new THREE.Fog(0x0b0e14, 60, 130);

    const camera = new THREE.PerspectiveCamera(42, mount.clientWidth / mount.clientHeight, 0.1, 400);
    camera.position.set(23, 28, 29);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.8));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 1, 0);
    controls.minDistance = 14;
    controls.maxDistance = 78;
    controls.maxPolarAngle = Math.PI / 2.15;
    controls.enableDamping = true;
    // Resume the previous viewpoint on a tab switch instead of snapping back to
    // the default camera angle.
    if (_viewState.cam) {
      camera.position.set(
        _viewState.cam.pos[0],
        _viewState.cam.pos[1],
        _viewState.cam.pos[2],
      );
      controls.target.set(
        _viewState.cam.target[0],
        _viewState.cam.target[1],
        _viewState.cam.target[2],
      );
    }

    // ---- lighting -----------------------------------------------------------
    scene.add(new THREE.AmbientLight(0xffffff, 0.66));
    scene.add(new THREE.HemisphereLight(0xfff3e0, 0x2a2620, 0.78));
    const sun = new THREE.DirectionalLight(0xfff1d8, 1.1);
    sun.position.set(18, 30, 14);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -26;
    sc.right = 26;
    sc.top = 18;
    sc.bottom = -18;
    sc.far = 90;
    scene.add(sun);
    const serverLight = new THREE.PointLight(0x6d5cff, 0.7, 16);
    serverLight.position.set(-5.5, 3, -10.5);
    const gameLight = new THREE.PointLight(0xc026d3, 0.6, 18);
    gameLight.position.set(16, 3, 8.5);
    const gymLight = new THREE.PointLight(0xeaf2ff, 0.5, 18);
    gymLight.position.set(3.5, 3.2, -10.5);
    scene.add(serverLight, gameLight, gymLight);

    // ---- floor + rugs -------------------------------------------------------
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(ROOM.w, ROOM.d),
      new THREE.MeshStandardMaterial({ color: PALETTE.floorWood, roughness: 0.92, metalness: 0.04 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    for (const r of RUGS) {
      const rug = new THREE.Mesh(
        new THREE.PlaneGeometry(r.w, r.d),
        new THREE.MeshStandardMaterial({
          color: r.color,
          roughness: 0.95,
          transparent: true,
          opacity: r.opacity ?? 0.7,
          depthWrite: false, // draw over the floor without z-fighting
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        }),
      );
      rug.rotation.x = -Math.PI / 2;
      rug.position.set(r.cx, 0.03, r.cz);
      rug.renderOrder = 1;
      rug.receiveShadow = true;
      scene.add(rug);
    }

    // ---- walls --------------------------------------------------------------
    const obstacles: AABB[] = [];
    const outerMat = new THREE.MeshStandardMaterial({ color: PALETTE.wallOuter, roughness: 0.9, metalness: 0.05 });
    const innerMat = new THREE.MeshStandardMaterial({ color: PALETTE.wallInner, roughness: 0.88, metalness: 0.05 });
    const baseboardMat = new THREE.MeshStandardMaterial({ color: PALETTE.baseboard, roughness: 0.85 });
    const mkWall = (cx: number, cz: number, sx: number, sz: number, h: number, mat: THREE.Material, block: boolean) => {
      const w = new THREE.Mesh(new THREE.BoxGeometry(sx, h, sz), mat);
      w.position.set(cx, h / 2, cz);
      w.receiveShadow = true;
      w.castShadow = true;
      scene.add(w);
      const bb = new THREE.Mesh(new THREE.BoxGeometry(sx + 0.03, 0.18, sz + 0.03), baseboardMat);
      bb.position.set(cx, 0.09, cz);
      scene.add(bb);
      if (block) obstacles.push([cx - sx / 2, cz - sz / 2, cx + sx / 2, cz + sz / 2]);
    };
    mkWall(0, -HD, ROOM.w, 0.3, ROOM.wallH, outerMat, true);
    mkWall(0, HD, ROOM.w, 0.3, ROOM.wallH, outerMat, true);
    mkWall(-HW, 0, 0.3, ROOM.d, ROOM.wallH, outerMat, true);
    mkWall(HW, 0, 0.3, ROOM.d, ROOM.wallH, outerMat, true);
    const innerH = 2.0; // low dividers → dollhouse view over the walls
    for (const w of INTERIOR_WALLS) mkWall(w.cx, w.cz, w.sx, w.sz, innerH, innerMat, true);

    // windows — framed glass set flush on the inner face of the outer wall
    const winMat = new THREE.MeshStandardMaterial({ color: PALETTE.windowGlow, emissive: PALETTE.windowGlow, emissiveIntensity: 0.45, roughness: 0.2 });
    const winFrameMat = new THREE.MeshStandardMaterial({ color: 0x2a2118, roughness: 0.7, metalness: 0.2 });
    const WALL_HALF = 0.15;
    const winYC = 1.7;
    for (const win of WINDOWS) {
      const g = new THREE.Group();
      const fH = win.h + 0.24;
      if (win.axis === "x") {
        const fW = win.w + 0.24;
        g.add(new THREE.Mesh(new THREE.BoxGeometry(fW, fH, 0.07), winFrameMat)); // frame plate
        g.add(new THREE.Mesh(new THREE.BoxGeometry(win.w, win.h, 0.05), winMat).translateZ(0.04)); // glass
        g.add(new THREE.Mesh(new THREE.BoxGeometry(fW, 0.07, 0.09), winFrameMat).translateZ(0.05)); // h mullion
        g.add(new THREE.Mesh(new THREE.BoxGeometry(0.07, fH, 0.09), winFrameMat).translateZ(0.05)); // v mullion
        const sign = Math.sign(win.cz) || 1;
        g.position.set(win.cx, winYC, win.cz - sign * (WALL_HALF + 0.04));
      } else {
        const fD = win.w + 0.24;
        g.add(new THREE.Mesh(new THREE.BoxGeometry(0.07, fH, fD), winFrameMat));
        g.add(new THREE.Mesh(new THREE.BoxGeometry(0.05, win.h, win.w), winMat).translateX(0.04));
        g.add(new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.07, fD), winFrameMat).translateX(0.05));
        g.add(new THREE.Mesh(new THREE.BoxGeometry(0.09, fH, 0.07), winFrameMat).translateX(0.05));
        const sign = Math.sign(win.cx) || 1;
        g.position.set(win.cx - sign * (WALL_HALF + 0.04), winYC, win.cz);
      }
      scene.add(g);
    }
    // wall art / neon — set just in front of the wall face (toward the room) so
    // the panel never z-fights with the wall it hangs on.
    for (const art of WALL_ART) {
      const geo = art.axis === "x" ? new THREE.BoxGeometry(art.w, art.h, 0.06) : new THREE.BoxGeometry(0.06, art.h, art.w);
      const m = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          color: art.color,
          emissive: art.emissive ? art.color : 0x000000,
          emissiveIntensity: art.emissive ? 0.45 : 0,
          roughness: 0.5,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
        }),
      );
      const cx = art.axis === "z" ? art.cx - Math.sign(art.cx || -1) * 0.12 : art.cx;
      const cz = art.axis === "x" ? art.cz - Math.sign(art.cz || -1) * 0.12 : art.cz;
      m.position.set(cx, ROOM.wallH * 0.5, cz);
      scene.add(m);
    }

    // ---- furniture (glb + procedural) + nav obstacles -----------------------
    const loader = new GLTFLoader();
    let disposed = false;
    const Y_AXIS = new THREE.Vector3(0, 1, 0);
    /**
     * Load a .glb, normalise it (centre its footprint on x/z + rest its bottom
     * on `bottomY`) so pivots/offsets in the source models can't make furniture
     * float or drift, then tint + scale it. `onReady` reports the final world
     * bounding box (used to stack a monitor on a desk).
     */
    const loadGlb = (
      url: string,
      scale: [number, number, number],
      tint: number | null,
      x: number,
      z: number,
      rot: number,
      opts?: { bottomY?: number; onReady?: (box: THREE.Box3) => void },
    ) => {
      loader.load(url, (gltf) => {
        if (disposed) return;
        const m = gltf.scene;
        m.position.set(0, 0, 0);
        m.rotation.y = rot;
        m.scale.set(scale[0], scale[1], scale[2]);
        m.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh) {
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            if (tint !== null) {
              const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
              mat.color.setHex(tint);
              mesh.material = mat;
            }
          }
        });
        m.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(m);
        const cx = (box.min.x + box.max.x) / 2;
        const cz = (box.min.z + box.max.z) / 2;
        m.position.set(x - cx, (opts?.bottomY ?? 0) - box.min.y, z - cz);
        scene.add(m);
        if (opts?.onReady) {
          m.updateMatrixWorld(true);
          opts.onReady(new THREE.Box3().setFromObject(m));
        }
      });
    };

    for (const p of PLACEMENTS) {
      const entry = CATALOG[p.type] as CatalogEntry;
      const rot = p.rot ?? 0;
      if (entry.glb) {
        loadGlb(entry.glb, entry.scale ?? [1, 1, 1], entry.tint ?? null, p.x, p.z, rot, p.y ? { bottomY: p.y } : undefined);
      } else if (entry.proc) {
        const g = PROC[entry.proc]();
        g.position.set(p.x, p.y ?? 0, p.z);
        g.rotation.y = rot;
        scene.add(g);
      }
      if (entry.blocks) {
        const [w, d] = rotatedFootprint(entry.footprint, rot);
        obstacles.push(footprintAABB(p.x, p.z, w, d));
      }
    }

    // workstations: desk + monitor-on-desk + tucked chair facing the desk.
    // Each is a tight unit; the .glb are normalised so they actually line up.
    const deskEntry = CATALOG.desk;
    const compEntry = CATALOG.computer;
    const chairEntry = CATALOG.chair;
    for (const ws of WORKSTATIONS) {
      const [dx, dz] = ws.deskPos;
      // +local Z = the user/seat side of the desk; -local Z = the monitor side.
      const fwd = new THREE.Vector3(0, 0, 1).applyAxisAngle(Y_AXIS, ws.rot);
      loadGlb(deskEntry.glb!, deskEntry.scale!, deskEntry.tint!, dx, dz, ws.rot, {
        onReady: (box) => {
          const deskTop = box.max.y;
          loadGlb(compEntry.glb!, compEntry.scale!, compEntry.tint!, dx - fwd.x * 0.16, dz - fwd.z * 0.16, ws.rot, {
            bottomY: deskTop - 0.02,
          });
        },
      });
      // chair just in front of the desk, seat facing the desk
      loadGlb(chairEntry.glb!, chairEntry.scale!, chairEntry.tint!, dx + fwd.x * 0.86, dz + fwd.z * 0.86, ws.rot + Math.PI);
      const [bw, bd] = rotatedFootprint(deskEntry.footprint, ws.rot);
      obstacles.push(footprintAABB(dx, dz, bw, bd));
    }

    // ---- pendant lamps ------------------------------------------------------
    let lampLights = 0;
    for (const lamp of LAMPS) {
      const g = pendantLamp(lamp.color);
      g.position.set(lamp.x, ROOM.wallH, lamp.z);
      scene.add(g);
      if (lampLights < 3) {
        const pl = new THREE.PointLight(lamp.color ?? 0xfff3d6, 0.45, 12);
        pl.position.set(lamp.x, ROOM.wallH - 1.2, lamp.z);
        scene.add(pl);
        lampLights++;
      }
    }

    // ---- nav grid -----------------------------------------------------------
    const nav = new NavGrid(ROOM.w, ROOM.d, obstacles);

    // ---- collect blinking meshes (server LEDs, screens) ---------------------
    const blinkers: { mesh: THREE.Mesh; off: number }[] = [];
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.userData.blink !== undefined) blinkers.push({ mesh, off: mesh.userData.blink });
    });

    // ---- agents -------------------------------------------------------------
    // Reservation: each activity spot + each desk is used by at most one agent,
    // so agents never pile onto the same furniture. Extra agents (more than the
    // available spots/desks) idle in the open floor instead.
    const spotTaken = new Array(ACTIVITY_SPOTS.length).fill(false);
    const deskTaken = new Array(WORKSTATIONS.length).fill(false);
    function releaseClaims(r: AgentRuntime) {
      if (r.spotIndex >= 0) spotTaken[r.spotIndex] = false;
      if (r.deskIndex >= 0) deskTaken[r.deskIndex] = false;
      r.spotIndex = -1;
      r.deskIndex = -1;
    }
    function claimFree(taken: boolean[]): number {
      const free: number[] = [];
      for (let i = 0; i < taken.length; i++) if (!taken[i]) free.push(i);
      if (!free.length) return -1;
      const idx = free[Math.floor(Math.random() * free.length)];
      taken[idx] = true;
      return idx;
    }

    function syncAgents() {
      const rt = runtimeRef.current;
      const list = agentsRef.current;
      const ids = new Set(list.map((a) => a.id));
      for (const [id, r] of rt) {
        if (!ids.has(id)) {
          releaseClaims(r);
          scene.remove(r.group);
          rt.delete(id);
        }
      }
      list.forEach((a, i) => {
        let r = rt.get(a.id);
        if (!r) {
          // Resume this agent's last position (tab switch) so it doesn't walk
          // in from spawn every time; fall back to a random spot for new agents.
          const saved = _agentState.get(a.id);
          const spawn: [number, number] = saved
            ? [saved.x, saved.z]
            : [(Math.random() - 0.5) * 6, 1 + (Math.random() - 0.5) * 4];
          r = buildAgent(a, colorFor(a.id, i), spawn);
          if (saved) {
            r.facing = saved.facing;
            r.group.rotation.y = saved.facing;
          }
          rt.set(a.id, r);
          scene.add(r.group);
        }
        (r.ring.material as THREE.MeshBasicMaterial).color.setHex(STATUS_RING[a.status]);
      });
    }
    syncAgents();

    function pathTo(r: AgentRuntime, gx: number, gz: number) {
      r.goal = { x: gx, z: gz };
      r.path = nav.findPath(r.pos.x, r.pos.z, gx, gz);
      r.pathIdx = 0;
      r.activity = ""; // walking until arrival
    }
    function sendToDesk(r: AgentRuntime) {
      releaseClaims(r);
      r.mode = "work";
      const idx = claimFree(deskTaken);
      if (idx < 0) {
        // no free desk — work standing wherever there's room
        const wp = randomWanderPoint();
        r.spot = { x: wp[0], z: wp[1], facing: 0, activity: "standwork" };
        pathTo(r, wp[0], wp[1]);
        return;
      }
      r.deskIndex = idx;
      const ws = WORKSTATIONS[idx];
      // Face the desk: the seat sits on the +Z(local) side, so looking toward
      // the desk is ws.rot + PI (same heading the chair .glb is rotated to).
      // A hardcoded PI only happened to be right for rot=0 desks.
      r.spot = {
        x: ws.seat[0],
        z: ws.seat[1],
        facing: ws.rot + Math.PI,
        activity: "work",
      };
      pathTo(r, ws.seat[0], ws.seat[1]);
    }
    function sendRoaming(r: AgentRuntime) {
      releaseClaims(r);
      r.mode = "roam";
      const idx = claimFree(spotTaken);
      if (idx < 0) {
        // every spot is taken — wander to an open point and just stand
        const wp = randomWanderPoint();
        r.spot = { x: wp[0], z: wp[1], facing: Math.random() * Math.PI * 2, activity: "stand" };
        pathTo(r, wp[0], wp[1]);
        return;
      }
      r.spotIndex = idx;
      const spot = ACTIVITY_SPOTS[idx];
      r.spot = spot;
      pathTo(r, spot.x, spot.z);
    }
    // assign each agent a job (working -> desk, idle -> roam) on status change
    function planTargets() {
      for (const a of agentsRef.current) {
        const r = runtimeRef.current.get(a.id);
        if (!r) continue;
        const wants = a.status === "working" || a.status === "blocked" ? "work" : "roam";
        if (wants === "work") {
          if (r.mode !== "work") sendToDesk(r);
        } else if (r.mode !== "roam" || !r.spot) {
          sendRoaming(r);
        }
      }
    }
    planTargets();
    // Immediate resync hook — the agents-prop effect calls this so a freshly
    // resolved agents.list shows up at once (not after the 4s plan tick).
    syncFnRef.current = () => {
      syncAgents();
      planTargets();
    };
    const planTimer = setInterval(() => {
      syncAgents();
      planTargets();
    }, 4000);

    // ---- resize -------------------------------------------------------------
    const onResize = () => {
      if (!mountRef.current) return;
      const w = mountRef.current.clientWidth;
      const h = mountRef.current.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    // Diagnostics + self-heal for the "scene runs but nothing paints" symptom.
    // The rAF loop keeps moving agents in JS even when the GL context is lost,
    // so the office looks frozen/empty until a full page reload. Catch the loss
    // and rebuild (capped). Also re-measure a few times after mount in case the
    // container wasn't fully laid out yet on a client-side route transition.
    const canvasEl = renderer.domElement;
    const onContextLost = (e: Event) => {
      e.preventDefault();
      console.warn("[office3d] webglcontextlost (rebuild %d/3)", rebuildCountRef.current + 1);
      if (rebuildCountRef.current < 3) {
        rebuildCountRef.current += 1;
        setGen((g) => g + 1);
      }
    };
    const onContextRestored = () => console.info("[office3d] webglcontextrestored");
    canvasEl.addEventListener("webglcontextlost", onContextLost, false);
    canvasEl.addEventListener("webglcontextrestored", onContextRestored, false);
    const settleTimers = [80, 300, 800, 1600].map((ms) =>
      setTimeout(onResize, ms),
    );

    // ---- animation loop -----------------------------------------------------
    const clock = new THREE.Clock();
    let raf = 0;
    const SPEED = 2.4;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      // Render every frame (60fps) — the office is NEVER throttled. Smoothness
      // during a streaming chat comes from the chat side being lighter (the
      // streaming markdown re-parse is throttled), not from slowing the 3D.
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.elapsedTime;
      for (const b of blinkers) (b.mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.3 + (Math.sin(t * 3 + b.off) + 1) * 0.45;

      const agentList = [...runtimeRef.current.values()];
      // pass 1 — advance along the path + start/refresh activities
      for (const r of agentList) {
        // record the frame-start position so pass 3 can read the TRUE per-frame
        // displacement (path step + separation push) and face/animate by that.
        r.frameX = r.pos.x;
        r.frameZ = r.pos.z;
        r.moving = false;
        if (r.pathIdx < r.path.length) {
          const wp = r.path[r.pathIdx];
          const dx = wp.x - r.pos.x;
          const dz = wp.z - r.pos.z;
          const dist = Math.hypot(dx, dz);
          if (dist < 0.22) {
            r.pathIdx++;
          } else {
            const step = Math.min(dist, SPEED * dt);
            r.pos.x += (dx / dist) * step;
            r.pos.z += (dz / dist) * step;
            r.moving = true;
          }
        }
        const arrived = r.pathIdx >= r.path.length;
        if (arrived && r.spot) {
          if (r.activity === "") {
            r.activity = r.spot.activity;
            r.facing = r.spot.facing;
            r.dwellUntil = t + 7 + Math.random() * 12;
          } else if (r.mode === "roam" && t > r.dwellUntil) {
            sendRoaming(r);
          }
        }

        // deadlock breaker — two agents can wedge each other (each keeps
        // walking into the other while separation shoves them back), freezing
        // both forever. If an agent still has a path but made no real progress
        // since the last check, re-path around the blocker; if it's STILL stuck
        // next time, abandon the goal and pick a fresh one.
        if (t >= r.nextStuckCheck) {
          const progressed = Math.hypot(
            r.pos.x - r.stuckPos.x,
            r.pos.z - r.stuckPos.z,
          );
          const tryingToMove = r.pathIdx < r.path.length;
          if (tryingToMove && progressed < 0.2) {
            r.stuckStrikes += 1;
            if (r.stuckStrikes === 1) {
              r.path = nav.findPath(r.pos.x, r.pos.z, r.goal.x, r.goal.z);
              r.pathIdx = 0;
            } else {
              r.stuckStrikes = 0;
              if (r.mode === "work") sendToDesk(r);
              else sendRoaming(r);
            }
          } else {
            r.stuckStrikes = 0;
          }
          r.stuckPos.set(r.pos.x, 0, r.pos.z);
          r.nextStuckCheck = t + 0.8;
        }
      }
      // pass 2 — separation: push overlapping agents apart, PLUS a perpendicular
      // sidestep (opposite directions per pair) so two walkers orbit PAST each
      // other instead of bouncing straight back into a head-on standstill.
      for (let i = 0; i < agentList.length; i++) {
        for (let j = i + 1; j < agentList.length; j++) {
          const a = agentList[i];
          const b = agentList[j];
          const dx = b.pos.x - a.pos.x;
          const dz = b.pos.z - a.pos.z;
          const d = Math.hypot(dx, dz);
          if (d > 0.0001 && d < 0.6) {
            const overlap = 0.6 - d;
            const push = overlap * 0.5;
            const nx = dx / d;
            const nz = dz / d;
            // perpendicular to the a->b axis; only applied when BOTH are walking
            // (a head-on), so they swing around rather than wedge.
            const px = -nz;
            const pz = nx;
            const slide = a.moving && b.moving ? overlap * 0.6 : 0;
            if (a.moving || !b.moving) {
              a.pos.x += -nx * push + px * slide;
              a.pos.z += -nz * push + pz * slide;
            }
            if (b.moving || !a.moving) {
              b.pos.x += nx * push - px * slide;
              b.pos.z += nz * push - pz * slide;
            }
          }
        }
      }
      // pass 3 — derive facing + gait from the agent's ACTUAL post-separation
      // motion (low-pass smoothed) so a sidestep turns the body the way it truly
      // travels (no moonwalk) and walk/stand doesn't flicker frame-to-frame.
      for (const r of agentList) {
        const ddx = r.pos.x - r.frameX;
        const ddz = r.pos.z - r.frameZ;
        const invDt = 1 / Math.max(dt, 1e-4);
        // low-pass the velocity so per-frame separation nudges don't jitter it
        const k = Math.min(1, dt * 12);
        r.velX += (ddx * invDt - r.velX) * k;
        r.velZ += (ddz * invDt - r.velZ) * k;
        const speed = Math.hypot(r.velX, r.velZ);
        // Steer the body by travel direction ONLY while still walking to a spot
        // (activity not yet started). Once arrived, honor the spot's facing so a
        // seated agent faces its desk instead of freezing on the direction it
        // happened to approach from.
        if (r.activity === "") {
          if (speed > 0.35) r.facing = Math.atan2(r.velX, r.velZ);
        } else if (r.spot) {
          r.facing = r.spot.facing;
        }

        r.group.position.set(r.pos.x, 0, r.pos.z);
        let rd = r.facing - r.group.rotation.y;
        while (rd > Math.PI) rd -= Math.PI * 2;
        while (rd < -Math.PI) rd += Math.PI * 2;
        r.group.rotation.y += rd * Math.min(1, dt * 9);

        // walk gait while actually moving; otherwise the activity/idle pose.
        // Hysteresis via the smoothed speed avoids walk<->stand strobing.
        const walking = speed > 0.5;
        applyPose(r, walking ? "walk" : r.activity || "stand", dt);
      }
      controls.update();
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      clearInterval(planTimer);
      ro.disconnect();
      canvasEl.removeEventListener("webglcontextlost", onContextLost);
      canvasEl.removeEventListener("webglcontextrestored", onContextRestored);
      settleTimers.forEach(clearTimeout);
      // Stash camera + agent positions so the next mount resumes this view.
      _viewState.cam = {
        pos: [camera.position.x, camera.position.y, camera.position.z],
        target: [controls.target.x, controls.target.y, controls.target.z],
      };
      for (const [id, r] of runtimeRef.current) {
        _agentState.set(id, { x: r.pos.x, z: r.pos.z, facing: r.facing });
      }
      controls.dispose();
      // Dispose ALL GPU resources (geometry + materials + their textures).
      const seenMat = new Set<THREE.Material>();
      const killMat = (mat: THREE.Material) => {
        if (seenMat.has(mat)) return;
        seenMat.add(mat);
        const maps = mat as unknown as Record<
          string,
          { dispose?: () => void } | undefined
        >;
        for (const k of [
          "map", "lightMap", "aoMap", "emissiveMap", "normalMap",
          "roughnessMap", "metalnessMap", "alphaMap",
        ]) {
          maps[k]?.dispose?.();
        }
        mat.dispose?.();
      };
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose?.();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach(killMat);
        else if (mat) killMat(mat);
      });
      renderer.dispose();
      // CRITICAL: renderer.dispose() does NOT free the WebGL context. Without
      // forceContextLoss the browser keeps one context per route remount and,
      // past its ~16 limit, refuses new ones — so returning to the Office tab
      // repeatedly left a blank canvas that only a hard refresh could clear.
      renderer.forceContextLoss();
      if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gen]);

  const agentsKeyRef = useRef("");
  useEffect(() => {
    agentsRef.current = agents;
    // Re-sync the scene ONLY when the roster or a STATUS actually changes — not
    // on every new array reference. While a chat streams, `streaming`/`sending`
    // change ~every 150ms upstream, recreating this `agents` array each time;
    // firing syncAgents()+planTargets() that often churned the whole scene + its
    // pathfinding and made the office stutter ("lag/patah-patah saat bekerja").
    // Status flips (idle<->working) still trigger an immediate re-plan, so an
    // agent still walks to its desk the moment it starts working (and back when
    // it stops) — including right after a refresh once the working signal lands.
    const key = agents.map((a) => a.id + ":" + a.status).join("|");
    if (key !== agentsKeyRef.current) {
      agentsKeyRef.current = key;
      syncFnRef.current();
    }
  }, [agents]);

  return <div ref={mountRef} className="size-full" style={{ background: "#0b0e14" }} />;
}
