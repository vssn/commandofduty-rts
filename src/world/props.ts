import { MeshBuilder, type Mesh, type Scene, type ShadowGenerator } from "@babylonjs/core";
import { MAP_HALF } from "../config";
import type { NavGrid } from "../game/nav";
import { rng } from "../util/noise";
import { toLocal, toWorld, type MapLayout, type RGB } from "./layout";
import { mat, merge, partBuilder, type PartFn } from "./models";
import type { Terrain } from "./terrain";

/** A solid prop: blocks movement; `height` > 0 also blocks sight (fog of war) and gives cover. */
export interface Obstacle { x: number; z: number; hw: number; hd: number; rot: number; height: number }

/** Builds a hidden template from parts drawn by `draw(box, cyl)`. */
function template(scene: Scene, name: string, draw: (box: PartFn, cyl: (h: number, d: number, x: number, y: number, z: number, c: RGB, rx?: number, rz?: number) => Mesh) => void): Mesh {
  const parts: Mesh[] = [];
  const box = partBuilder(scene, parts);
  const cyl = (h: number, d: number, x: number, y: number, z: number, c: RGB, rx = 0, rz = 0) => {
    const m = MeshBuilder.CreateCylinder("cyl", { height: h, diameter: d, tessellation: 10 }, scene);
    m.position.set(x, y, z);
    m.rotation.set(rx, 0, rz);
    m.material = mat(scene, c);
    parts.push(m);
    return m;
  };
  draw(box, cyl);
  const m = merge(name, parts);
  m.isPickable = false;
  m.isVisible = false;
  m.receiveShadows = true;
  return m;
}

const DARK: RGB = [0.12, 0.12, 0.12];
const GLASS: RGB = [0.24, 0.3, 0.36];
const TYRE: RGB = [0.1, 0.1, 0.1];

/** ISO shipping container (6 x 2.4 x 2.5 m) in a military paint scheme, long side along x. */
function containerTpl(scene: Scene, color: RGB, name: string): Mesh {
  return template(scene, name, (box) => {
    const dark: RGB = [color[0] * 0.75, color[1] * 0.75, color[2] * 0.75];
    box(6, 2.5, 2.35, 0, 1.25, 0, color);
    // corrugation on the long sides and the roof
    for (let x = -2.7; x <= 2.7; x += 0.45) {
      box(0.16, 2.3, 0.06, x, 1.25, 1.19, dark);
      box(0.16, 2.3, 0.06, x, 1.25, -1.19, dark);
    }
    // doors with lock bars at one end, corner castings
    box(0.06, 2.4, 2.3, 3.02, 1.25, 0, dark);
    for (const z of [-0.75, -0.3, 0.3, 0.75]) box(0.06, 2.2, 0.05, 3.06, 1.25, z, [0.25, 0.25, 0.23]);
    for (const x of [-2.95, 2.95]) for (const z of [-1.12, 1.12]) for (const y of [0.08, 2.42]) box(0.18, 0.16, 0.18, x, y, z, DARK);
    box(1.2, 0.35, 0.02, -1.6, 1.9, 1.23, [0.85, 0.85, 0.8]); // stencilled marking
  });
}

/** Portable living cabin (Wohncontainer): light walls, windows, door, small step. */
function cabinTpl(scene: Scene): Mesh {
  return template(scene, "cabin", (box) => {
    const wall: RGB = [0.86, 0.85, 0.8];
    box(6, 2.6, 2.4, 0, 1.3, 0, wall);
    box(6.1, 0.12, 2.5, 0, 2.62, 0, [0.6, 0.6, 0.58]); // roof edge
    box(6.1, 0.12, 2.5, 0, 0.06, 0, [0.5, 0.5, 0.48]); // frame
    for (const x of [-1.8, 1.2]) box(1.0, 0.8, 0.05, x, 1.6, 1.22, GLASS);
    box(0.9, 2.0, 0.05, -0.3, 1.05, 1.22, [0.45, 0.48, 0.52]); // door
    box(1.0, 0.25, 0.6, -0.3, 0.12, 1.55, [0.5, 0.5, 0.48]); // step
    for (const x of [-1.8, 1.2]) box(1.0, 0.8, 0.05, x, 1.6, -1.22, GLASS);
  });
}

