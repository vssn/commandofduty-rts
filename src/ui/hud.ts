import { PLAYER, UNITS, type UnitType } from "../config";
import type { AudioSystem } from "../audio/audio";
import type { Game, GameEvent } from "../game/game";

const MESSAGES: Partial<Record<GameEvent, string>> = {
  unitReady: "Einheit bereit",
  unitLost: "Einheit verloren",
  noCredits: "Unzureichende Mittel",
  baseAttacked: "Unsere Basis wird angegriffen!",
  unitsAttacked: "Wir werden angegriffen!",
  boarded: "MG-Schütze an Bord",
};

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

/** Sidebar: credits, build button with queue/progress, selection info, toasts and end banner. */
export class Hud {
  private readonly credits = $("credits");
  private readonly incomeEl = $("income");
  private readonly buttons: { type: UnitType; btn: HTMLButtonElement; badge: HTMLElement; count: number; p: number }[];
  private readonly info = $("selection-info");
  private readonly toastEl = $("toast");
  private readonly banner = $("banner");
  private toastTimer = 0;
  /** False while the main menu is shown (build hotkeys are ignored). */
  enabled = false;
  private last = { credits: -1, info: "", income: -1 };
  /** Credits as displayed; counts up towards the real value like a till, spending drops it at once. */
  private shownCredits: number;

