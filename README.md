# PIN24 Admin — Bonifica file PVR

Web tool standalone per la bonifica e geocodifica dei file XLSX di Tableau prima del caricamento in PIN24 Field.

## Cosa fa

Pipeline a 4 fasi, tutto in browser:

1. **Bonifica testo indirizzi** — espansione abbreviazioni (C/so → Corso), riparazione mojibake (`DGÇÖ` → `D'`), normalizzazione spazi/virgole, smart Title Case italiano, flag anomalie.
2. **Validazione ISTAT comuni** — cross-check sede ↔ provincia ↔ regione contro DB ISTAT ~8000 comuni italiani. Correzione automatica record incoerenti.
3. **Filtro regione tour** — auto-detect regione del tour (≥80%) + esclusione PVR outlier (crossover sede legale ↔ operativa).
4. **Geocoding cascade** — Nominatim strutturato → Photon → Nominatim free-text. Cache IndexedDB cross-sessione. Confidence scoring (high/medium/low/none).

## Output

5 file XLSX/CSV generati dopo l'elaborazione:

| File | Per chi |
|---|---|
| `_final.xlsx` | PIN24 Field/Admin (lat/lng inclusi) |
| `_diff_istat.xlsx` | Dipartimento dati (correzioni alla fonte) |
| `_issues_testo.csv` | Dipartimento dati (anomalie testuali) |
| `_excluded_outliers.xlsx` | Dipartimento dati (PVR fuori regione) |
| `_geocoding_low.xlsx` | Dipartimento dati (geocoding low/none) |

## Caratteristiche

- **Vanilla JavaScript**, zero build, zero dipendenze npm
- **SheetJS** da CDN per lettura/scrittura XLSX
- **DB ISTAT** cached in `localStorage` per 30 giorni
- **Cache geocoding** in `IndexedDB` cross-sessione
- **Tutto in locale** — nessun dato operatori transita su server esterni. Solo Nominatim/Photon per geocoding (dati indirizzo, no dati personali) e github.com/matteocontrini per DB ISTAT.
- **Architettura modulare**: i 6 moduli sotto `js/` sono agnostici dall'UI, riusabili nella futura app PIN24 Admin desktop.

## Uso

Apri `index.html` in un browser moderno (Chrome, Edge, Firefox). Trascina il file XLSX di Tableau sulla dropzone, attendi le 4 fasi, scarica i file.

## Architettura modulare

```
PIN24-Admin-Bonifica/
├── index.html
├── css/style.css
├── js/
│   ├── xlsx-io.js        wrapper SheetJS
│   ├── bonifica.js       Fase 1: bonifica testo
│   ├── istat.js          Fase 2: validazione ISTAT
│   ├── region-filter.js  Fase 3: filtro regione
│   ├── geocoding.js      Fase 4: cascade geocoding
│   ├── export.js         emissione 5 file output
│   └── app.js            orchestrazione UI (unico modulo UI-coupled)
└── README.md
```

I moduli sotto `js/` (esclusi `app.js`) sono puri/agnostici. Quando arriverà l'app PIN24 Admin desktop, basterà importarli senza riscriverli.