/** Small car parked at the roadside, long side along x. */
function carTpl(scene: Scene, color: RGB, name: string): Mesh {
  return template(scene, name, (box, cyl) => {
    box(3.9, 0.7, 1.7, 0, 0.62, 0, color);
    box(2.1, 0.6, 1.5, -0.2, 1.25, 0, color);
    box(2.0, 0.5, 1.52, -0.2, 1.26, 0, GLASS); // windows
    box(0.06, 0.5, 1.3, 0.86, 1.22, 0, GLASS); // windscreen
    for (const x of [-1.25, 1.25]) for (const z of [-0.8, 0.8]) cyl(0.28, 0.62, x, 0.31, z, TYRE, Math.PI / 2);
    for (const z of [-0.55, 0.55]) box(0.05, 0.14, 0.3, 1.96, 0.72, z, [0.95, 0.92, 0.75]); // headlights
  });
}

/** Single garage with a flat roof and a metal door facing +x. */
function garageTpl(scene: Scene): Mesh {
  return template(scene, "garage", (box) => {
    box(5.6, 2.5, 3.2, 0, 1.25, 0, [0.78, 0.74, 0.66]);
    box(5.9, 0.18, 3.5, 0, 2.58, 0, [0.4, 0.38, 0.36]);
    box(0.05, 2.0, 2.6, 2.82, 1.0, 0, [0.55, 0.57, 0.58]);
    for (let y = 0.2; y < 2.0; y += 0.25) box(0.06, 0.03, 2.6, 2.85, y, 0, [0.45, 0.47, 0.48]);
  });
}

/** Garden fence segment (2 m, along x): two posts and two rails. */
function fenceTpl(scene: Scene, color: RGB, name: string): Mesh {
  return template(scene, name, (box) => {
    for (const x of [-1, 1]) box(0.1, 0.85, 0.1, x, 0.42, 0, color);
    box(2.05, 0.08, 0.05, 0, 0.62, 0, color);
    box(2.05, 0.08, 0.05, 0, 0.3, 0, color);
    for (let x = -0.75; x <= 0.76; x += 0.25) box(0.06, 0.7, 0.03, x, 0.42, 0.04, color); // pickets
  });
}

/** Hay wagon: flatbed trailer on four wheels with a drawbar and a load of bales. */
function hayWagonTpl(scene: Scene): Mesh {
  return template(scene, "hayWagon", (box, cyl) => {
    const wood: RGB = [0.5, 0.36, 0.22];
    box(4.2, 0.15, 2.1, 0, 0.95, 0, wood);
    for (const z of [-1.0, 1.0]) box(4.2, 0.45, 0.08, 0, 1.25, z, wood);
    box(0.08, 0.45, 2.1, -2.1, 1.25, 0, wood);
    box(4.0, 0.1, 0.12, 0, 0.75, 0, DARK); // chassis
    for (const x of [-1.4, 1.4]) for (const z of [-0.95, 0.95]) cyl(0.25, 0.8, x, 0.4, z, TYRE, Math.PI / 2);
    box(1.6, 0.08, 0.08, 2.9, 0.6, 0, DARK); // drawbar
    const hay: RGB = [0.86, 0.74, 0.42];
    for (const [x, z, y] of [[-1.2, -0.5, 1.35], [-1.2, 0.5, 1.35], [0, -0.5, 1.35], [0, 0.5, 1.35], [1.2, 0, 1.35], [-0.6, 0, 1.85], [0.6, 0, 1.85]]) {
      box(1.1, 0.5, 0.95, x, y, z, hay);
    }
  });
}

/** Mouldboard plough: diagonal frame, three curved shares, a depth wheel and a hitch. */
function ploughTpl(scene: Scene): Mesh {
  return template(scene, "plough", (box, cyl) => {
    const steel: RGB = [0.28, 0.3, 0.32];
    const red: RGB = [0.62, 0.16, 0.12];
    box(2.8, 0.18, 0.18, 0, 0.75, 0, red, 0, 0.35);
    for (let i = -1; i <= 1; i++) {
      const s = box(0.7, 0.5, 0.06, i * 0.85, 0.35, i * -0.3 + 0.25, steel);
      s.rotation.set(0, 0.6, 0.35);
      box(0.08, 0.5, 0.08, i * 0.85, 0.6, i * -0.3, red);
    }
    cyl(0.12, 0.6, -1.4, 0.3, 0.6, TYRE, Math.PI / 2);
    box(0.9, 0.12, 0.12, 1.7, 0.7, -0.4, red, 0, 0.35); // hitch
  });
}

