import { ARTILLERY, COMMANDOS, ENEMY, PLAYER, UNITS, type StructureType, type UnitType } from "../config";
import type { AudioSystem } from "../audio/audio";
import type { Game, GameEvent } from "../game/game";
import type { Outpost } from "../game/outpost";
import type { InputController } from "./input";
import type { PortraitImages } from "./portraits";

const MESSAGES: Partial<Record<GameEvent, string>> = {
  unitReady: "Einheit bereit",
  unitLost: "Einheit verloren",
  noCredits: "Unzureichende Mittel",
  baseAttacked: "Unsere Basis wird angegriffen!",
  unitsAttacked: "Wir werden angegriffen!",
  boarded: "MG-Schütze an Bord",
  artillery: "Artillerie angefordert",
  enemyArtillery: "Feindlicher Artilleriebeschuss!",
  noSight: "Ziel nicht im Sichtbereich oder zu weit",
  spotted: "Entdeckt! Feind rückt an",
  outpostDestroyed: "Stellung gesprengt",
  targetEliminated: "Ziel ausgeschaltet",
  cloaked: "Tarnung aktiv",
  chargePlanted: "Ladung platziert – in Deckung!",
  notReady: "Noch nicht bereit",
  enemySearching: "Tote entdeckt – der Feind durchsucht die Umgebung",
  tracked: "Eine Patrouille folgt unserer Spur",
  built: "Bau begonnen",
  cannotBuild: "Nur auf freiem Gelände nahe eigener Stellungen oder der Basis",
  structureLost: "Befestigung zerstört",
  cacheFound: "Versteck geplündert – 3 Sprengsätze aufgenommen",
  timeWarning: "Nur noch eine Minute!",
};

const COLOR = { own: "#4d8dff", enemy: "#ef4a3c", neutral: "rgba(46, 48, 36, 0.95)" };

