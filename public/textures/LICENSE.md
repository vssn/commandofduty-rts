# Texturen – Herkunft und Lizenz

Alle Texturen in diesem Ordner stammen von **Poly Haven** (https://polyhaven.com) und stehen unter der
**Creative Commons CC0 1.0 Universal** (Public Domain Dedication):
https://creativecommons.org/publicdomain/zero/1.0/ · Lizenzseite von Poly Haven: https://polyhaven.com/license

CC0 bedeutet: Die Urheber haben, soweit gesetzlich möglich, auf alle Rechte verzichtet. Die Texturen dürfen
ohne Namensnennung und ohne Einschränkung verwendet, verändert und weitergegeben werden, auch kommerziell.
Eine Namensnennung ist nicht erforderlich; wir nennen die Urheber trotzdem gern. CC0 gewährt keine
Gewährleistung, und Rechte Dritter (z. B. Marken, Persönlichkeitsrechte) werden durch CC0 nicht berührt –
bei reinen Boden- und Materialtexturen spielt das keine Rolle.

Abgerufen am 3. Oktober 2026 (terrain/ und props/). Verwendet werden die Karten Diffuse (`_diff`), Normal im OpenGL-Format (`_nor_gl`)
und Rauheit (`_rough`) in 1K-Auflösung.

**Änderungen:** JPEG-Qualität neu komprimiert (Diffuse/Rauheit 82 %, Normal 88 %), Rauheits-Karten auf
512 × 512 Pixel verkleinert. Im Spiel werden die Karten zur Laufzeit zu Textur-Arrays zusammengefasst.

## terrain/ – Gelände (Grafikmodus „Realistisch“)

| Datei-Präfix | Asset | Urheber | Quelle | Verwendung |
|---|---|---|---|---|
| `leafy_grass` | Leafy Grass | Charlotte Baglioni | https://polyhaven.com/a/leafy_grass | Wiese |
| `brown_mud_dry` | Brown Mud Dry | Rob Tuytel | https://polyhaven.com/a/brown_mud_dry | Erde, Feldwege, Ränder |
| `dry_mud_field_001` | Dry Mud Field 001 | Rob Tuytel, Rico Cilliers | https://polyhaven.com/a/dry_mud_field_001 | Äcker |
| `asphalt_02` | Asphalt 02 | Rob Tuytel | https://polyhaven.com/a/asphalt_02 | Asphaltstraßen |
| `gravel_concrete` | Gravel Concrete | Dario Barresi, Charlotte Baglioni | https://polyhaven.com/a/gravel_concrete | Kasernenplatz, Bordsteine |
| `rock_face_03` | Rock Face 03 | Dario Barresi, Rico Cilliers | https://polyhaven.com/a/rock_face_03 | Hänge, Schlucht, Berg |

## props/ – Stellungen und Container (Grafikmodus „Realistisch“)

| Datei-Präfix | Asset | Urheber | Quelle | Verwendung |
|---|---|---|---|---|
| `weathered_planks` | Weathered Planks | Dario Barresi, Dimitrios Savva | https://polyhaven.com/a/weathered_planks | Holz: Wachtürme, Kisten, Rundhölzer |
| `hessian_230` | Hessian 230 | colormass, Rico Cilliers | https://polyhaven.com/a/hessian_230 | Sandsäcke, Zeltplane, Tragen |
| `concrete_wall_008` | Concrete Wall 008 | Dario Barresi, Charlotte Baglioni | https://polyhaven.com/a/concrete_wall_008 | Betonplatten, Radarsockel |
| `corrugated_iron_02` | Corrugated Iron 02 | Jenelle van Heerden, Sergej Majboroda | https://polyhaven.com/a/corrugated_iron_02 | Container, Werkstattdach, Hütten, Fässer |

Für Erdflächen (Bunkerabdeckung, Aushub) wird zusätzlich `terrain/brown_mud_dry` verwendet.