/** Small farm tractor: bonnet, open cab with roof, big rear and small front wheels. */
function tractorTpl(scene: Scene, color: RGB, name: string): Mesh {
  return template(scene, name, (box, cyl) => {
    box(1.8, 0.8, 0.9, 0.7, 1.05, 0, color); // bonnet
    box(0.1, 0.6, 0.8, 1.62, 1.05, 0, [0.2, 0.2, 0.2]); // grille
    box(1.1, 0.25, 1.2, -0.6, 1.0, 0, color); // floor / fenders
    for (const z of [-0.65, 0.65]) box(1.0, 0.12, 0.5, -0.6, 1.5, z * 1.2, color); // rear mudguards
    for (const [x, z] of [[-1.05, -0.55], [-1.05, 0.55], [-0.15, -0.55], [-0.15, 0.55]]) box(0.06, 1.4, 0.06, x, 2.0, z, DARK); // cab posts
    box(1.15, 0.08, 1.3, -0.6, 2.72, 0, color); // roof
    box(0.4, 0.5, 0.45, -0.75, 1.35, 0, [0.15, 0.15, 0.15]); // seat
    box(0.08, 0.7, 0.08, 1.2, 1.75, 0.25, DARK); // exhaust
    for (const z of [-0.85, 0.85]) {
      cyl(0.45, 1.5, -0.6, 0.75, z, TYRE, Math.PI / 2);
      cyl(0.3, 0.8, 1.15, 0.4, z * 0.9, TYRE, Math.PI / 2);
    }
  });
}

/**
 * Scenery details: military containers by the outposts; in the villages a cabin camp, cars at the
 * kerb, garages and garden fences; farm machinery (hay wagons, ploughs, the odd tractor) beside
 * the fields. Returns the solid ones so the caller can block movement, sight and give cover.
 */
