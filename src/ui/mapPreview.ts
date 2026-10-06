import { MAP_HALF, OUTPOSTS } from "../config";
import { toWorld, type MapLayout, type RGB } from "../world/layout";

const css = (c: RGB, k = 1) => `rgb(${c.map((v) => Math.round(Math.min(1, v * k) * 255)).join(",")})`;

/**
 * A plan of a map for the map choice in the menu (drawn from its layout alone, no 3D world needed):
 * ground, park, fields and gardens, roads and paths, ponds, woods, houses, outposts and the two bases.
 * Returns a data URL (16:10, the map square in the middle on its surroundings).
 */
export function renderMapPreview(L: MapLayout, width = 480, height = 300): string {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const g = c.getContext("2d")!;
  const city = L.map === "embassy";
  const k = height / (MAP_HALF * 2 + 16);
  const P = (x: number, z: number): [number, number] => [width / 2 + x * k, height / 2 - z * k];
  g.fillStyle = city ? "#8b8984" : "#7c7f45";
  g.fillRect(0, 0, width, height);
  if (city) {
    g.fillStyle = "#5e7a3c";
    const [x0, y0] = P(-99, L.park), [x1, y1] = P(99, -L.park);
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
  const poly = (cx: number, cz: number, rot: number, hw: number, hd: number) => {
    g.beginPath();
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) g.lineTo(...P(toWorld(cx, cz, rot, sx * hw, sz * hd).x, toWorld(cx, cz, rot, sx * hw, sz * hd).z));
    g.closePath();
    g.fill();
  };
  for (const f of L.fields) {
    g.fillStyle = f.garden ? "#6c8c42" : css(f.base, 0.95);
    poly(f.cx, f.cz, f.rot, f.hw, f.hd);
  }
  const line = (a: { x: number; z: number }, b: { x: number; z: number }, w: number, color: string) => {
    g.strokeStyle = color;
    g.lineWidth = Math.max(1, w * k);
    g.lineCap = "round";
    g.beginPath();
    g.moveTo(...P(a.x, a.z));
    g.lineTo(...P(b.x, b.z));
    g.stroke();
  };
  for (const r of L.roads) line(r.a, r.b, r.w + (city ? 4 : 0), r.kind === "asphalt" ? (city ? "#4a4a4e" : "#55555a") : "#8a6a42");
  for (const p of L.paths) line(p.a, p.b, p.w, "#c7b98f");
  g.fillStyle = "#4f7487";
  for (const p of L.ponds) {
    g.beginPath();
    const [x, y] = P(p.x, p.z);
    g.ellipse(x, y, p.rx * k, p.rz * k, -p.rot, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = "#3e5a2a";
  for (const f of L.forests) {
    g.beginPath();
    g.arc(...P(f.x, f.z), f.r * k, 0, Math.PI * 2);
    g.fill();
  }
  for (const b of L.bushes) {
    g.beginPath();
    g.arc(...P(b.x, b.z), Math.max(0.8, b.r * k), 0, Math.PI * 2);
    g.fill();
  }
  for (const t of L.plantedTrees) {
    g.beginPath();
    g.arc(...P(t.x, t.z), 1.4, 0, Math.PI * 2);
    g.fill();
  }
  for (const h of [...L.houses, ...L.outerHouses]) {
    g.fillStyle = h.style ? "#d9d1bf" : "#d8cfbd";
    poly(h.x, h.z, h.rot, h.w / 2, h.d / 2);
    if (h.style) {
      g.strokeStyle = "rgba(60,60,64,0.5)";
      g.lineWidth = 0.6;
      g.stroke();
    }
  }
  for (const o of L.outposts) {
    g.strokeStyle = "rgba(255,255,255,0.85)";
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(...P(o.x, o.z), OUTPOSTS[o.kind].radius * k, 0, Math.PI * 2);
    g.stroke();
  }
  for (const [b, color] of [[L.playerBase, "#3a72f2"], [L.enemyBase, "#e5392d"]] as const) {
    const [x, y] = P(b.x, b.z);
    g.fillStyle = color;
    g.fillRect(x - 7, y - 5, 14, 10);
    g.strokeStyle = "#fff";
    g.lineWidth = 1.5;
    g.strokeRect(x - 7, y - 5, 14, 10);
  }
  // the edge of the map
  g.strokeStyle = "rgba(0,0,0,0.35)";
  g.lineWidth = 1;
  const [ex, ey] = P(-MAP_HALF, MAP_HALF);
  g.strokeRect(ex, ey, MAP_HALF * 2 * k, MAP_HALF * 2 * k);
  return c.toDataURL("image/png");
}
