import { rng } from "../util/noise";

/** Gives the browser a turn (the generation below is split into slices of a few milliseconds). */
const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0));
/** Calls it every so often inside long loops: `if (now() - t > 7) { await yieldNow(); t = now(); }`. */
const now = () => performance.now();

/** One generated texture layer: albedo, roughness (in r) and tangent-space normals (OpenGL), RGBA each. */
export interface LayerPixels { diff: Uint8ClampedArray; rough: Uint8ClampedArray; nor: Uint8ClampedArray }

/**
 * A mown lawn, generated: tens of thousands of short, thin blades in many greens over a darker
 * ground, seen from above, with a few gaps of soil and soft, broad differences in tone. The blades
 * are drawn into a height map as well, from which the normals come; tips are a little less rough.
 * The tile wraps seamlessly. `size` is the edge length in pixels (the shader maps it to about a metre).
 */
export async function lawnLayer(size: number): Promise<LayerPixels> {
  const r = rng(4242);
  const mk = () => {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    return c.getContext("2d", { willReadFrequently: true })!;
  };
  const col = mk(), hgt = mk();
  /** Draws `draw` at (x, y) and, near an edge, again on the opposite side, so the tile wraps. */
  const wrapped = (x: number, y: number, reach: number, draw: (x: number, y: number) => void) => {
    for (const ox of [-size, 0, size]) {
      if (ox && (x + ox < -reach || x + ox > size + reach)) continue;
      for (const oy of [-size, 0, size]) {
        if (oy && (y + oy < -reach || y + oy > size + reach)) continue;
        draw(x + ox, y + oy);
      }
    }
  };

  // ground between the blades: dark green-brown, low
  col.fillStyle = "rgb(52, 74, 34)";
  col.fillRect(0, 0, size, size);
  hgt.fillStyle = "rgb(40, 40, 40)";
  hgt.fillRect(0, 0, size, size);

  // broad, soft differences in tone (lusher and drier spots)
  for (let i = 0; i < 70; i++) {
    const x = r() * size, y = r() * size, rad = size * (0.08 + r() * 0.22);
    const lush = r() < 0.5;
    wrapped(x, y, rad, (px, py) => {
      const g = col.createRadialGradient(px, py, 0, px, py, rad);
      g.addColorStop(0, lush ? "rgba(40, 90, 30, 0.22)" : "rgba(150, 150, 70, 0.16)");
      g.addColorStop(1, "rgba(0, 0, 0, 0)");
      col.fillStyle = g;
      col.fillRect(px - rad, py - rad, rad * 2, rad * 2);
    });
  }

  // a few gaps where the soil shows
  for (let i = 0; i < 260; i++) {
    const x = r() * size, y = r() * size, rad = 1 + r() * 2.5;
    wrapped(x, y, rad, (px, py) => {
      col.fillStyle = "rgba(70, 55, 35, 0.8)";
      col.beginPath();
      col.arc(px, py, rad, 0, Math.PI * 2);
      col.fill();
    });
  }

  // the blades: short strokes leaning every way, lighter and higher at the tip
  const blades = Math.round((size * size) / 16);
  const greens: [number, number, number][] = [
    [46, 82, 30], [58, 98, 36], [72, 114, 42], [88, 128, 48], [104, 140, 54], [124, 152, 62], [96, 118, 50],
  ];
  col.lineCap = hgt.lineCap = "round";
  let slice = now();
  for (let i = 0; i < blades; i++) {
    if (now() - slice > 7) {
      await yieldNow();
      slice = now();
    }
    const x = r() * size, y = r() * size;
    const a = r() * Math.PI * 2;
    const len = 4 + r() * r() * 10;
    const w = 0.9 + r() * 1.3;
    const dx = Math.cos(a) * len, dy = Math.sin(a) * len;
    const [cr, cg, cb] = greens[Math.floor(r() * greens.length)];
    const k = 0.85 + r() * 0.3;
    const tip = Math.round(150 + r() * 105);
    wrapped(x, y, len + 2, (px, py) => {
      const g = col.createLinearGradient(px, py, px + dx, py + dy);
      g.addColorStop(0, `rgb(${Math.round(cr * k * 0.75)}, ${Math.round(cg * k * 0.75)}, ${Math.round(cb * k * 0.75)})`);
      g.addColorStop(1, `rgb(${Math.min(255, Math.round(cr * k * 1.15))}, ${Math.min(255, Math.round(cg * k * 1.12))}, ${Math.round(cb * k)})`);
      col.strokeStyle = g;
      col.lineWidth = w;
      col.beginPath();
      col.moveTo(px, py);
      col.lineTo(px + dx, py + dy);
      col.stroke();
      const h = hgt.createLinearGradient(px, py, px + dx, py + dy);
      h.addColorStop(0, "rgb(90, 90, 90)");
      h.addColorStop(1, `rgb(${tip}, ${tip}, ${tip})`);
      hgt.strokeStyle = h;
      hgt.lineWidth = w;
      hgt.beginPath();
      hgt.moveTo(px, py);
      hgt.lineTo(px + dx, py + dy);
      hgt.stroke();
    });
  }

  const diff = col.getImageData(0, 0, size, size).data;
  const hd = hgt.getImageData(0, 0, size, size).data;
  const h = (x: number, y: number) => hd[(((y + size) % size) * size + ((x + size) % size)) * 4] / 255;
  const nor = new Uint8ClampedArray(size * size * 4);
  const rough = new Uint8ClampedArray(size * size * 4);
  const strength = 3.2;
  let rowT = now();
  for (let y = 0; y < size; y++) {
    if (now() - rowT > 7) {
      await yieldNow();
      rowT = now();
    }
    for (let x = 0; x < size; x++) {
      const nx = (h(x - 1, y) - h(x + 1, y)) * strength;
      const ny = (h(x, y + 1) - h(x, y - 1)) * strength;
      const l = Math.hypot(nx, ny, 1);
      const o = (y * size + x) * 4;
      nor[o] = Math.round((nx / l * 0.5 + 0.5) * 255);
      nor[o + 1] = Math.round((ny / l * 0.5 + 0.5) * 255);
      nor[o + 2] = Math.round((1 / l * 0.5 + 0.5) * 255);
      nor[o + 3] = 255;
      // rough everywhere; the blades' tips a little smoother (they catch some light)
      rough[o] = Math.round(240 - h(x, y) * 60);
    }
  }
  return { diff, rough, nor };
}

