import { smoothstep } from "../util/noise";
import type { MapLayout, RGB } from "./layout";

/**
 * The hill country's classic look is a summer day: lush green grass and trees, bright yellow rapeseed fields under a
 * blue sky. Its colours are authored autumnal (olive grass, golden meadows, stubble, orange and red trees) - the
 * realistic mode keeps those; the classic one passes them through summer() and uses SUMMER_CANOPY for its trees.
 */
export function isSummer(layout: MapLayout): boolean {
  return layout.map === "hills";
}

/** Tree crowns in the classic summer look: greens from dark to a light birch green. */
export const SUMMER_CANOPY: RGB[] = [
  [0.27, 0.5, 0.16],
  [0.36, 0.58, 0.18],
  [0.22, 0.42, 0.14],
  [0.48, 0.64, 0.22],
  [0.31, 0.53, 0.2],
];

/**
 * An autumn colour turned to summer (in place, returned): olive and yellowish greens become a fresh, saturated green;
 * dark yellows (dry grass, headlands, harvested fields) green as well; light yellows (straw, stubble) a vivid rapeseed
 * yellow. Browns, greys, earth, tracks and rock stay as they are.
 */
export function summer(c: RGB): RGB {
  const r = c[0], g = c[1], b = c[2];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const v = max, s = max > 0 ? d / max : 0;
  if (s < 0.12 || d < 1e-4) return c;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  let hh = h, ss = s, vv = v;
  // olive to green: towards a fresh green
  const olive = smoothstep(46, 60, h) * (1 - smoothstep(110, 130, h));
  hh += olive * (98 - h) * 0.75;
  ss *= 1 + olive * 0.18;
  vv *= 1 - olive * 0.04;
  // yellows: light ones (straw, stubble) become rapeseed, dark ones (dry grass) green
  const yellow = smoothstep(32, 40, h) * (1 - smoothstep(48, 58, h));
  const light = smoothstep(0.72, 0.8, v);
  const toGreen = yellow * (1 - light), rape = yellow * light;
  hh += toGreen * (90 - hh) * 0.8 + rape * (50 - hh) * 0.6;
  ss *= 1 + toGreen * 0.08 + rape * 0.7;
  vv *= 1 - toGreen * 0.06 + rape * 0.06;
  ss = Math.min(1, ss);
  vv = Math.min(1, vv);
  // back to RGB
  const C = vv * ss, X = C * (1 - Math.abs(((hh / 60) % 2) - 1)), m = vv - C;
  const k = Math.floor(hh / 60) % 6;
  const [rr, gg, bb] = k === 0 ? [C, X, 0] : k === 1 ? [X, C, 0] : k === 2 ? [0, C, X] : k === 3 ? [0, X, C] : k === 4 ? [X, 0, C] : [C, 0, X];
  c[0] = rr + m;
  c[1] = gg + m;
  c[2] = bb + m;
  return c;
}
