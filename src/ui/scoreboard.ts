/**
 * The commandos mission's high-score table, shown over the closing cutscene. It is kept in the
 * browser's local storage: the ten best results, ordered by the time left on the clock (most first),
 * then by outposts blown up, drones shot down and soldiers taken out.
 */
export interface ScoreEntry { name: string; time: number; outposts: number; drones: number; soldiers: number }
export type Score = Omit<ScoreEntry, "name">;

const KEY = "cod.commandos.scores";
const MAX_ENTRIES = 10;
const MAX_NAME = 12;

/** Better results first: more time left, then more outposts, drones and soldiers. */
export function compareScores(a: Score, b: Score): number {
  return b.time - a.time || b.outposts - a.outposts || b.drones - a.drones || b.soldiers - a.soldiers;
}

export function loadScores(): ScoreEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    return raw
      .filter((e) => e && typeof e === "object")
      .map((e) => ({ name: String(e.name ?? "").slice(0, MAX_NAME), time: num(e.time), outposts: num(e.outposts), drones: num(e.drones), soldiers: num(e.soldiers) }))
      .sort(compareScores)
      .slice(0, MAX_ENTRIES);
  } catch {
    return []; // no storage, or a damaged entry: start with an empty table
  }
}

function saveScores(list: ScoreEntry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_ENTRIES)));
  } catch {
    /* storage unavailable: the table just is not kept */
  }
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export class Scoreboard {
  /** True from `show` until the player has confirmed (and the table has closed again). */
  waiting = false;
  private readonly root = document.getElementById("scoreboard")!;
  private readonly body = document.getElementById("sb-body")!;
  private readonly hint = document.getElementById("sb-hint")!;
  private readonly ok = document.getElementById("sb-ok") as HTMLButtonElement;
  private readonly input = document.getElementById("sb-input") as HTMLInputElement;
  private readonly title = document.getElementById("sb-title")!;
  private readonly kicker = document.getElementById("sb-kicker")!;
  /** The table is only being looked at (from the menu): no result, no name. */
  private viewing = false;
  private list: ScoreEntry[] = [];
  private rank = -1;
  private score: Score | null = null;
  private nameEl: HTMLElement | null = null;
  private closeTimer = 0;

  constructor() {
    this.input.addEventListener("input", () => {
      this.input.value = this.input.value.replace(/[^\p{L}\p{N} ._-]/gu, "").slice(0, MAX_NAME);
      this.paintName();
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.confirm();
      }
      e.stopPropagation(); // typing a name must not trigger the game's hotkeys
    });
    this.ok.addEventListener("click", () => (this.viewing ? this.hide() : this.confirm()));
    window.addEventListener("keydown", (e) => {
      if (this.viewing && (e.key === "Escape" || e.key === "Enter")) {
        e.stopPropagation();
        this.hide();
      }
    }, true);
    // a tap anywhere on the table brings the keyboard back
    this.root.addEventListener("pointerdown", (e) => {
      if (this.rank >= 0 && e.target !== this.ok) window.setTimeout(() => this.input.focus(), 0);
    });
  }

  /** Shows the saved table (from the main menu). */
  view() {
    window.clearTimeout(this.closeTimer);
    this.viewing = true;
    this.score = null;
    this.list = loadScores();
    this.rank = -1;
    this.waiting = false;
    this.kicker.textContent = "Commandos";
    this.title.textContent = "Highscores";
    this.hint.textContent = this.list.length ? "" : "Noch keine Einträge – spiele eine Mission zu Ende";
    this.ok.textContent = "Schließen";
    this.ok.hidden = false;
    this.render(null);
    this.root.hidden = false;
    void this.root.offsetWidth;
    this.root.classList.add("show");
  }

  /** Shows the table with this result in its place (if it makes the top ten) and asks for a name. */
  show(score: Score) {
    window.clearTimeout(this.closeTimer);
    this.viewing = false;
    this.kicker.textContent = "Auftrag erfüllt";
    this.score = score;
    this.list = loadScores();
    const better = this.list.filter((e) => compareScores(e, score) <= 0).length; // (equal results rank behind older ones)
    this.rank = better < MAX_ENTRIES ? better : -1;
    this.waiting = true;
    this.input.value = "";
    this.title.textContent = this.rank >= 0 ? `Platz ${this.rank + 1}` : "Kein Platz in der Bestenliste";
    this.hint.textContent = this.rank >= 0 ? "Namen eingeben, mit Enter bestätigen" : "Dein Ergebnis reicht nicht für die zehn Besten";
    this.ok.textContent = this.rank >= 0 ? "Bestätigen" : "Weiter";
    this.render(null);
    this.root.hidden = false;
    void this.root.offsetWidth;
    this.root.classList.add("show");
    if (this.rank >= 0) window.setTimeout(() => this.input.focus(), 50);
  }

  /** Closes the table at once (back to the menu, or a new game). */
  hide() {
    window.clearTimeout(this.closeTimer);
    this.root.classList.remove("show");
    this.root.hidden = true;
    this.waiting = false;
    this.viewing = false;
    this.ok.hidden = false;
    this.rank = -1;
    this.input.blur();
  }

  private confirm() {
    if (!this.waiting || !this.score) return;
    let saved: ScoreEntry | null = null;
    if (this.rank >= 0) {
      const name = this.input.value.trim().toUpperCase() || "AGENT";
      saved = { name, ...this.score };
      this.list.splice(this.rank, 0, saved);
      this.list = this.list.slice(0, MAX_ENTRIES);
      saveScores(this.list);
    }
    this.rank = -1;
    this.input.blur();
    this.hint.textContent = saved ? "Gespeichert" : "";
    this.render(saved);
    this.ok.hidden = true;
    // a moment to look at the saved table, then the closing scene goes on
    this.closeTimer = window.setTimeout(() => {
      this.root.classList.remove("show");
      window.setTimeout(() => {
        this.root.hidden = true;
        this.ok.hidden = false;
        this.waiting = false;
      }, 400);
    }, saved ? 1800 : 150);
  }

  private paintName() {
    if (!this.nameEl) return;
    this.nameEl.textContent = this.input.value.toUpperCase();
    const cur = document.createElement("i");
    cur.className = "sb-cur";
    this.nameEl.append(cur);
  }

  /** `saved`: the entry to highlight once it is in the table. */
  private render(saved: ScoreEntry | null) {
    const rows: (ScoreEntry | "new")[] = [...this.list];
    if (this.rank >= 0) rows.splice(this.rank, 0, "new");
    rows.length = Math.min(rows.length, MAX_ENTRIES);
    this.body.replaceChildren();
    this.nameEl = null;
    for (let i = 0; i < MAX_ENTRIES; i++) {
      const r = rows[i];
      const tr = document.createElement("tr");
      const e = r === "new" ? this.score! : r;
      const cells = [String(i + 1), "", e ? clock(e.time) : "–", e ? String(e.outposts) : "–", e ? String(e.drones) : "–", e ? String(e.soldiers) : "–"];
      cells.forEach((text, c) => {
        const td = document.createElement("td");
        td.textContent = text;
        if (c === 1) {
          td.className = "sb-name";
          if (r === "new") {
            this.nameEl = td;
            tr.className = "me";
          } else if (r) {
            td.textContent = r.name;
            if (saved && r === saved) tr.className = "me";
          } else {
            td.textContent = "–";
          }
        }
        tr.append(td);
      });
      this.body.append(tr);
    }
    if (this.nameEl) this.paintName();
  }
}
