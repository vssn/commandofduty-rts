/**
 * Military-style mouse cursors drawn as inline SVG (roughly twice the size of the system cursor).
 * Every shape is drawn twice: a dark outline underneath for contrast on bright and dark ground.
 */

const SIZE = 40;

function cursor(body: string, hx: number, hy: number, fallback: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 40 40">${body}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hx} ${hy}, ${fallback}`;
}

/** Draws `shape` (an SVG element string with a {S} stroke placeholder) as outline + colour. */
function outlined(shape: string, color: string, width: number): string {
  return shape.replace("{S}", `stroke="#10110b" stroke-width="${width + 2.5}"`) + shape.replace("{S}", `stroke="${color}" stroke-width="${width}"`);
}

const KHAKI = "#e3d49a";
const GREEN = "#7dff86";
const RED = "#ff4a3a";

/** Standard pointer: khaki arrow with a dark outline and a subtle inner highlight. */
const arrow = cursor(
  `<path d="M4 3 L4 31 L11 24.5 L16 35 L21.5 32.5 L16.5 22.5 L26 22.5 Z" fill="${KHAKI}" stroke="#10110b" stroke-width="2.2" stroke-linejoin="round"/>` +
    `<path d="M6.5 8 L6.5 25" stroke="#fff6cf" stroke-width="1.2" stroke-linecap="round" opacity="0.8"/>`,
  4, 3, "default",
);

const crossLines = (color: string, w: number) =>
  ["M20 2 L20 11", "M20 29 L20 38", "M2 20 L11 20", "M29 20 L38 20"]
    .map((d) => outlined(`<path d="${d}" {S} stroke-linecap="round"/>`, color, w))
    .join("");

/** Attack: red crosshair with a centre dot. */
const attack = cursor(
  outlined(`<circle cx="20" cy="20" r="11" fill="none" {S}/>`, RED, 2.2) +
    crossLines(RED, 2.2) +
    `<circle cx="20" cy="20" r="2.4" fill="${RED}" stroke="#10110b" stroke-width="1.2"/>`,
  20, 20, "crosshair",
);

/** Move: four green chevrons pointing at the target spot. */
const move = cursor(
  ["M14 6 L20 12 L26 6", "M14 34 L20 28 L26 34", "M6 14 L12 20 L6 26", "M34 14 L28 20 L34 26"]
    .map((d) => outlined(`<path d="${d}" fill="none" {S} stroke-linecap="round" stroke-linejoin="round"/>`, GREEN, 2.4))
    .join("") + `<circle cx="20" cy="20" r="2" fill="${GREEN}" stroke="#10110b" stroke-width="1"/>`,
  20, 20, "pointer",
);

const brackets = ["M5 13 L5 5 L13 5", "M27 5 L35 5 L35 13", "M35 27 L35 35 L27 35", "M13 35 L5 35 L5 27"]
  .map((d) => outlined(`<path d="${d}" fill="none" {S} stroke-linecap="square"/>`, GREEN, 2.4))
  .join("");

/** Select: green corner brackets (hovering an own unit). */
const select = cursor(brackets, 20, 20, "pointer");

/** Board: brackets with a plus (send the selected soldier onto this jeep). */
const board = cursor(
  brackets + outlined(`<path d="M20 13 L20 27 M13 20 L27 20" {S} stroke-linecap="round"/>`, GREEN, 2.6),
  20, 20, "copy",
);

/** Artillery targeting: large dashed impact circle with a red cross. */
const artillery = cursor(
  outlined(`<circle cx="20" cy="20" r="16" fill="none" stroke-dasharray="5 3.5" {S}/>`, RED, 2) +
    outlined(`<path d="M20 9 L20 31 M9 20 L31 20" {S} stroke-linecap="round"/>`, RED, 2.2) +
    `<circle cx="20" cy="20" r="3" fill="#ffd27a" stroke="#10110b" stroke-width="1.2"/>`,
  20, 20, "crosshair",
);

/** Demolition charge: a small bundle with a lit fuse. */
const charge = cursor(
  `<rect x="11" y="18" width="18" height="12" rx="2" fill="#8a4a2a" stroke="#10110b" stroke-width="2"/>` +
    `<path d="M11 22 H29 M11 26 H29" stroke="#5a2e18" stroke-width="1.5"/>` +
    outlined(`<path d="M24 18 Q26 11 32 8" fill="none" {S} stroke-linecap="round"/>`, KHAKI, 1.8) +
    `<circle cx="32.5" cy="7.5" r="3" fill="#ffcf4a" stroke="#ff5a2a" stroke-width="1.5"/>`,
  20, 24, "crosshair",
);

export const CURSORS = { arrow, attack, move, select, board, artillery, charge } as const;
export type CursorKind = keyof typeof CURSORS;

/** Makes the arrow the default everywhere (sidebar, buttons, minimap). */
export function installDefaultCursor() {
  const style = document.createElement("style");
  style.textContent = `html, body, button, canvas { cursor: ${arrow}; }`;
  document.head.appendChild(style);
}
