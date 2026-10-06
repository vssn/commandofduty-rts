/**
 * The commandos mission's high-score table, shown over the closing cutscene. It is kept in the
 * browser's local storage: the ten best results, ordered by the time left on the clock (most first),
 * then by outposts blown up, drones shot down and soldiers taken out.
 */
export interface ScoreEntry { name: string; time: number; outposts: number; drones: number; soldiers: number }
export type Score = Omit<ScoreEntry, "name">;

/** The two missions keep their own tables: outposts blown up (hill country) and documents fetched (city). */
export type ScoreKind = "sabotage" | "documents";
const KEYS: Record<ScoreKind, string> = { sabotage: "cod.commandos.scores", documents: "cod.commandos.embassy.scores" };
const KICKERS: Record<ScoreKind, string> = { sabotage: "Hügelland", documents: "Botschaftsquartier" };
/** What the table's fourth column counts. */
const COLUMN: Record<ScoreKind, string> = { sabotage: "Stellungen", documents: "Befreite" };
const MAX_ENTRIES = 10;
const MAX_NAME = 12;

/** Better results first: more time left, then more outposts, drones and soldiers. */
export function compareScores(a: Score, b: Score): number {
  return b.time - a.time || b.outposts - a.outposts || b.drones - a.drones || b.soldiers - a.soldiers;
}

export function loadScores(kind: ScoreKind = "sabotage"): ScoreEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEYS[kind]) ?? "[]");
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

function saveScores(kind: ScoreKind, list: ScoreEntry[]) {
  try {
    localStorage.setItem(KEYS[kind], JSON.stringify(list.slice(0, MAX_ENTRIES)));
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
  /** Which mission's table is shown. */
  private kind: ScoreKind = "sabotage";
  private readonly switchBtn = document.getElementById("sb-switch") as HTMLButtonElement;
  private readonly outCol = document.getElementById("sb-col-out")!;
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
    // (only when looking at the table from the menu) the other mission's table
    this.switchBtn.addEventListener("click", () => this.view(this.kind === "sabotage" ? "documents" : "sabotage"));
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

  /** Shows the saved table of a mission (from the main menu). */
  view(kind: ScoreKind = this.kind) {
    this.kind = kind;
    this.outCol.textContent = COLUMN[kind];
    this.switchBtn.hidden = false;
    this.switchBtn.textContent = `${KICKERS[kind === "sabotage" ? "documents" : "sabotage"]} ›`;
    window.clearTimeout(this.closeTimer);
    this.viewing = true;
    this.score = null;
    this.list = loadScores(kind);
    this.rank = -1;
    this.waiting = false;
    this.kicker.textContent = `Commandos · ${KICKERS[kind]}`;
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
  show(score: Score, kind: ScoreKind = "sabotage") {
    window.clearTimeout(this.closeTimer);
    this.viewing = false;
    this.kind = kind;
    this.outCol.textContent = COLUMN[kind];
    this.switchBtn.hidden = true;
    this.kicker.textContent = `Auftrag erfüllt · ${KICKERS[kind]}`;
    this.score = score;
    this.list = loadScores(kind);
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
      saveScores(this.kind, this.list);
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