/** One capture/loss tile at the top of the screen. */
interface CaptureTile { el: HTMLElement; square: HTMLElement; state: HTMLElement; key: string; doneT: number }

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
  private readonly captureHud = $("capture-hud");
  private readonly captureTiles = new Map<Outpost, CaptureTile>();
  /** Screen position (client pixels) of an outpost, clamped to the view; set by main. */
  locate: ((o: Outpost) => { x: number; y: number } | null) | null = null;
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
    this.buttons = [...document.querySelectorAll<HTMLButtonElement>(".build-btn[data-unit]")].map((btn) => {
      const type = btn.dataset.unit as UnitType;
      btn.title = `${UNITS[type].name} · Linksklick: bauen (Shift: 5×) · Rechtsklick: abbrechen`;
      btn.addEventListener("click", (e) => this.train(type, e.shiftKey ? 5 : 1));
      btn.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        game.cancelUnit(type, PLAYER);
      });
      return { type, btn, badge: btn.querySelector<HTMLElement>(".badge")!, count: -1, p: -1 };
    });
    const hotkeys: Record<string, UnitType> = { q: "rifleman", w: "grenadier", e: "jeep", r: "medic" };
    window.addEventListener("keydown", (e) => {
      const type = hotkeys[e.key.toLowerCase()];
      if (type && this.enabled && !game.result && !e.ctrlKey && !e.metaKey) this.train(type, e.shiftKey ? 5 : 1);
    });
    game.on((ev, team, data) => {
      if ((ev === "captured" || ev === "outpostLost") && data && team === PLAYER) this.finishCapture(data.outpost, ev === "captured");
      if (ev === "captured" && data) {
        if (team === PLAYER) {
          const n = data.structures ?? 0;
          this.toast(`${data.outpost.name} eingenommen${data.bonus ? ` · +${data.bonus} Credits` : ""}${n ? ` · ${n} ${n === 1 ? "Befestigung" : "Befestigungen"} übernommen` : ""}`);
        }
        return;
      }
      if (ev === "outpostThreatened" && data) {
        if (team === PLAYER) this.toast(`Feind nimmt ${data.outpost.name} ein!`);
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
      if (type === "medic") this.toast("Zuerst das Feldlazarett einnehmen");
      return;
    }
    let queued = 0;
    for (let i = 0; i < count; i++) {
      if (!this.game.queueUnit(type, PLAYER)) break;
      queued++;
    }
    if (queued) this.audio.buildConfirm();
  }

  private buildTiles: { type: StructureType; btn: HTMLElement }[] = [];

  /** Conquest: tiles for MG nests and bollards start choosing a spot (N / B). */
  bindBuild(input: InputController) {
    this.buildTiles = [...document.querySelectorAll<HTMLElement>(".build-btn[data-build]")].map((btn) => {
      const type = btn.dataset.build as StructureType;
      btn.title = type === "mgnest"
        ? `MG-Nest ($${UNITS.mgnest.cost}) · nahe eigener Stellungen oder der Basis errichten (N) · ein Soldat muss es besetzen; besetzt verhindert es die Einnahme der Stellung`
        : `Poller ($${UNITS.bollard.cost}) · Sperre gegen Fahrzeuge, Fußtruppen kommen durch (B) · Shift: mehrere setzen`;
      btn.addEventListener("click", () => this.enabled && input.toggleBuild(type));
      return { type, btn };
    });
    const prev = input.onTargetingChange;
    input.onTargetingChange = () => {
      prev?.();
      for (const t of this.buildTiles) t.btn.classList.toggle("armed", input.targeting === t.type);
    };
  }

  private artilleryBtn: HTMLButtonElement | null = null;
  private artilleryP = -1;

  /** Skirmish: the artillery tile starts target selection; the tile glows while targeting. */
  bindArtillery(input: InputController) {
    const btn = $("btn-artillery") as HTMLButtonElement;
    this.artilleryBtn = btn;
    btn.title = `Artillerieschlag ($${ARTILLERY.cost}) · Ziel im Sichtbereich wählen (Taste A), Rechtsklick/Esc bricht ab`;
    btn.addEventListener("click", () => {
      if (!this.enabled) return;
      if (this.game.credits[PLAYER] < ARTILLERY.cost) {
        this.toast("Unzureichende Mittel");
        return;
      }
      input.setTargeting(input.targeting ? null : "artillery");
    });
    input.onTargetingChange = () => btn.classList.toggle("armed", !!input.targeting);
  }

  private agentTiles: { cloak: HTMLElement; charge: HTMLElement } | null = null;
  private lastMission = "";

  /** Commandos: the agent's special abilities (cloak, demolition charge); the sniper shot is his standard attack. */
  bindCommandos(input: InputController) {
    const tiles = { cloak: $("btn-cloak"), charge: $("btn-charge") };
    this.agentTiles = tiles;
    tiles.cloak.title = `Tarnen (X): ${COMMANDOS.cloak.duration} s unsichtbar für den Feind · Schießen beendet die Tarnung`;
    tiles.charge.title = "Sprengladung (C): auf feindlichen Geländewagen oder in einer feindlichen Stellung anbringen";
    tiles.cloak.addEventListener("click", () => this.enabled && this.game.commandos?.cloak());
    tiles.charge.addEventListener("click", () => this.enabled && input.setTargeting(input.targeting === "charge" ? null : "charge"));
    const prev = input.onTargetingChange;
    input.onTargetingChange = () => {
      prev?.();
      tiles.charge.classList.toggle("armed", input.targeting === "charge");
    };
  }

  private updateCommandos() {
    const m = this.game.commandos, t = this.agentTiles;
    if (!m || !t) return;
    const wipe = (el: HTMLElement, left: number, total: number, badge: string) => {
      el.style.setProperty("--p", String(total > 0 ? 1 - Math.max(0, left) / total : 1));
      el.classList.toggle("cooling", left > 0);
      const b = el.querySelector<HTMLElement>(".badge")!;
      if (b.textContent !== badge) b.textContent = badge;
      b.classList.toggle("show", badge !== "");
    };
    const cloakLeft = m.agent.cloaked ? 0 : m.cloakCooldown;
    wipe(t.cloak, cloakLeft, COMMANDOS.cloak.cooldown, m.agent.cloaked ? `${Math.ceil(m.agent.cloakT)}` : cloakLeft > 0 ? String(Math.ceil(cloakLeft)) : "");
    t.cloak.classList.toggle("armed", m.agent.cloaked);
    wipe(t.charge, m.charges > 0 ? 0 : 1, 1, String(m.charges));
    t.charge.classList.toggle("poor", m.charges <= 0);

    const pips = Array.from({ length: COMMANDOS.targets }, (_, i) => `<span class="pip${i < m.destroyedOutposts ? " done" : ""}"></span>`).join("");
    const left = Math.ceil(m.timeLeft);
    const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    const open = m.caches.filter((c) => !c.taken).length;
    const html = `<strong>Stellungen sprengen: ${m.destroyedOutposts} / ${COMMANDOS.targets}</strong><span class="pips">${pips}</span>` +
      `<span class="clock${left <= 60 ? " urgent" : ""}">Zeit: ${clock}</span>` +
      `<span>Agent: ${Math.ceil(Math.max(0, m.agent.hp))} / ${m.agent.maxHp} · Ladungen: ${m.charges}</span>` +
      `<span>${open ? `Verstecke mit Sprengstoff (Minimap): ${open}` : "Alle Verstecke geleert"}</span>` +
      `<span>Scharfschuss (Gegner anklicken/antippen): ${m.sniperCooldown > 0 ? `lädt nach … ${Math.ceil(m.sniperCooldown)} s` : "bereit"}</span>`;
    if (html !== this.lastMission) {
      $("mission-info").innerHTML = html;
      this.lastMission = html;
    }
  }

  /** Puts the rendered unit portraits into the build buttons. */
  setPortraits(images: PortraitImages) {
    for (const b of this.buttons) b.btn.querySelector<HTMLImageElement>(".portrait")!.src = images[b.type];
    for (const t of this.buildTiles) t.btn.querySelector<HTMLImageElement>(".portrait")!.src = images[t.type];
    // commandos abilities: rendered art replaces the drawn fallback icons
    for (const id of ["cloak", "charge"] as const) {
      const btn = $(`btn-${id}`);
      const old = btn.querySelector(".portrait")!;
      const img = document.createElement("img");
      img.className = "portrait";
      img.alt = "";
      img.draggable = false;
      img.src = images[id];
      old.replaceWith(img);
    }
  }

  toast(msg: string) {
    if (!this.enabled) return; // the menu's background battle stays silent
    this.toastEl.textContent = msg;
    this.toastEl.classList.add("show");
    this.toastTimer = 2.2;
  }

  private showBanner(result: "win" | "lose") {
    if (!this.enabled) return; // the background battle behind the menu just restarts
    $("banner-title").textContent = result === "win" ? "Sieg" : "Niederlage";
    const mode = this.game.mode;
    const texts = {
      base: ["Die feindliche Kaserne wurde zerstört.", "Unsere Kaserne ist gefallen."],
      skirmish: ["Der Feind wurde aufgerieben.", "Unsere Truppen wurden aufgerieben."],
      commandos: ["Auftrag erfüllt – die Stellungen liegen in Trümmern.", "Der Agent ist gefallen. Auftrag gescheitert."],
    };
    $("banner-text").textContent = mode === "commandos" && result === "lose" && this.game.commandos?.timeUp
      ? "Die Zeit ist abgelaufen. Auftrag gescheitert."
      : texts[mode][result === "win" ? 0 : 1];
    this.banner.classList.add("show", result);
  }

  /** Tile for an outpost, created on demand. */
  private captureTile(o: Outpost): CaptureTile {
    let tile = this.captureTiles.get(o);
    if (!tile) {
      const el = document.createElement("div");
      el.className = "cap";
      el.innerHTML = `<div class="cap-square"></div><div class="cap-name"></div><div class="cap-state"></div>`;
      el.querySelector(".cap-name")!.textContent = o.name;
      this.captureHud.appendChild(el);
      tile = { el, square: el.querySelector(".cap-square")!, state: el.querySelector(".cap-state")!, key: "", doneT: 0 };
      this.captureTiles.set(o, tile);
      this.flyIn(o, el);
    }
    return tile;
  }

  /** Offset from a tile's centre to its outpost on screen (null if the outpost can't be located). */
  private flight(o: Outpost, el: HTMLElement): string | null {
    const p = this.locate?.(o);
    if (!p) return null;
    const r = el.getBoundingClientRect();
    return `translate(${Math.round(p.x - (r.left + r.width / 2))}px, ${Math.round(p.y - (r.top + r.height / 2))}px) scale(0.2)`;
  }

  /** The tile flies up from its outpost into place. */
  private flyIn(o: Outpost, el: HTMLElement) {
    const from = this.flight(o, el) ?? "translateY(-8px) scale(0.9)";
    el.animate(
      [{ transform: from, opacity: 0 }, { transform: from, opacity: 1, offset: 0.12 }, { transform: "none", opacity: 1 }],
      { duration: 650, easing: "cubic-bezier(0.2, 0.75, 0.25, 1)" },
    );
  }

  /** The tile flies back down to its outpost and vanishes there. */
  private flyOut(o: Outpost, el: HTMLElement) {
    const to = this.flight(o, el) ?? "translateY(-8px) scale(0.9)";
    const anim = el.animate(
      [{ transform: "none", opacity: 1 }, { transform: to, opacity: 1, offset: 0.85 }, { transform: to, opacity: 0 }],
      { duration: 600, easing: "cubic-bezier(0.55, 0, 0.8, 0.4)", fill: "forwards" },
    );
    anim.onfinish = () => el.remove();
  }

  /** Taken or lost: the tile shows the full square in the new owner's colour for a moment. */
  private finishCapture(o: Outpost, won: boolean) {
    if (!this.enabled) return;
    if (this.game.mode === "commandos") return; // the agent blows outposts up instead
    const tile = this.captureTile(o);
    tile.doneT = 2.2;
    const a = won ? COLOR.own : COLOR.enemy;
    tile.el.className = "cap show done";
    tile.square.style.setProperty("--a", a);
    tile.square.style.setProperty("--b", a);
    tile.square.style.setProperty("--p", "100");
    tile.square.dataset.pct = won ? "✓" : "✕";
    tile.state.textContent = won ? "Eingenommen" : "Verloren";
    tile.state.style.color = won ? COLOR.own : COLOR.enemy;
    tile.key = "done";
  }

  /**
   * Conquest and skirmish: while the player takes an outpost, his colour fills the tile clockwise (over the
   * previous owner's colour); while the enemy takes one of ours, red eats into our blue.
   */
  private updateCaptures(dt: number) {
    const g = this.game;
    const live = new Set<Outpost>();
    if (g.mode !== "commandos") {
      for (const o of g.outposts) {
        if (o.destroyed || o.progress <= 0 || o.capturer === null) continue;
        const gain = o.capturer === PLAYER;
        const loss = o.capturer === ENEMY && o.owner === PLAYER;
        if (!gain && !loss) continue;
        live.add(o);
        const tile = this.captureTile(o);
        if (tile.doneT > 0) continue;
        const a = gain ? COLOR.own : COLOR.enemy;
        const b = o.owner === null ? COLOR.neutral : o.owner === PLAYER ? COLOR.own : COLOR.enemy;
        const pct = Math.floor(o.progress * 100);
        const state = o.contested ? "Umkämpft" : gain ? "Einnahme" : "Feind nimmt ein!";
        const key = `${a}${b}${pct}${state}`;
        if (key === tile.key) continue;
        tile.key = key;
        tile.el.className = `cap show ${gain ? "gain" : "loss"}${o.contested ? " paused" : ""}`;
        tile.square.style.setProperty("--a", a);
        tile.square.style.setProperty("--b", b);
        tile.square.style.setProperty("--p", String(o.progress * 100));
        tile.square.dataset.pct = `${pct}%`;
        tile.state.textContent = state;
        tile.state.style.color = "";
      }
    }
    for (const [o, tile] of this.captureTiles) {
      if (tile.doneT > 0) {
        tile.doneT -= dt;
        if (tile.doneT > 0) continue;
      }
      if (live.has(o)) continue;
      // no longer being taken (finished, abandoned or progress faded): fade out and remove
      this.captureTiles.delete(o);
      this.flyOut(o, tile.el);
    }
  }

  update(dt: number) {
    const g = this.game;
    this.updateCaptures(dt);
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

    for (const t of this.buildTiles) t.btn.classList.toggle("poor", credits < UNITS[t.type].cost);

    if (this.artilleryBtn && g.mode === "skirmish") {
      // cooldown as clock wipe, remaining seconds in the badge
      const cd = g.artillery.cooldownOf(PLAYER);
      const p = Math.round((1 - cd / ARTILLERY.cooldown) * 200) / 200;
      if (p !== this.artilleryP) {
        this.artilleryBtn.style.setProperty("--p", String(p));
        this.artilleryP = p;
        const badge = this.artilleryBtn.querySelector<HTMLElement>(".badge")!;
        badge.textContent = cd > 0 ? String(Math.ceil(cd)) : "";
        badge.classList.toggle("show", cd > 0);
      }
      this.artilleryBtn.classList.toggle("cooling", cd > 0);
      this.artilleryBtn.classList.toggle("poor", credits < ARTILLERY.cost);
    }

    this.updateCommandos();

    let info = "Keine Auswahl";
    if (g.selection.size) {
      const units = [...g.selection];
      const hp = (units.reduce((s, u) => s + u.hp / u.maxHp, 0) / units.length) * 100;
      const byType = (["agent", "rifleman", "grenadier", "medic", "jeep", "mgnest", "bollard"] as UnitType[])
        .map((t) => [t, units.filter((u) => u.type === t)] as const)
        .filter(([, list]) => list.length);
      const title = byType.map(([t, list]) => `${list.length} ${list.length === 1 ? UNITS[t].name : UNITS[t].plural}`).join(", ");
      info = `<strong>${title}</strong><span>Ø Zustand ${Math.round(hp)}%</span>`;
      const building = units.find((u) => u.buildT > 0);
      if (building) info += `<span class="hint">Im Bau: ${Math.round((1 - building.buildT / building.stats.buildTime) * 100)}%</span>`;
      const jeeps = units.filter((u) => u.hasMg && u.buildT <= 0);
      if (jeeps.length) {
        const manned = jeeps.filter((j) => j.gunner).length;
        const what = jeeps[0].type === "mgnest" ? "MG-Nest" : "Jeep";
        info += `<span class="hint">${manned === jeeps.length ? "MG besetzt" : manned === 0 ? `Kein MG-Schütze – Soldat zuweisen (Rechtsklick auf ${what})` : `MG besetzt: ${manned} von ${jeeps.length}`}</span>`;
      }
      const post = units.length === 1 ? units[0].anchor : null;
      if (post) info += `<span class="hint">Gehört zu: ${post.name}</span>`;
      const medics = units.filter((u) => u.type === "medic");
      if (medics.length) {
        const busy = medics.filter((m) => m.healing).length;
        info += `<span class="hint">${busy ? `Behandelt gerade: ${busy}` : "Rechtsklick auf verwundeten Soldaten: behandeln"}</span>`;
      }
      // combat bonuses: for a single soldier its own, for groups how many enjoy each one
      const counts = { cover: 0, outpost: 0, low: 0, high: 0, far: 0 };
      let farBest = 0;
      let coverName = "";
      for (const u of units) {
        const b = g.bonusesOf(u);
        if (b.cover) { counts.cover++; coverName = b.cover; }
        if (b.outpost) counts.outpost++;
        if (b.elevated) counts.high++;
        const far = g.sightBonusOf?.(u) ?? 0;
        if (far >= 2) { counts.far++; farBest = Math.max(farBest, far); }
        if (b.stance !== "stand") counts.low++;
      }
      const n = (c: number) => (units.length > 1 ? ` (${c})` : "");
      const tags = [
        counts.cover ? `Deckung${units.length === 1 ? ": " + coverName : n(counts.cover)}` : "",
        counts.outpost ? `Stellung${n(counts.outpost)}` : "",
        counts.high ? `Erhöhte Position${n(counts.high)}` : "",
        counts.far ? `Weitsicht +${Math.round(farBest)}${n(counts.far)}` : "",
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
