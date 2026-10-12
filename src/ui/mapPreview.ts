import { MAP_HALF, OUTPOSTS } from "../config";
import { toWorld, type MapLayout, type RGB } from "../world/layout";
import { alongNorth, inWater } from "../world/power";

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
  const PL = L.plant;
  const P2 = P;
  /** A rotated rectangle (as the layout's boxes). */
  const box = (b: { x: number; z: number; hw: number; hd: number; rot: number }, color: string) => {
    g.fillStyle = color;
    g.beginPath();
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) g.lineTo(...P2(toWorld(b.x, b.z, b.rot, sx * b.hw, sz * b.hd).x, toWorld(b.x, b.z, b.rot, sx * b.hw, sz * b.hd).z));
    g.closePath();
    g.fill();
  };
  if (PL) {
    // the power station: water beyond the slanted quays, the paved compound, the yards
    const img = g.getImageData(0, 0, width, height);
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const x = (px - width / 2) / k, z = (height / 2 - py) / k;
        if (!inWater(PL, x, z)) continue;
        const i = (px + py * width) * 4;
        img.data[i] = 0x4f; img.data[i + 1] = 0x74; img.data[i + 2] = 0x87;
      }
    }
    g.putImageData(img, 0, 0);
    const c = PL.compound;
    box({ x: toWorld(PL.centre.x, PL.centre.z, PL.rot, (c.x0 + c.x1) / 2, (c.z0 + c.z1) / 2).x, z: toWorld(PL.centre.x, PL.centre.z, PL.rot, (c.x0 + c.x1) / 2, (c.z0 + c.z1) / 2).z, hw: (c.x1 - c.x0) / 2, hd: (c.z1 - c.z0) / 2, rot: PL.rot }, "#55565a");
    box(PL.transformer, "#94908a");
  }
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
  if (PL) {
    // walkways and stairs (light concrete, the stairs a little darker), the hall, the cooling tower and chimney, the trains
    for (const d of PL.decks) box(d, "#c9c5bb");
    for (const s of PL.stairs) box(s, "#a7a399");
    box(PL.hall, "#7d8a92");
    g.fillStyle = "#bdbab2";
    g.beginPath();
    g.arc(...P2(PL.tower.x, PL.tower.z), PL.tower.r * k, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#a33";
    g.beginPath();
    g.arc(...P2(PL.chimney.x, PL.chimney.z), Math.max(1.5, PL.chimney.r * k), 0, Math.PI * 2);
    g.fill();
    const rot = Math.atan2(-PL.quays.north.d.z, PL.quays.north.d.x);
    for (const w of PL.wagons) box({ ...alongNorth(PL, w.x, PL.tracks.offsets[w.track]), hw: 6, hd: 1.5, rot }, "#2a2420");
    for (const pl of PL.pipes) for (let i = 0; i < pl.length - 1; i++) line(pl[i], pl[i + 1], 1.2, "#6b8a6b");
    line(PL.conveyor.a, PL.conveyor.b, 1.4, "#8a8d92");
    box(PL.bunker, "#55585d");
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
