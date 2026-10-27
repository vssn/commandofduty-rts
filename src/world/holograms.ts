import { Constants, DynamicTexture, Mesh, MeshBuilder, StandardMaterial, Color3, Vector4, type Scene } from "@babylonjs/core";
import { MAP_HALF } from "../config";
import { toLocal, toWorld, type MapLayout, type V2 } from "./layout";
import { mat } from "./models";
import type { Obstacle } from "./props";
import type { Terrain } from "./terrain";

/**
 * Warning holograms: free-standing displays projected from a small puck on the ground, standing in the villages of
 * the hill country and in the streets of the embassy district. They tell whoever is left there not to stay. A
 * translucent panel with a red header and yellow text, a faint light fan from the projector up to it, a scan line
 * running down; now and then a glitch. They block nothing and cast no shadow; they face south (the camera).
 */

interface Notice { title: string; lines: [string, string] }

const VILLAGE: Notice[] = [
  { title: "WARNUNG", lines: ["Kampfgebiet – Ortschaft geräumt", "Verbliebene Bewohner: sofort verlassen"] },
  { title: "EVAKUIERUNG", lines: ["Bewohner bitte nicht bleiben", "Sammelpunkt außerhalb der Zone"] },
  { title: "LEBENSGEFAHR", lines: ["Gefechte im Ortsbereich", "Aufenthalt nicht gestattet"] },
];
const CITY: Notice[] = [
  { title: "SPERRZONE", lines: ["Botschaftsviertel abgeriegelt", "Durchfahrt verboten"] },
  { title: "AUSGANGSSPERRE", lines: ["Bewohner: Viertel sofort räumen", "Zone wird überwacht"] },
  { title: "WARNUNG", lines: ["Drohnen- und Gefechtsbereich", "Nicht stehen bleiben"] },
];

/** Panel size (m) and the height of its lower edge. */
const W = 4.2, H = 2.35, BOTTOM = 1.7;
const TEX_W = 1024, TEX_H = 572;
const AMBER = new Color3(1, 0.8, 0.12);

/** Draws a notice: a translucent amber field with scan lines, cut corners, a red header with a warning sign, two lines. */
function drawNotice(g: CanvasRenderingContext2D, n: Notice, code: string) {
  const w = TEX_W, h = TEX_H, cut = 46, pad = 14;
  g.clearRect(0, 0, w, h);
  const shape = () => {
    g.beginPath();
    g.moveTo(pad + cut, pad);
    g.lineTo(w - pad, pad);
    g.lineTo(w - pad, h - pad - cut);
    g.lineTo(w - pad - cut, h - pad);
    g.lineTo(pad, h - pad);
    g.lineTo(pad, pad + cut);
    g.closePath();
  };
  g.save();
  shape();
  g.clip();
  g.fillStyle = "rgba(255, 196, 30, 0.16)";
  g.fillRect(0, 0, w, h);
  for (let y = 0; y < h; y += 6) {
    g.fillStyle = "rgba(255, 210, 60, 0.07)";
    g.fillRect(0, y, w, 2);
  }
  // header: red bar, warning triangle, title
  g.fillStyle = "rgba(255, 42, 68, 0.88)";
  g.fillRect(0, 0, w, 138);
  g.fillStyle = "#ffffff";
  g.beginPath();
  g.moveTo(96, 34);
  g.lineTo(140, 112);
  g.lineTo(52, 112);
  g.closePath();
  g.fill();
  g.fillStyle = "rgba(255, 42, 68, 1)";
  g.fillRect(92, 58, 8, 32);
  g.fillRect(92, 96, 8, 8);
  g.fillStyle = "#ffffff";
  g.textBaseline = "middle";
  g.font = '700 84px "Chakra Petch", "Rajdhani", sans-serif';
  g.fillText(n.title, 172, 78);
  // the two lines, shrunk to fit
  g.fillStyle = "#ffd629";
  n.lines.forEach((line, i) => {
    let size = 58;
    do {
      g.font = `700 ${size}px "Rajdhani", "Chakra Petch", sans-serif`;
    } while (g.measureText(line).width > w - 120 && --size > 30);
    g.fillText(line, 60, 222 + i * 92);
  });
  // code line and hazard stripes along the bottom
  g.fillStyle = "rgba(255, 214, 41, 0.75)";
  g.font = '600 30px "Chakra Petch", monospace';
  g.fillText(code, 60, 420);
  for (let x = -40; x < w; x += 56) {
    g.fillStyle = "rgba(255, 214, 41, 0.85)";
    g.beginPath();
    g.moveTo(x, h - pad);
    g.lineTo(x + 28, h - pad);
    g.lineTo(x + 58, h - pad - 52);
    g.lineTo(x + 30, h - pad - 52);
    g.closePath();
    g.fill();
  }
  g.restore();
  // glowing border
  g.strokeStyle = "rgba(255, 220, 60, 1)";
  g.lineWidth = 7;
  shape();
  g.stroke();
}