export function createProps(scene: Scene, layout: MapLayout, terrain: Terrain, shadows: ShadowGenerator, nav: NavGrid): Obstacle[] {
  const r = rng(4242);
  const obstacles: Obstacle[] = [];
  const placed: { x: number; z: number; rad: number }[] = [];

  const inField = (x: number, z: number, m: number) =>
    layout.fields.some((f) => {
      const l = toLocal(f.cx, f.cz, f.rot, x, z);
      return Math.abs(l.x) < f.hw + m && Math.abs(l.z) < f.hd + m;
    });
  /** Free ground for a rectangle: no obstacle, road, field, outpost area or other prop. */
  const free = (x: number, z: number, hw: number, hd: number, rot: number, roadGap = 1.5) => {
    const lim = MAP_HALF - 5;
    if (Math.abs(x) > lim || Math.abs(z) > lim) return false;
    if (!nav.areaFree(x, z, hw, hd, rot, 0)) return false;
    const rad = Math.hypot(hw, hd);
    for (const [lx, lz] of [[0, 0], [hw, hd], [-hw, hd], [hw, -hd], [-hw, -hd]]) {
      const p = toWorld(x, z, rot, lx, lz);
      if (layout.nearestRoad(p.x, p.z).d < roadGap) return false;
    }
    if (inField(x, z, 1.5)) return false;
    if (layout.outposts.some((o) => Math.hypot(o.x - x, o.z - z) < 9 + rad)) return false;
    if ([layout.playerBase, layout.enemyBase].some((b) => Math.hypot(b.x - x, b.z - z) < 20 + rad)) return false;
    return !placed.some((p) => Math.hypot(p.x - x, p.z - z) < p.rad + rad + 0.6);
  };
  const instances: { tpl: Mesh; x: number; z: number; rot: number; y?: number }[] = [];
  /** Places a template instance; solid props also become obstacles. */
  const put = (tpl: Mesh, x: number, z: number, rot: number, hw: number, hd: number, height: number, solid: "all" | "infantry" = "all", y?: number) => {
    instances.push({ tpl, x, z, rot, y });
    placed.push({ x, z, rad: Math.hypot(hw, hd) });
    obstacles.push({ x, z, hw, hd, rot, height });
    if (solid === "all") nav.blockRect(x, z, hw, hd, rot, 0.15);
    // parked cars: soldiers walk round them, vehicles squeeze past (they would block the street)
    else nav.structure(x, z, hw, hd, rot, [0], 1);
  };

  // ---- military containers beside the outposts
  const containers = [
    containerTpl(scene, [0.33, 0.37, 0.22], "containerOlive"),
    containerTpl(scene, [0.58, 0.5, 0.34], "containerSand"),
    containerTpl(scene, [0.42, 0.44, 0.42], "containerGrey"),
  ];
  for (const o of layout.outposts) {
    const n = 1 + Math.floor(r() * 2);
    let done = 0;
    for (let tries = 0; tries < 30 && done < n; tries++) {
      const a = r() * Math.PI * 2, d = 9.5 + r() * 5;
      const x = o.x + Math.sin(a) * d, z = o.z + Math.cos(a) * d;
      const rot = a + Math.PI / 2 + (r() - 0.5) * 0.4; // long side roughly facing the outpost
      if (!free(x, z, 3.1, 1.3, rot)) continue;
      put(containers[Math.floor(r() * containers.length)], x, z, rot, 3.1, 1.3, 2.6);
      done++;
    }
  }

  // ---- villages: cabin camp, garages, garden fences, parked cars
  const cabin = cabinTpl(scene);
  const garage = garageTpl(scene);
  const fences = [fenceTpl(scene, [0.92, 0.9, 0.84], "fenceWhite"), fenceTpl(scene, [0.48, 0.34, 0.2], "fenceWood")];
  const cars: Mesh[] = (
    [[0.66, 0.14, 0.12], [0.2, 0.32, 0.6], [0.86, 0.82, 0.66], [0.22, 0.36, 0.24], [0.5, 0.5, 0.52], [0.62, 0.48, 0.18]] as RGB[]
  ).map((c, i) => carTpl(scene, c, `car${i}`));

  layout.suburbs.forEach((s) => {
    // a camp of living containers on open ground at the edge of the village
    for (let tries = 0; tries < 80; tries++) {
      const a = r() * Math.PI * 2, d = s.r * (0.55 + r() * 0.5);
      const cx = s.x + Math.cos(a) * d, cz = s.z + Math.sin(a) * d;
      const rot = s.rot + (r() < 0.5 ? 0 : Math.PI / 2);
      if (!free(cx - Math.cos(rot) * 1.3, cz + Math.sin(rot) * 1.3, 4.6, 3.4, rot, 2)) continue;
      // two side by side (long sides along local x), one stacked on top, one across the end
      const spots: [number, number, number, number][] = [[0, -1.3, 0, 0], [0, 1.3, 0, 0], [0, -1.3, 2.7, 0], [-4.3, 0, 0, Math.PI / 2]];
      const y0 = terrain.heightAt(cx, cz);
      for (const [lx, lz, ly, turn] of spots) {
        const p = toWorld(cx, cz, rot, lx, lz);
        instances.push({ tpl: cabin, x: p.x, z: p.z, rot: rot + turn, y: y0 + ly });
      }
      placed.push({ x: cx, z: cz, rad: 6.5 });
      obstacles.push({ x: cx, z: cz, hw: 3.05, hd: 2.55, rot, height: 5.4 });
      nav.blockRect(cx, cz, 3.05, 2.55, rot, 0.15);
      const end = toWorld(cx, cz, rot, -4.3, 0);
      obstacles.push({ x: end.x, z: end.z, hw: 1.25, hd: 3.05, rot, height: 2.7 });
      nav.blockRect(end.x, end.z, 1.25, 3.05, rot, 0.15);
      break;
    }
  });

  for (const h of layout.houses) {
    if (h.church) continue;
    // a garage beside some houses
    if (r() < 0.4) {
      // beside the house (long side along its depth) or behind it (away from the street)
      const spots: [number, number, number][] = [
        [h.w / 2 + 3.3, 0, Math.PI / 2], [-(h.w / 2 + 3.3), 0, Math.PI / 2],
        [0, h.d / 2 + 3.0, 0], [0, -(h.d / 2 + 3.0), 0],
      ];
      spots.sort((a, b) => {
        const pa = toWorld(h.x, h.z, h.rot, a[0], a[1]), pb = toWorld(h.x, h.z, h.rot, b[0], b[1]);
        return layout.nearestRoad(pb.x, pb.z).d - layout.nearestRoad(pa.x, pa.z).d;
      });
      for (const [lx, lz, turn] of spots) {
        const p = toWorld(h.x, h.z, h.rot, lx, lz);
        if (!free(p.x, p.z, 2.85, 1.65, h.rot + turn, 1)) continue;
        put(garage, p.x, p.z, h.rot + turn, 2.85, 1.65, 2.6);
        break;
      }
    }
    // a garden fence around some plots, open towards the street
    if (r() < 0.4) {
      const fence = fences[Math.floor(r() * fences.length)];
      const hw = h.w / 2 + 1.6, hd = h.d / 2 + 1.6;
      for (const [ax, az, bx, bz] of [[-hw, -hd, hw, -hd], [hw, -hd, hw, hd], [hw, hd, -hw, hd], [-hw, hd, -hw, -hd]]) {
        const len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(len / 2));
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) / n;
          const p = toWorld(h.x, h.z, h.rot, ax + (bx - ax) * t, az + (bz - az) * t);
          // leave the side facing the road open, and skip anything on a road or in an obstacle
          if (layout.nearestRoad(p.x, p.z).d < 1.2 || nav.isBlocked(p.x, p.z) || Math.abs(p.x) > MAP_HALF - 3 || Math.abs(p.z) > MAP_HALF - 3) continue;
          const segRot = h.rot - Math.atan2(bz - az, bx - ax);
          instances.push({ tpl: fence, x: p.x, z: p.z, rot: segRot });
        }
      }
    }
  }

  // parked cars along the village streets, at the kerb and parallel to it
  for (const rd of layout.roads) {
    if (rd.kind !== "asphalt") continue;
    const len = Math.hypot(rd.b.x - rd.a.x, rd.b.z - rd.a.z);
    const dx = (rd.b.x - rd.a.x) / len, dz = (rd.b.z - rd.a.z) / len;
    for (let t = 4; t < len - 4; t += 5 + r() * 9) {
      if (r() < 0.45) continue;
      const side = r() < 0.5 ? 1 : -1;
      const off = rd.w / 2 + 1.4; // on the verge, half off the road
      const x = rd.a.x + dx * t + dz * side * off, z = rd.a.z + dz * t - dx * side * off;
      const rot = Math.atan2(dz, dx) * -1 + (side > 0 ? 0 : Math.PI);
      if (layout.streetLights.some((l) => Math.hypot(l.x - x, l.z - z) < 3)) continue;
      if (!nav.areaFree(x, z, 2.0, 0.9, rot, 0) || placed.some((p) => Math.hypot(p.x - x, p.z - z) < p.rad + 2.4)) continue;
      put(cars[Math.floor(r() * cars.length)], x, z, rot, 2.0, 0.9, 1.5, "infantry");
    }
  }

  // ---- farm machinery beside the fields
  const wagon = hayWagonTpl(scene);
  const plough = ploughTpl(scene);
  const tractors = ([[0.7, 0.16, 0.1], [0.22, 0.45, 0.2], [0.2, 0.33, 0.62]] as RGB[]).map((c, i) => tractorTpl(scene, c, `tractor${i}`));
  for (const f of layout.fields) {
    if (r() < 0.35) continue;
    const kinds: ("wagon" | "plough" | "tractor")[] = [r() < 0.55 ? "wagon" : "plough"];
    if (r() < 0.25) kinds.push("tractor");
    for (const kind of kinds) {
      for (let tries = 0; tries < 25; tries++) {
        // along one of the field's edges, just outside it, lined up with the furrows
        const edge = Math.floor(r() * 4);
        const along = (r() - 0.5) * 1.6;
        const lx = edge === 0 ? f.hw + 3 : edge === 1 ? -f.hw - 3 : along * f.hw;
        const lz = edge === 2 ? f.hd + 3 : edge === 3 ? -f.hd - 3 : along * f.hd;
        const p = toWorld(f.cx, f.cz, f.rot, lx, lz);
        const rot = f.rot + (edge < 2 ? Math.PI / 2 : 0) + (r() < 0.5 ? 0 : Math.PI);
        const [hw, hd, hgt, tpl] = kind === "wagon" ? [2.6, 1.1, 2.1, wagon] : kind === "plough" ? [1.6, 0.9, 0.9, plough] : [1.7, 1.0, 2.7, tractors[Math.floor(r() * tractors.length)]];
        if (!free(p.x, p.z, hw, hd, rot, 1.5)) continue;
        put(tpl, p.x, p.z, rot, hw, hd, hgt);
        break;
      }
    }
  }

  // instances on the ground (yaw only), frozen: they never move
  for (const i of instances) {
    const m = i.tpl.createInstance(i.tpl.name);
    m.position.set(i.x, i.y ?? terrain.heightAt(i.x, i.z), i.z);
    m.rotation.y = i.rot;
    m.isPickable = false;
    m.freezeWorldMatrix();
  }
  for (const t of [...containers, cabin, garage, ...fences, ...cars, wagon, plough, ...tractors]) shadows.addShadowCaster(t);
  return obstacles;
}
