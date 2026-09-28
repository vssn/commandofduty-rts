# Command of Duty

2.5D-Echtzeitstrategie, gebaut mit Babylon.js, TypeScript und Vite.
Low-Poly-Optik ohne Texturen, feste RTS-Kameraperspektive.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # Produktionsbuild nach dist/
```

## Hauptmenü

Beim Laden erscheint das Hauptmenü; das Spiel ist pausiert, die Kamera fliegt langsam über die Karte. „Neues Spiel“
öffnet die Modusauswahl mit zwei großen Bildkacheln – **Eroberung** (Standardmodus mit Aufbau) und **Gefecht** –, deren
Bilder beim Laden aus der Spielszene gerendert werden (`src/ui/modeArt.ts`). „Steuerung“ zeigt die Tastenbelegung,
„Ton“ schaltet Musik und Effekte. Nach Sieg oder Niederlage
führt „Zum Hauptmenü“ zurück (neue Karte, neues Spiel).

## Spielmodus „Gefecht“

Kein Nachschub: Beide Seiten starten mit 10 Soldaten, 5 Grenadieren und 2 Geländewagen (unbemannt – Soldaten zuweisen)
vor ihrer Sandsack-Stellung, die Wagen an der Spitze; Kaserne und Werkstatt produzieren nichts. Stellungen bringen wie gewohnt Bonus und
Einkommen (Start: 400 Credits). Die Credits bezahlen **Artillerieschläge** (Taste **A** oder Aktions-Kachel, 300
Credits, 25 s Abklingzeit): Ziel mit Linksklick wählen – es muss im eigenen Sichtbereich liegen –, nach gut 3 Sekunden
schlagen 7 Granaten gestreut im Radius 6 ein (Flächenschaden, auch für eigene Einheiten). Rechtsklick/Esc bricht ab.
Verloren hat, wer alle Einheiten oder seine Kaserne verliert. Die KI setzt ebenfalls Artillerie ein, aber nur auf
Ziele in der Nähe ihrer Truppen und nie nahe den eigenen Leuten. Werte: `SKIRMISH` und `ARTILLERY` in `src/config.ts`.

## Wirtschaft (Eroberung)

Credits gibt es nur über **Stellungen** auf der Karte: Vorratsstationen, Unterstände, Schützengräben und Wachtürme.
Eine Stellung wird eingenommen, indem mindestens ein eigener Soldat 20 Sekunden in ihrem Kreis steht, ohne dass ein
feindlicher Soldat im Bereich ist (sonst pausiert der Fortschritt). Die erste Einnahme einer Stellung bringt einmalig
+200 Credits, danach liefert sie laufendes Einkommen (1,5–3 Credits/s). Eigene Soldaten in einer eigenen,
nicht umkämpften Stellung heilen langsam (1 HP/s). Werte stehen in `src/config.ts`.

## Einheiten

| Einheit | Kosten | Gebaut in | Besonderheit |
| --- | --- | --- | --- |
| Soldat | 100 | Kaserne (Q) | Gewehr, kniet/liegt im Gefecht |
| Grenadier | 150 | Kaserne (W) | wirft Granaten mit Streuung; Explosion (Radius 3,2) trifft **alle** Einheiten, auch eigene |
| Geländewagen | 400 | Werkstatt (E) | schnell, gepanzert (Gewehre machen halben Schaden); Fahrer ist immer an Bord |

Neben jeder Basis steht eine **Werkstatt**, die wie jede andere Stellung eingenommen wird. Nur wer sie hält, kann
Geländewagen bauen. Ein Jeep schießt erst, wenn ihm ein Soldat zugewiesen wird (Soldaten auswählen, Rechtsklick auf den
eigenen Jeep): der nächststehende steigt auf und bedient das MG hinten. Das MG feuert in Stößen, auch während der Fahrt,
und ignoriert die Hälfte der Deckungs-/Haltungsboni. Der Schütze kann nicht mehr aussteigen; erst wenn der Jeep zerstört
wird, springt er ab und ist wieder ein normaler Soldat.

## Fog of War

Unerforschtes Gebiet ist fast schwarz, bereits gesehenes grau abgedunkelt; gegnerische Einheiten sind nur im aktuellen
Sichtbereich zu sehen, anzuklicken und auf der Minimap. Soldaten sehen 17–18 Einheiten weit, der Geländewagen 21.
Die Sicht ist höhenabhängig: Jeder Sichtstrahl merkt sich den steilsten „Horizont“ (Hügelkamm, Baumkrone, Dachfirst)
und nur was darüber hinausragt ist sichtbar. Wer oben steht, blickt über Wälder und Dörfer ins Tal, ein Hügelkamm
verdeckt dagegen, was dahinter liegt; Einheiten auf Anhöhen sehen außerdem weiter (bis +12, „Weitsicht“ in der
Auswahl-Anzeige). Über Hecken, Felder und Sandsäcke kann man hinwegsehen. Die Kaserne (20) und
eingenommene Stellungen (13) haben ungehinderte Rundumsicht. Eigene Einheiten greifen nur Gegner an, die sie sehen.
Die Darstellung ist ein Post-Processing-Effekt, der die Weltposition jedes Pixels aus dem Tiefenpuffer rekonstruiert.

## Hindernisse

Gebäude, Bäume, Hecken und die Aufbauten der Stellungen sind massiv. Die Wegfindung (A* auf einem 1-Einheiten-Raster,
`src/game/nav.ts`) plant mit zwei Ebenen: Infanterie passt durch Lücken zwischen Bäumen und Hecken, der breitere
Geländewagen fährt um Wälder herum. Heckenlücken und Feldseiten ohne Hecke sind natürliche Durchgänge.

## Kampf

Soldaten im Feuergefecht gehen abwechselnd in die Knie oder legen sich hin (alle 4–9 s neu gewürfelt). Pro Schuss wird die
Trefferchance berechnet (Werte in `COMBAT` in `src/config.ts`):

| Faktor | Wirkung |
| --- | --- |
| Basis | 78 % |
| Schütze steht ≥ 1,5 höher als das Ziel | +10 % Treffer, bis +4 Reichweite |
| Ziel kniet / liegt | −8 % / −16 % |
| Ziel neben Bäumen, Hecke oder Gebäude | −15 % |
| Ziel steht in einer Stellung | −12 % |

Die Trefferchance sinkt nie unter 20 %. Aktive Boni ausgewählter Soldaten stehen in der Seitenleiste unter „Auswahl“.
Einheiten mit Positionsbonus (Deckung, Stellung, höher als ihr Ziel) tragen eine schwache goldene Aura, die mit der
Anzahl der Boni kräftiger wird.

**Gelände:** Bergauf werden Einheiten langsamer, leichtes Gefälle macht sie etwas schneller (`SLOPE` in
`src/config.ts`; Fahrzeuge spüren Steigungen weniger). Soldaten machen bergauf kurze, schnelle Schritte und lehnen sich
in den Hang, bergab längere Schritte mit Rücklage. Auf Straßen und Feldwegen sind Einheiten so schnell wie bergab
(+20 %, `ROAD` in `src/config.ts`); der Bonus verrechnet sich mit der Steigung.

## Audio

Alles wird zur Laufzeit erzeugt, es gibt keine Audiodateien: die Musik (Web Audio, `src/audio/music.ts`), leise
Schussgeräusche mit Entfernung und Stereo-Panorama sowie Funkmeldungen über die Sprachausgabe des Browsers.
Der Ton startet mit dem ersten Klick (Autoplay-Richtlinie der Browser). Taste **M** schaltet die Musik.

## Steuerung

| Eingabe | Aktion |
| --- | --- |
| Linksklick | Einheit / Kaserne auswählen, ins Leere klicken wählt ab (Shift: hinzufügen/entfernen) |
| Links ziehen | Gruppe per Rahmen auswählen |
| Doppelklick auf Soldat | alle sichtbaren eigenen Soldaten auswählen |
| Rechtsklick | Bewegen, auf Gegner: Angreifen, mit ausgewählter Kaserne: Sammelpunkt setzen |
| Bildschirmrand / Pfeiltasten | Karte scrollen |
| Mausrad | Zoom |
| Minimap | Links: Kamera springen, Rechts: Einheiten dorthin schicken |
| Q (Shift+Q: 5×) | Soldat ausbilden, Rechtsklick auf den Button bricht ab |
| Strg+1–9 / 1–9 | Gruppe speichern / abrufen (zweimal drücken zentriert die Kamera) |
| S · H · Esc | Stopp · zur Basis · abwählen |

## Aufbau

```
src/
  config.ts           Spielkonstanten (Kosten, Reichweite, HP, …)
  main.ts             Bootstrapping und Game Loop
  world/
    layout.ts         Kartenlayout: Basen, Vororte, Straßen, Felder, Wälder
    terrain.ts        Flat-shaded Höhenfeld; Wege, Felder, Plätze per Mehrfachabtastung in die Dreiecke gefärbt;
                      Zellen mit Kanten/Furchen werden 3×3 feiner unterteilt (gleiche Geländeform);
                      feine, kachelbare Körnungstextur über den Vertex-Farben
    crops.ts          Bewuchs der Felder (kleine, unterschiedlich hohe Büschel in Reihen)
    fortification.ts  Sandsack-Befestigung der Kaserne (Mauer, Eckbastionen, Tor, verbarrikadierte Fenster)
    fogRender.ts      Fog-of-War-Shader (Tiefenpuffer → Weltposition → Nebeltextur)
    masonry.ts        Ziegeltextur für Wände (maßstabsgetreue UVs) und Dachziegel als Thin Instances
    hedges.ts         Hecken entlang der Felder (Wege und Felder sind ins Gelände-Raster eingefärbt)
    scenery.ts        Häuser, Kirche, Bäume (Thin Instances)
    models.ts         Soldat (detailliert), Jeep, Kaserne, Stellungen, Auswahlringe, Aura, runder Bodenschatten
    environment.ts    Licht (Herbstnachmittag), Schatten, Dunst
  game/
    game.ts           Spielzustand, Auswahl, Befehle, Kampf, Separation
    unit.ts           Soldaten-Logik (Bewegen, Zielerfassung, Feuern, Sterben)
    barracks.ts       Kaserne mit Produktionsschleife und Sammelpunkt
    nav.ts            Navigationsgitter (Infanterie- und Fahrzeugebene) + A* mit Pfadglättung
    fog.ts            Fog of War: Sichtstrahlen, Sichtblocker, erforscht/sichtbar
    cover.ts          Deckungskarte (Bäume, Hecken, Gebäude)
    artillery.ts      Artillerieschläge (Gefecht): Salve, fallende Granaten, Zielmarkierung
    effects.ts        Granaten, Explosionen (Flächenschaden inkl. Friendly Fire), Rauch, Brandflecken
    production.ts     Bauschleife für Kaserne und Werkstatt
    views.ts          Darstellung/Animation: Soldat (Gehen, Knien, Liegen, Wurf) und Jeep (Räder, MG-Turm)
    outpost.ts        einnehmbare Stellungen (Fortschritt, Bonus, Einkommen)
    ai.ts             einfacher Gegner (produziert, nimmt Stellungen ein, greift in Wellen an)
  audio/
    audio.ts          Audio-Kontext, Schüsse, Funkmeldungen, Stummschalter
    music.ts          prozeduraler Soundtrack
  ui/
    rtsCamera.ts      RTS-Kamera mit Zoom
    input.ts          Maus/Tastatur, Screen-Space-Picking, Rahmenauswahl
    cursors.ts        eigene Mauszeiger (Pfeil, Bewegen, Auswählen, Fadenkreuz, Einsteigen) als SVG
    overlay.ts        2D-Overlay: Lebensbalken, Mündungsfeuer, Auswahlrahmen, Sammelpunkt
    minimap.ts        Radar
    hud.ts            Seitenleiste, Meldungen, Sieg/Niederlage
    portraits.ts      rendert die Einheiten-Porträts der Bau-Kacheln aus den 3D-Modellen
```