interface Hologram { panel: Mesh; scan: Mesh; mat: StandardMaterial; x: number; phase: number; next: number; glitch: number }

export function createHolograms(scene: Scene, layout: MapLayout, terrain: Terrain, obstacles: Obstacle[]): { update(dt: number): void } {
  const spots = layout.map === "hills" ? villageSpots(layout) : layout.map === "embassy" ? citySpots(layout) : [];
  const notices = layout.map === "hills" ? VILLAGE : CITY;
  const prefix = layout.map === "hills" ? "H" : "B";
  // keep clear of houses, props, trees, lamps, outposts and the bases; spread out
  const clear = (p: V2) => {
    if (Math.abs(p.x) > MAP_HALF - 3 || Math.abs(p.z) > MAP_HALF - 3) return false;
    // (the panel spans W along x: its ends and middle must keep off the houses)
    for (const h of layout.houses) {
      for (const dx of [-W / 2, 0, W / 2]) {
        const l = toLocal(h.x, h.z, h.rot, p.x + dx, p.z);
        if (Math.abs(l.x) < h.w / 2 + 0.8 && Math.abs(l.z) < h.d / 2 + 0.8) return false;
      }
    }
    for (const o of obstacles) {
      const l = toLocal(o.x, o.z, o.rot, p.x, p.z);
      if (Math.abs(l.x) < o.hw + 2 && Math.abs(l.z) < o.hd + 1.2) return false;
    }
    for (const t of [...layout.plantedTrees, ...layout.streetLights]) {
      if (Math.abs(t.z - p.z) < 1.6 && Math.abs(t.x - p.x) < W / 2 + 1.6) return false;
    }
    for (const o of layout.outposts) if (Math.hypot(o.x - p.x, o.z - p.z) < 16) return false;
    for (const b of [layout.playerBase, layout.enemyBase]) if (Math.hypot(b.x - p.x, b.z - p.z) < 22) return false;
    return true;
  };
  // (the city has many street corners: there they stand further apart)
  const gap = layout.map === "hills" ? 15 : 30;
  const chosen: V2[] = [];
  for (const p of spots) if (clear(p) && chosen.every((c) => Math.hypot(c.x - p.x, c.z - p.z) > gap)) chosen.push(p);
  // at most a dozen (each is a few draw calls): every n-th
  const MAX = 12, step = chosen.length / MAX;
  if (chosen.length > MAX) chosen.splice(0, chosen.length, ...Array.from({ length: MAX }, (_, i) => chosen[Math.floor(i * step)]));

  const baseMat = mat(scene, [0.12, 0.12, 0.13]);
  const ringMat = mat(scene, [AMBER.r, AMBER.g, AMBER.b], { emissive: true });
  const beamMat = new StandardMaterial("holoBeam", scene);
  beamMat.disableLighting = true;
  beamMat.emissiveColor = AMBER.scale(0.5);
  beamMat.diffuseColor = Color3.Black();
  beamMat.alpha = 0.16;
  beamMat.alphaMode = Constants.ALPHA_ADD;
  beamMat.disableDepthWrite = true;
  beamMat.backFaceCulling = false;
  const scanMat = beamMat.clone("holoScan");
  scanMat.emissiveColor = AMBER;
  scanMat.alpha = 0.35;

  const textures = new Map<number, DynamicTexture>();
  const texFor = (i: number, code: string) => {
    const tex = new DynamicTexture(`holo${i}`, { width: TEX_W, height: TEX_H }, scene, true);
    tex.hasAlpha = true;
    const draw = () => {
      drawNotice(tex.getContext() as CanvasRenderingContext2D, notices[i % notices.length], code);
      tex.update(true);
    };
    draw();
    // redraw once the menu fonts are there
    document.fonts?.load('700 84px "Chakra Petch"').then(() => document.fonts.load('700 58px "Rajdhani"')).then(draw).catch(() => {});
    textures.set(i, tex);
    return tex;
  };

  const holos: Hologram[] = chosen.map((p, i) => {
    const y = terrain.heightAt(p.x, p.z);
    // projector puck with a lit ring
    const puck = MeshBuilder.CreateCylinder("holoPuck", { height: 0.22, diameter: 0.8, tessellation: 16 }, scene);
    puck.position.set(p.x, y + 0.11, p.z);
    puck.material = baseMat;
    const ring = MeshBuilder.CreateTorus("holoRing", { diameter: 0.62, thickness: 0.05, tessellation: 20 }, scene);
    ring.position.set(p.x, y + 0.23, p.z);
    ring.material = ringMat;
    // the light fan from the projector up to the panel
    const beam = MeshBuilder.CreateCylinder("holoBeam", { height: BOTTOM - 0.25, diameterBottom: 0.3, diameterTop: W * 0.96, tessellation: 4, cap: Mesh.NO_CAP }, scene);
    beam.rotation.y = Math.PI / 4;
    beam.bakeCurrentTransformIntoVertices();
    beam.scaling.z = 0.06;
    beam.position.set(p.x, y + 0.25 + (BOTTOM - 0.25) / 2, p.z);
    beam.material = beamMat;
    // the panel: readable from both sides (the side facing away gets its UVs mirrored back)
    const panel = MeshBuilder.CreatePlane("holoPanel", { width: W, height: H, sideOrientation: Mesh.DOUBLESIDE, frontUVs: new Vector4(0, 0, 1, 1), backUVs: new Vector4(1, 0, 0, 1) }, scene);
    panel.position.set(p.x, y + BOTTOM + H / 2, p.z);
    const m = new StandardMaterial(`holoPanel${i}`, scene);
    const tex = texFor(i, `ZONE ${prefix}-${String(i + 1).padStart(2, "0")} // AUTOMATISCHE WARNANZEIGE`);
    m.emissiveTexture = tex;
    m.opacityTexture = tex;
    m.diffuseColor = Color3.Black();
    m.disableLighting = true;
    m.disableDepthWrite = true;
    panel.material = m; // (back face culling on: each side shows only its own, unmirrored face)
    const scan = MeshBuilder.CreatePlane("holoScan", { width: W * 0.98, height: 0.06, sideOrientation: Mesh.DOUBLESIDE }, scene);
    scan.position.set(p.x, y + BOTTOM + H, p.z - 0.01);
    scan.material = scanMat;
    for (const mesh of [puck, ring, beam, panel, scan]) mesh.isPickable = false;
    for (const mesh of [puck, ring, beam]) mesh.freezeWorldMatrix();
    return { panel, scan, mat: m, x: p.x, phase: i * 1.7, next: 2 + i * 1.3, glitch: 0 };
  });

  let t = 0;
  return {
    update(dt: number) {
      t += dt;
      for (const h of holos) {
        if (t > h.next) {
          h.glitch = 0.18;
          h.next = t + 3 + ((h.phase * 7.3 + t) % 6);
        }
        h.glitch = Math.max(0, h.glitch - dt);
        const flick = h.glitch > 0 ? (Math.floor(t * 40) % 2 ? 0.25 : 0.8) : 0.9 + 0.06 * Math.sin(t * 9 + h.phase);
        h.mat.alpha = flick;
        h.panel.position.x = h.x + (h.glitch > 0 ? Math.sin(t * 90) * 0.05 : 0);
        // the scan line runs down the panel
        const k = ((t + h.phase) % 2.6) / 2.6;
        h.scan.position.y = h.panel.position.y + H / 2 - k * H;
        h.scan.visibility = 1 - k * 0.6;
      }
    },
  };
}