/**
 * A meadow, generated: tufts of longer blades that lie combed in a slowly turning direction (as if
 * the wind had pressed them down), yellow-green where they catch the light, darker in the hollows
 * between the tufts, broad darker and lighter drifts, scattered small white and yellow flowers and
 * a few bare spots. Blades are also drawn into a height map for the normals. Wraps seamlessly;
 * the shader maps the tile to about three metres.
 */
export async function meadowLayer(size: number): Promise<LayerPixels> {
  const r = rng(777);
  const mk = () => {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    return c.getContext("2d", { willReadFrequently: true })!;
  };
  const col = mk(), hgt = mk();
  const wrapped = (x: number, y: number, reach: number, draw: (x: number, y: number) => void) => {
    for (const ox of [-size, 0, size]) {
      if (ox && (x + ox < -reach || x + ox > size + reach)) continue;
      for (const oy of [-size, 0, size]) {
        if (oy && (y + oy < -reach || y + oy > size + reach)) continue;
        draw(x + ox, y + oy);
      }
    }
  };
  const TAU = Math.PI * 2;
  /** Direction the blades lean at (x, y): turns slowly across the tile and wraps with it. */
  const flow = (x: number, y: number) => {
    const u = x / size, v = y / size;
    return 0.7 + 0.9 * Math.sin(TAU * (2 * u + 0.15)) * Math.cos(TAU * v) + 0.6 * Math.sin(TAU * (3 * v + u + 0.4));
  };

  // ground under the grass, and broad darker / lighter drifts
  col.fillStyle = "rgb(44, 64, 28)";
  col.fillRect(0, 0, size, size);
  hgt.fillStyle = "rgb(30, 30, 30)";
  hgt.fillRect(0, 0, size, size);
  for (let i = 0; i < 46; i++) {
    const x = r() * size, y = r() * size, rad = size * (0.1 + r() * 0.25);
    const dark = r() < 0.55;
    wrapped(x, y, rad, (px, py) => {
      const g = col.createRadialGradient(px, py, 0, px, py, rad);
      g.addColorStop(0, dark ? "rgba(20, 45, 15, 0.35)" : "rgba(170, 170, 80, 0.22)");
      g.addColorStop(1, "rgba(0, 0, 0, 0)");
      col.fillStyle = g;
      col.fillRect(px - rad, py - rad, rad * 2, rad * 2);
    });
  }
  // bare spots
  for (let i = 0; i < 90; i++) {
    const x = r() * size, y = r() * size, rad = 2 + r() * 5;
    wrapped(x, y, rad, (px, py) => {
      col.fillStyle = "rgba(92, 74, 46, 0.7)";
      col.beginPath();
      col.ellipse(px, py, rad * 1.4, rad, r() * 3, 0, TAU);
      col.fill();
    });
  }

  // tufts of blades, combed along the flow
  const greens: [number, number, number][] = [
    [62, 96, 34], [78, 112, 40], [96, 126, 46], [116, 140, 54], [138, 154, 64], [160, 166, 78], [104, 120, 50],
  ];
  col.lineCap = hgt.lineCap = "round";
  const tufts = Math.round((size * size) / 260);
  let slice = now();
  for (let t = 0; t < tufts; t++) {
    if (now() - slice > 7) {
      await yieldNow();
      slice = now();
    }
    const cx = r() * size, cy = r() * size;
    const base = flow(cx, cy);
    // brighter tufts stand up into the light, darker ones lie in the hollows
    const lift = r();
    const n = 5 + Math.floor(r() * 8);
    for (let i = 0; i < n; i++) {
      const a = base + (r() - 0.5) * 0.9;
      const len = 14 + r() * 34;
      const w = 1.3 + r() * 1.6;
      const x = cx + (r() - 0.5) * 8, y = cy + (r() - 0.5) * 8;
      const mx = x + Math.cos(a) * len * 0.5, my = y + Math.sin(a) * len * 0.5;
      const bend = a + (r() - 0.5) * 0.5;
      const ex = mx + Math.cos(bend) * len * 0.5, ey = my + Math.sin(bend) * len * 0.5;
      const g = greens[Math.min(greens.length - 1, Math.floor((lift * 0.6 + r() * 0.4) * greens.length))];
      const k = 0.85 + r() * 0.25;
      const c0 = `rgb(${Math.round(g[0] * k * 0.7)}, ${Math.round(g[1] * k * 0.72)}, ${Math.round(g[2] * k * 0.7)})`;
      const c1 = `rgb(${Math.min(255, Math.round(g[0] * k * 1.12))}, ${Math.min(255, Math.round(g[1] * k * 1.1))}, ${Math.round(g[2] * k)})`;
      const tip = Math.round(140 + lift * 80 + r() * 35);
      wrapped(x, y, len + 4, (px, py) => {
        const ox = px - x, oy = py - y;
        col.lineWidth = hgt.lineWidth = w;
        col.strokeStyle = c0;
        col.beginPath(); col.moveTo(px, py); col.lineTo(mx + ox, my + oy); col.stroke();
        col.lineWidth = w * 0.8;
        col.strokeStyle = c1;
        col.beginPath(); col.moveTo(mx + ox, my + oy); col.lineTo(ex + ox, ey + oy); col.stroke();
        hgt.strokeStyle = "rgb(90, 90, 90)";
        hgt.beginPath(); hgt.moveTo(px, py); hgt.lineTo(mx + ox, my + oy); hgt.stroke();
        hgt.lineWidth = w * 0.8;
        hgt.strokeStyle = `rgb(${tip}, ${tip}, ${tip})`;
        hgt.beginPath(); hgt.moveTo(mx + ox, my + oy); hgt.lineTo(ex + ox, ey + oy); hgt.stroke();
      });
    }
  }

  // small flowers in loose clusters: mostly white, some pale yellow
  for (let i = 0; i < 140; i++) {
    const cx = r() * size, cy = r() * size;
    const yellow = r() < 0.25;
    const n = 3 + Math.floor(r() * 9);
    for (let k = 0; k < n; k++) {
      const x = cx + (r() - 0.5) * 40, y = cy + (r() - 0.5) * 40, rad = 1.2 + r() * 1.3;
      wrapped(x, y, rad, (px, py) => {
        col.fillStyle = yellow ? "rgb(236, 218, 120)" : "rgb(236, 236, 224)";
        col.beginPath(); col.arc(px, py, rad, 0, TAU); col.fill();
        hgt.fillStyle = "rgb(255, 255, 255)";
        hgt.beginPath(); hgt.arc(px, py, rad, 0, TAU); hgt.fill();
      });
    }
  }

  const diff = col.getImageData(0, 0, size, size).data;
  const hd = hgt.getImageData(0, 0, size, size).data;
  const h = (x: number, y: number) => hd[(((y + size) % size) * size + ((x + size) % size)) * 4] / 255;
  const nor = new Uint8ClampedArray(size * size * 4);
  const rough = new Uint8ClampedArray(size * size * 4);
  const strength = 2.6;
  let rowT = now();
  for (let y = 0; y < size; y++) {
    if (now() - rowT > 7) {
      await yieldNow();
      rowT = now();
    }
    for (let x = 0; x < size; x++) {
      const nx = (h(x - 1, y) - h(x + 1, y)) * strength;
      const ny = (h(x, y + 1) - h(x, y - 1)) * strength;
      const l = Math.hypot(nx, ny, 1);
      const o = (y * size + x) * 4;
      nor[o] = Math.round((nx / l * 0.5 + 0.5) * 255);
      nor[o + 1] = Math.round((ny / l * 0.5 + 0.5) * 255);
      nor[o + 2] = Math.round((1 / l * 0.5 + 0.5) * 255);
      nor[o + 3] = 255;
      // blades a little glossy where they stand up into the light, the ground beneath matt
      rough[o] = Math.round(245 - h(x, y) * 75);
    }
  }
  return { diff, rough, nor };
}