  constructor(private readonly game: Game, private readonly audio: AudioSystem) {
    this.shownCredits = game.credits[PLAYER];
    const musicBtn = $("btn-music"), sfxBtn = $("btn-sfx");
    const sync = () => {
      musicBtn.classList.toggle("on", audio.musicOn);
      sfxBtn.classList.toggle("on", audio.sfxOn);
    };
    musicBtn.addEventListener("click", () => { audio.setMusic(!audio.musicOn); sync(); });
    sfxBtn.addEventListener("click", () => { audio.setSfx(!audio.sfxOn); sync(); });
    window.addEventListener("keydown", (e) => {
      if (e.key === "m" || e.key === "M") { audio.setMusic(!audio.musicOn); sync(); }
    });
    sync();

    // build buttons: left click queues (shift: 5x), right click cancels; hotkeys Q / W / E
    this.buttons = [...document.querySelectorAll<HTMLButtonElement>(".build-btn")].map((btn) => {
      const type = btn.dataset.unit as UnitType;
      btn.title = `${UNITS[type].name} · Linksklick: bauen (Shift: 5×) · Rechtsklick: abbrechen`;
      btn.addEventListener("click", (e) => this.train(type, e.shiftKey ? 5 : 1));
      btn.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        game.cancelUnit(type, PLAYER);
      });
      return { type, btn, badge: btn.querySelector<HTMLElement>(".badge")!, count: -1, p: -1 };
    });
    const hotkeys: Record<string, UnitType> = { q: "rifleman", w: "grenadier", e: "jeep" };
    window.addEventListener("keydown", (e) => {
      const type = hotkeys[e.key.toLowerCase()];
      if (type && this.enabled && !game.result && !e.ctrlKey && !e.metaKey) this.train(type, e.shiftKey ? 5 : 1);
    });
    game.on((ev, team, data) => {
      if (ev === "captured" && data) {
        if (team === PLAYER) this.toast(`${data.outpost.name} eingenommen${data.bonus ? ` · +${data.bonus} Credits` : ""}`);
        return;
      }
      if (ev === "outpostLost" && data) {
        if (team === PLAYER) this.toast(`${data.outpost.name} verloren`);
        return;
      }
      if (team !== PLAYER) return;
      if (ev === "win" || ev === "lose") this.showBanner(ev);
      else if (MESSAGES[ev]) this.toast(MESSAGES[ev]!);
    });
    // a fresh page load builds a new map state and opens the main menu again
    $("restart").addEventListener("click", () => location.reload());
  }

  private train(type: UnitType, count: number) {
    if (!this.game.producerFor(type, PLAYER)) {
      if (type === "jeep") this.toast("Zuerst eine Werkstatt einnehmen");
      return;
    }
    let queued = 0;
    for (let i = 0; i < count; i++) {
      if (!this.game.queueUnit(type, PLAYER)) break;
      queued++;
    }
    if (queued) this.audio.buildConfirm();
  }

  /** Puts the rendered unit portraits into the build buttons. */
  setPortraits(images: Record<UnitType, string>) {
    for (const b of this.buttons) b.btn.querySelector<HTMLImageElement>(".portrait")!.src = images[b.type];
  }

  toast(msg: string) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add("show");
    this.toastTimer = 2.2;
  }

  private showBanner(result: "win" | "lose") {
    $("banner-title").textContent = result === "win" ? "Sieg" : "Niederlage";
    $("banner-text").textContent = result === "win"
      ? "Die feindliche Kaserne wurde zerstört."
      : "Unsere Kaserne ist gefallen.";
    this.banner.classList.add("show", result);
  }

  update(dt: number) {
    const g = this.game;
    const real = g.credits[PLAYER];
    if (real < this.shownCredits) this.shownCredits = real;
    else this.shownCredits = Math.min(real, this.shownCredits + Math.max(60, (real - this.shownCredits) * 4) * dt);
    const credits = Math.floor(this.shownCredits);
    if (credits > this.last.credits && this.last.credits >= 0) this.audio.creditTick();
    if (credits !== this.last.credits) {
      this.credits.textContent = credits.toLocaleString("de-DE");
      this.last.credits = credits;
    }
    const income = g.incomeOf(PLAYER);
    if (income !== this.last.income) {
      this.incomeEl.textContent = income > 0 ? `+${income.toLocaleString("de-DE")}/s` : "";
      this.last.income = income;
    }
    for (const b of this.buttons) {
      const producer = g.producerFor(b.type, PLAYER);
      const count = producer?.count(b.type) ?? 0;
      if (count !== b.count) {
        b.badge.textContent = count > 0 ? String(count) : "";
        b.badge.classList.toggle("show", count > 0);
        b.count = count;
      }
      // clock wipe: fully lit when idle, sweeps clockwise while the unit is being built
      const building = !!producer && producer.queue[0] === b.type;
      const p = building ? Math.round(producer!.progressOf(b.type) * 200) / 200 : 1;
      if (p !== b.p) {
        b.btn.style.setProperty("--p", String(p));
        b.p = p;
      }
      b.btn.disabled = !producer;
      b.btn.classList.toggle("locked", !producer);
      b.btn.classList.toggle("poor", credits < UNITS[b.type].cost);
    }

    let info = "Keine Auswahl";
    if (g.selection.size) {
      const units = [...g.selection];
      const hp = (units.reduce((s, u) => s + u.hp / u.maxHp, 0) / units.length) * 100;
      const byType = (["rifleman", "grenadier", "jeep"] as UnitType[])
        .map((t) => [t, units.filter((u) => u.type === t)] as const)
        .filter(([, list]) => list.length);
      const title = byType.map(([t, list]) => `${list.length} ${list.length === 1 ? UNITS[t].name : UNITS[t].plural}`).join(", ");
      info = `<strong>${title}</strong><span>Ø Zustand ${Math.round(hp)}%</span>`;
      const jeeps = units.filter((u) => u.type === "jeep");
      if (jeeps.length) {
        const manned = jeeps.filter((j) => j.gunner).length;
        info += `<span class="hint">${manned === jeeps.length ? "MG besetzt" : manned === 0 ? "Kein MG-Schütze – Soldat zuweisen (Rechtsklick auf Jeep)" : `MG besetzt: ${manned} von ${jeeps.length}`}</span>`;
      }
      // combat bonuses: for a single soldier its own, for groups how many enjoy each one
      const counts = { cover: 0, outpost: 0, low: 0, high: 0 };
      let coverName = "";
      for (const u of units) {
        const b = g.bonusesOf(u);
        if (b.cover) { counts.cover++; coverName = b.cover; }
        if (b.outpost) counts.outpost++;
        if (b.elevated) counts.high++;
        if (b.stance !== "stand") counts.low++;
      }
      const n = (c: number) => (units.length > 1 ? ` (${c})` : "");
      const tags = [
        counts.cover ? `Deckung${units.length === 1 ? ": " + coverName : n(counts.cover)}` : "",
        counts.outpost ? `Stellung${n(counts.outpost)}` : "",
        counts.high ? `Erhöhte Position${n(counts.high)}` : "",
        counts.low ? `In Deckung gegangen${n(counts.low)}` : "",
      ].filter(Boolean);
      if (tags.length) info += `<span class="bonus">${tags.map((t) => `<em>${t}</em>`).join("")}</span>`;
    } else if (g.selectedBuilding) {
      const sb = g.selectedBuilding;
      info = `<strong>Kaserne</strong><span>Zustand ${Math.ceil(sb.hp)} / ${sb.maxHp}</span><span class="hint">Rechtsklick: Sammelpunkt setzen</span>`;
    }
    if (info !== this.last.info) {
      this.info.innerHTML = info;
      this.last.info = info;
    }

    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toastEl.classList.remove("show");
    }
  }
}