/** Village spots (hill country): at the ends of the main street and beside the side streets, on the roadside. */
function villageSpots(layout: MapLayout): V2[] {
  const out: V2[] = [];
  for (const s of layout.suburbs) {
    for (const [lx, lz] of [[-31, 3.8], [31, -3.8], [-13, 9], [17, -9], [-23, -3.8], [24, 3.8], [-13, -15], [17, 15]]) {
      out.push(toWorld(s.x, s.z, s.rot, lx, lz));
    }
  }
  return out;
}

/** City spots (embassy district): inside the road blocks at the edge, and at street corners on the pavement. */
function citySpots(layout: MapLayout): V2[] {
  const out: V2[] = [];
  for (const b of layout.barriers) {
    const vertical = b.rot === 0; // a street running north-south, blocked at z = ±119
    const side = b.len / 2 - 1.7;
    out.push(vertical ? { x: b.x + side, z: b.z - Math.sign(b.z) * 8 } : { x: b.x - Math.sign(b.x) * 8, z: b.z + side });
  }
  const straight = layout.roads.filter((r) => r.a.x === r.b.x || r.a.z === r.b.z);
  for (const a of straight) {
    if (a.a.x !== a.b.x) continue; // a: north-south
    for (const c of straight) {
      if (c.a.z !== c.b.z) continue; // c: east-west
      const x = a.a.x, z = c.a.z;
      if (z < Math.min(a.a.z, a.b.z) || z > Math.max(a.a.z, a.b.z) || x < Math.min(c.a.x, c.b.x) || x > Math.max(c.a.x, c.b.x)) continue;
      // the corner towards the map's centre
      out.push({ x: x - Math.sign(x || 1) * (a.w / 2 + 1.8), z: z - Math.sign(z || 1) * (c.w / 2 + 1.8) });
    }
  }
  return out;
}
