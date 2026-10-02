# Command of Duty

2.5D-Echtzeitstrategie, gebaut mit Babylon.js, TypeScript und Vite.
Low-Poly-Optik ohne Texturen, feste RTS-Kameraperspektive.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # Produktionsbuild nach dist/
```

## Hauptmenü

Beim Laden erscheint das Hauptmenü; die Kamera fliegt langsam über die Karte, auf der im Hintergrund eine
KI-gegen-KI-Schlacht läuft – lautlos wie ein Hintergrundvideo (nur die Menümusik spielt, keine Meldungen), sie beginnt
nach einem Sieg von vorn. Die Wahl eines Modus setzt das Schlachtfeld auf die Ausgangslage zurück. „Neues Spiel“
öffnet die Modusauswahl mit drei großen Bildkacheln – **Eroberung** (Standardmodus mit Aufbau), **Gefecht** und
**Commandos** –, deren
Bilder beim Laden aus der Spielszene gerendert werden (`src/ui/modeArt.ts`): die befestigte Kaserne, ein Feuergefecht
mit Jeeps, Schützenlinie und Artilleriesalve in verschiedenen Phasen, und – bei Nacht – der Agent über die Schulter
gesehen, vor einer bewachten Stellung mit Scheinwerfer. „Steuerung“ zeigt die Tastenbelegung,
Der Regler „Musik“ stellt die Lautstärke der Musik in fünf Stufen ein (Aus, Leise, Mittel, Laut, Voll; wird gespeichert), im Spiel stellt man Musik und Effekte im Pausenmenü (Esc) ein. Nach Sieg oder Niederlage
führt „Zum Hauptmenü“ zurück (neue Karte, neues Spiel).

## Spielmodus „Gefecht“

Kein Nachschub: Beide Seiten starten mit 10 Soldaten, 5 Grenadieren, 2 Sanitätern und 3 Geländewagen (bereits mit MG-Schütze besetzt)
vor ihrer Sandsack-Stellung, die Wagen an der Spitze; Kaserne und Werkstatt produzieren nichts. Stellungen bringen wie gewohnt Bonus und
Einkommen (Start: 400 Credits). Die Credits bezahlen **Artillerieschläge** (Taste **A** oder Aktions-Kachel, 300
Credits, 25 s Abklingzeit): Ziel mit Linksklick wählen – es muss im eigenen Sichtbereich liegen –, nach gut 3 Sekunden
schlagen 7 Granaten gestreut im Radius 6 ein (Flächenschaden, auch für eigene Einheiten). Rechtsklick/Esc bricht ab.
Verloren hat, wer alle Einheiten oder seine Kaserne verliert. Die KI setzt ebenfalls Artillerie ein, aber nur auf
Ziele in der Nähe ihrer Truppen und nie nahe den eigenen Leuten. Werte: `SKIRMISH` und `ARTILLERY` in `src/config.ts`.

## Spielmodus „Commandos“

Keine eigene Basis: ein einzelner **Spezialagent**, der bei jedem Einsatz an einer anderen, zufälligen Stelle abseits von
Stellungen und Patrouillen startet (Mantel, Schirmmütze, Zielfernrohrgewehr; 60 HP, deutlich schneller als Soldaten, schießt
nur auf Befehl), hinter feindlichen Linien. Der Feind hält alle Stellungen: Wachen an jeder Stellung, Fußpatrouillen
zwischen den Stellungen und bemannte Geländewagen. Wer den Agenten entdeckt, löst Alarm aus – umliegende Truppen
rücken an. Der Agent kann Stellungen nicht einnehmen, nur sprengen. Auftrag: **6 feindliche Stellungen sprengen, in 10 Minuten**;
fällt der Agent oder läuft die Zeit ab (Uhr im Auftragsfeld, Warnung bei 1 Minute), ist die Mission gescheitert.

**Nacht:** Der Einsatz spielt bei Mondlicht. Im Dunkeln bemerkt der Feind den Agenten erst auf gut die halbe Entfernung
(×0,55), im Licht einer Straßenlaterne dagegen früher (×1,25). Die Laternen stehen in jedem Modus entlang der Dorfstraßen,
leuchten aber nur in dieser Nacht. An jeder Stellung schwenkt ein **Standscheinwerfer** seinen Lichtkegel über das Vorfeld;
gerät der (ungetarnte) Agent hinein, folgt ihm der Kegel einige Sekunden, die Truppen in der Nähe eröffnen das Feuer
bzw. rücken an. Drei zufällige Stellungen haben ein **besetztes MG-Nest** – getarnt kommt man daran vorbei.

**Sprengstoff:** Der Agent startet ohne Sprengsätze. Vier **Verstecke** mit je 3 Sprengsätzen liegen zufällig an
Waldrändern (abseits der Stellungen); sie sind auf der Minimap und im Gelände gelb markiert und werden durch Betreten geleert.

| Fähigkeit | Taste | Wirkung |
| --- | --- | --- |
| Scharfschuss | Rechtsklick auf Gegner | Standardangriff: der Agent geht bei Bedarf näher heran und schießt, sobald das Ziel in Reichweite (42) und Sicht ist – Soldat sofort ausgeschaltet, Fahrzeug nur leicht beschädigt; 6 s Nachladen. Kameraden in der Nähe des Opfers suchen die Stelle ab. |
| Tarnen | X | 10 s unsichtbar – der Feind sieht und beschießt ihn nicht (Schießen beendet die Tarnung); 22 s Abklingzeit |
| Sprengladung | C | aus den Verstecken (je 3): auf feindlichen Geländewagen oder in einer feindlichen Stellung anbringen (1,5 s), 5 s Zünder, großer Flächenschaden – rechtzeitig Abstand nehmen |

**Suche und Fährten:** Stirbt ein Gegner, durchsuchen Kameraden in Hörweite (20) sofort die Umgebung; wer später an der
Leiche vorbeikommt (9), löst die Suche ebenfalls aus. Suchende kämmen das Gebiet in wachsenden Kreisen ab (bis 24),
erkennen den Agenten schon auf 22 Einheiten und kehren nach etwa 45 s auf Posten bzw. Route zurück. Der Agent
hinterlässt Fußspuren (sichtbar im eigenen Sichtbereich, verblassen nach knapp 2 Minuten; getarnt keine Spuren).
Fußpatrouillen, die auf frische Spuren stoßen, folgen ihnen in Laufrichtung und durchsuchen am Spurende die Gegend.
Über Gegnern zeigt „?“ Suche/Fährte, „!“ dass sie den Agenten entdeckt haben.

Werte: `COMMANDOS` in `src/config.ts`, Logik in `src/game/commandos.ts`.

## Wirtschaft (Eroberung)

Credits gibt es nur über **Stellungen** auf der Karte: Feldlazarette, Unterstände, Schützengräben, Wachtürme und Werkstätten.
Eine Stellung wird eingenommen, indem mindestens ein eigener Soldat 20 Sekunden in ihrem Kreis steht, ohne dass ein
feindlicher Soldat im Bereich ist (sonst pausiert der Fortschritt). Die erste Einnahme einer Stellung bringt einmalig
+200 Credits, danach liefert sie laufendes Einkommen (1,5–3 Credits/s). Eigene Soldaten in einer eigenen,
nicht umkämpften Stellung heilen langsam (1 HP/s, im Feldlazarett 3 HP/s). Werte stehen in `src/config.ts`.

**Radarturm:** Hinter jeder Basis steht ein Radarturm (Stahlgittermast mit drehender Antenne, Funkerhütte). Die
**Minimap** gibt es nur, solange man einen Radarturm hält – sonst zeigt sie Rauschen und „Kein Radar“, und Klicks darauf
wirken nicht. In der Eroberung muss man den eigenen Turm erst einnehmen; im Gefecht startet jede Seite mit ihrem Turm
(geht er verloren, fällt die Minimap aus); im Commandos-Modus ist die Minimap immer da.

Einnahme und Verlust werden oben mittig angezeigt (in Eroberung und Gefecht): für jede Stellung, die man gerade einnimmt, ein Quadrat, das sich im
Uhrzeigersinn in Spielerfarbe füllt (über der Farbe des bisherigen Besitzers), mit Name und Prozent – es fliegt von
der Stellung aus nach oben ein und am Ende wieder zu ihr zurück (liegt sie außerhalb des Bildes, zum Rand in ihrer Richtung); nimmt der Feind eine
eigene Stellung ein, frisst sich sein Rot in das eigene Blau und das Quadrat pulsiert als Warnung. Umkämpft (angehalten)
blinkt es, am Ende zeigt es kurz „Eingenommen“ bzw. „Verloren“. Sobald der Feind beginnt, eine eigene Stellung einzunehmen, warnt der
Funk („Achtung! Der Feind nimmt die Stellung … ein“, höchstens alle 30 s pro Stellung); ihr Verlust wird ebenfalls angesagt. Eingenommene Stellungen hissen zusätzlich an drei
Masten am Rand ihres Bereichs Flaggen in der Farbe des Besitzers; beim Besitzerwechsel werden sie neu gehisst.

## Einheiten

| Einheit | Kosten | Gebaut in | Besonderheit |
| --- | --- | --- | --- |
| Soldat | 100 | Kaserne (Q) | Gewehr, kniet/liegt im Gefecht |
| Grenadier | 150 | Kaserne (W) | wirft Granaten mit Streuung; Explosion (Radius 3,2) trifft **alle** Einheiten, auch eigene |
| Geländewagen | 400 | Werkstatt (E) | schnell, gepanzert (Gewehre machen halben Schaden); Fahrer ist immer an Bord |
| Sanitäter | 150 | Feldlazarett (R) | unbewaffnet, etwas langsamer als ein Soldat; behandelt einen Verwundeten nach dem anderen |

Das **Feldlazarett** ist die linke Stellung nahe der eigenen Basis (Zelt mit rotem Kreuz, Tragen, Sanitätskisten); wer
es hält, kann dort Sanitäter ausbilden. Ein Sanitäter kniet sich neben einen verwundeten Soldaten und heilt ihn über
mehrere Sekunden (9 HP/s) – aber nur, solange der Patient nicht kämpft (3 s ohne Schuss oder Treffer) und nicht läuft.
Untätige Sanitäter kümmern sich von selbst um Verwundete in der Nähe (Radius 16), zuerst um die schwer Verletzten;
per Rechtsklick auf einen verwundeten eigenen Soldaten (Kreuz-Cursor) schickt man sie gezielt hin. Fahrzeuge
werden nicht behandelt, Sanitäter steigen nicht als Schütze auf. Wer gerade behandelt wird, zeigt ein pulsierendes
rotes Kreuz neben der Lebensleiste.

Neben jeder Basis steht eine **Werkstatt**, die wie jede andere Stellung eingenommen wird. Nur wer sie hält, kann
Geländewagen bauen. Ein Jeep schießt erst, wenn ihm ein Soldat zugewiesen wird (Soldaten auswählen, Rechtsklick auf den
eigenen Jeep): der nächststehende steigt auf und bedient das MG hinten. Das MG feuert in Stößen, auch während der Fahrt,
und ignoriert die Hälfte der Deckungs-/Haltungsboni. Der Schütze kann nicht mehr aussteigen; erst wenn der Jeep zerstört
wird, springt er ab und ist wieder ein normaler Soldat.

## Befestigungen (Eroberung)

| Bau | Kosten | Taste | Besonderheit |
| --- | --- | --- | --- |
| MG-Nest | 400 | N | Sandsackring mit MG (480 HP, Reichweite 16); schießt nur, wenn ein Soldat es besetzt (Soldat auswählen, Rechtsklick aufs Nest) |
| Poller | 50 | B | Reihe aus drei Betonpollern: Fahrzeuge kommen nicht durch, Fußtruppen laufen zwischen den Pfosten hindurch |

Kachel anklicken (oder Taste) und den Platz mit Linksklick wählen; Shift hält den Baumodus für mehrere Stück, Rechtsklick/Esc
bricht ab. Gebaut werden darf auf freiem Gelände nahe einer eigenen Stellung (bis 5 Einheiten über ihren Kreis hinaus) oder
im Umkreis von 20 um die eigene Kaserne – die erlaubten Zonen werden beim Platzieren grün umrandet. Poller werden quer zur
Stellung bzw. Basis ausgerichtet, das MG-Nest schaut nach außen. Nach dem Setzen wird kurz gebaut (Nest 6 s, Poller 2 s).
Befestigungen an einer Stellung gehören zu ihr: wird die Stellung eingenommen, gehen sie an den neuen Besitzer über.
Ein **besetztes MG-Nest verhindert die Einnahme** seiner Stellung – es muss erst zerstört werden. Gewehre richten an
Befestigungen nur halben Schaden an; Granaten, Artillerie und Sprengladungen wirken voll. Poller werden nie von selbst
angegriffen, nur auf Befehl. Die KI errichtet mit genug Credits bis zu zwei MG-Nester an ihren vordersten Stellungen und besetzt sie.

## Fog of War

Unerforschtes Gebiet ist fast schwarz, bereits gesehenes grau abgedunkelt; jenseits der Spielfläche übernimmt
das Gelände die Sicht des angrenzenden Kartenrands (leicht abgedunkelt). Nach Süden, Westen und Osten bricht das Land
in einen tiefen Graben ab (zerklüftete Kante mit Buchten, Ausläufern und Absätzen, dunstiger Grund), dessen Gegenseite
wieder als hohe Felswand zu einem bewaldeten Plateau ansteigt – so sieht man nie über das Gelände hinaus; im Norden
steigt eine Bergwand mit Schneefeldern auf; gegnerische Einheiten sind nur im aktuellen
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
Geländewagen fährt um Wälder herum. Heckenlücken und Feldseiten ohne Hecke sind natürliche Durchgänge. Wege halten
etwas Abstand zu Ecken (Abkürzungen werden mit Einheitenbreite geprüft, Felder direkt an Hindernissen kosten mehr).
Bleibt eine Einheit trotzdem hängen, plant sie höchstens zweimal pro Befehl neu – Fahrzeuge setzen dafür erst ein Stück
zurück – und bleibt danach stehen. Vor engen Kurven bremsen Fahrzeuge ab.

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

Jeder Bildschirm hat eigene Musik, beim Wechsel wird übergeblendet:

| Wo | Musik |
| --- | --- |
| Menü | 120 bpm, E-Moll: Elektro-Bass, verzerrte E-Gitarre (Powerchords, ab Takt 9 Leadmelodie), Drumcomputer, im Hintergrund marschierende Stiefel |
| Eroberung | die dramatische Kriegsmusik in D-Moll (Streicher, Pauken, Bass-Ostinato, Snare, Blech, Horn) |
| Gefecht | 70 bpm, A-Moll, getragen: Flächen, Herzschlag-Trommel, gezupfte Arpeggien, Cello-Melodie, fernes Grollen |
| Commandos | minimaler Thriller: tiefer Drone, tickender Zeitgeber, gedämpfter Puls, Herzschlag, dissonante Anschwellungen, Sonar-Pings |

Soldaten quittieren eine Auswahl mit „M-hm?“ und einen Befehl zufällig mit „Hm!“, „M-h-hm“, „Ah-hm“ oder „H-h-hm“.

## Smartphone & Tablet

Auf Touch-Geräten (automatisch erkannt) gibt es keinen Rechtsklick: **Tippen** auf eine eigene Einheit wählt aus
(zweimal tippen: alle sichtbaren gleichen Typs), **mit Auswahl tippen** ist der Befehl (Bewegen, Angreifen/Scharfschuss,
Sammelpunkt; eigener unbemannter Jeep = Schütze zuweisen; mit Sanitätern auf Verwundeten = behandeln), **ziehen** zieht einen Auswahlrahmen. Eine Touch-Leiste
bietet Pfeiltasten zum Scrollen (halten), Zoom +/−, Stopp, Abwählen und Abbrechen (Zielauswahl); die Minimap verschiebt
wie gewohnt den Ausschnitt. Auf kleinen Bildschirmen wird die Seitenleiste auf Minimap, Credits und Kacheln reduziert,
das Menü kompakt; im Hochformat erscheint ein Hinweis zum Drehen.

## Steuerung

| Eingabe | Aktion |
| --- | --- |
| Linksklick | Einheit / Kaserne auswählen, ins Leere klicken wählt ab (Shift: hinzufügen/entfernen) |
| Links ziehen | Gruppe per Rahmen auswählen |
| Doppelklick auf Soldat | alle sichtbaren eigenen Soldaten auswählen |
| Rechtsklick | Bewegen, auf Gegner: Angreifen, mit Sanitätern auf verwundeten Soldaten: behandeln, mit ausgewählter Kaserne: Sammelpunkt setzen |
| Bildschirmrand / Pfeiltasten / Steuerkreuz unten links | Karte scrollen (das Steuerkreuz gibt es jetzt auch mit Maus) |
| F / Button oben rechts | Vollbild an/aus |
| Mausrad | Zoom |
| Minimap | Links: Kamera springen, Rechts: Einheiten dorthin schicken |
| Q (Shift+Q: 5×) | Soldat ausbilden, Rechtsklick auf den Button bricht ab |
| Strg+1–9 / 1–9 | Gruppe speichern / abrufen (zweimal drücken zentriert die Kamera) |
| N · B | MG-Nest · Poller errichten (Shift: mehrere) |
| S · H | Stopp · zur Basis |
| Esc / Button „Menü“ oben links | Pause: Musik-Lautstärke, Effekte & Funk an/aus, Weiter, zurück zum Hauptmenü (mit Rückfrage); Esc bricht zuerst eine laufende Zielauswahl ab |

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
    props.ts          Umgebungsdetails: Militärcontainer an Stellungen, Wohncontainer-Lager, Garagen, Gartenzäune und parkende
                      Autos in den Dörfern, Ladewagen, Pflüge und Traktoren an Feldern (massiv, Deckung, Sichtblocker)
    dirtTracks.ts     Feldwege als durchgehende texturierte Bänder (Fahrrinnen mit Reifenprofil, grüner Mittelstreifen,
                      ausfransende Ränder; an Kreuzungen laufen einmündende Wege spitz zu, über Asphalt ausgespart),
                      Trampelpfade von jeder Stellung zum nächsten Weg und Pfützen mit angedeuteter Himmelsspiegelung
    birds.ts          Vogelschwärme, die hoch über der Karte kreisen, und einzelne Vögel, die von Baum zu Baum fliegen
    lighting.ts       Straßenlaternen, Lichtkegel/-flecken (additiv, ohne echte Lichtquellen), Standscheinwerfer
    fogRender.ts      Distanz-Dunst (Luftperspektive, zur Sonne hin wärmer, Graben im Dunst; Tag/Nacht) + Fog-of-War-Shader (Tiefenpuffer → Weltposition → Nebeltextur)
    masonry.ts        Ziegeltextur für Wände (maßstabsgetreue UVs) und Dachziegel als Thin Instances
    hedges.ts         Hecken entlang der Felder (Wege und Felder sind ins Gelände-Raster eingefärbt)
    scenery.ts        Häuser, Kirche, Bäume (Thin Instances)
    models.ts         Soldat (detailliert, Flecktarn-Uniform; Helm, Armbinden und Rucksackklappe in Spielerfarbe), Jeep, Kaserne, Stellungen, Auswahlringe, Aura, runder Bodenschatten
    environment.ts    Licht (Herbstnachmittag), Schatten, Dunst
  game/
    game.ts           Spielzustand, Auswahl, Befehle, Kampf, Separation
    unit.ts           Soldaten-Logik (Bewegen, Zielerfassung, Feuern, Sterben)
    barracks.ts       Kaserne mit Produktionsschleife und Sammelpunkt; zerstört fliegt sie in einer Explosionskette in die Luft
    nav.ts            Navigationsgitter (Infanterie- und Fahrzeugebene) + A* mit Pfadglättung
    fog.ts            Fog of War: Sichtstrahlen, Sichtblocker, erforscht/sichtbar
    cover.ts          Deckungskarte (Bäume, Hecken, Gebäude)
    commandos.ts      Commandos-Mission: Agent, Fähigkeiten, Sprengladungen, Verstecke, Patrouillen, Alarm, Scheinwerfer, Zeitlimit
    artillery.ts      Artillerieschläge (Gefecht): Salve, fallende Granaten, Zielmarkierung
    effects.ts        Granaten, Explosionen (Feuerball, Druckwelle, Trümmer mit Abprall, Funken, Staub, Rauchsäule; Flächenschaden inkl. Friendly Fire), Brandflecken
    production.ts     Bauschleife für Kaserne und Werkstatt
    views.ts          Darstellung/Animation: Soldat (Gehen, Knien, Liegen, Wurf) und Jeep (Räder, MG-Turm)
    outpost.ts        einnehmbare Stellungen (Fortschritt, Bonus, Einkommen)
    ai.ts             einfacher Gegner (produziert, nimmt Stellungen ein, greift in Wellen an)
  audio/
    audio.ts          Audio-Kontext, Schüsse, Funkmeldungen, Stummschalter
    music.ts          prozeduraler Soundtrack mit vier Themen (Menü, Eroberung, Gefecht, Commandos)
  ui/
    rtsCamera.ts      RTS-Kamera mit Zoom
    input.ts          Maus/Tastatur, Screen-Space-Picking, Rahmenauswahl
    cursors.ts        eigene Mauszeiger (Pfeil, Bewegen, Auswählen, Fadenkreuz, Einsteigen) als SVG
    overlay.ts        2D-Overlay: Lebensbalken, Mündungsfeuer, Auswahlrahmen, Sammelpunkt
    minimap.ts        Radar
    hud.ts            Seitenleiste, Meldungen, Sieg/Niederlage
    portraits.ts      rendert die Einheiten-Porträts der Bau-Kacheln und die Commandos-Fähigkeitskacheln (getarnter Agent, Sprengladung auf Jeep) aus den 3D-Modellen
```
