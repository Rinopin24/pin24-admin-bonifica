// ═══════════════════════════════════════════════════════════════════
// xlsx-io.js — wrappers SheetJS per lettura/scrittura XLSX e CSV
// SheetJS è caricato da CDN nell'index.html (window.XLSX)
// ═══════════════════════════════════════════════════════════════════

(function (global) {
  'use strict';

  if (typeof XLSX === 'undefined') {
    console.error('[xlsx-io] SheetJS non caricato. Verifica lo script CDN in index.html.');
  }

  // Legge un File (input drag&drop) e ritorna { rows, sheetName, headers }
  async function readFile(file) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const sheetName = wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    // defval: '' garantisce che ogni cella vuota arrivi come stringa vuota,
    // mantenendo headers consistenti tra righe diverse
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
    return { rows, sheetName, headers };
  }

  // Scrive un array di righe come XLSX e triggera il download
  function writeXlsx(rows, filename, sheetName) {
    const wb = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, sheet, sheetName || 'Foglio1');
    XLSX.writeFile(wb, filename, {
      bookType: 'xlsx',
      // Manteniamo le date/numeri come sono (no parsing aggressivo)
      cellDates: false
    });
  }

  // Scrive XLSX con un secondo foglio NASCOSTO "_pin24_meta" contenente
  // i metadati strutturati del tour (vedi project_coordinamento_admin_field_pipeline
  // memoria — "Metadati anti-doppia-processazione").
  //
  // Il foglio meta ha 2 colonne: key, value (entrambe stringa, value JSON-string
  // per valori non scalari). Esempio key: bonificato, tour_id, bonificato_at,
  // tool_version, regione, pvr_count.
  //
  // Field/Admin all'import controllano la presenza di questo foglio per
  // evitare di riprocessare un file già bonificato.
  function writeXlsxWithMeta(rows, filename, opts) {
    const o = opts || {};
    const sheetName = o.sheetName || 'Foglio1';
    const meta = o.meta || {};

    const wb = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, sheet, sheetName);

    // Foglio metadati nascosto
    const metaRows = Object.entries(meta).map(([key, value]) => ({
      key: key,
      value: (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
        ? value
        : JSON.stringify(value)
    }));
    const metaSheet = XLSX.utils.json_to_sheet(metaRows);
    const META_SHEET_NAME = '_pin24_meta';
    XLSX.utils.book_append_sheet(wb, metaSheet, META_SHEET_NAME);
    // Marca il foglio come nascosto (1 = hidden, 2 = veryHidden).
    // SheetJS espone questa proprietà via Workbook.Workbook.Sheets[].Hidden.
    if (!wb.Workbook) wb.Workbook = {};
    if (!wb.Workbook.Sheets) wb.Workbook.Sheets = [];
    wb.Workbook.Sheets = wb.SheetNames.map(name => ({
      name: name,
      Hidden: name === META_SHEET_NAME ? 1 : 0
    }));

    XLSX.writeFile(wb, filename, {
      bookType: 'xlsx',
      cellDates: false
    });
  }

  // Legge i metadati _pin24_meta da un workbook già aperto. Ritorna oggetto
  // chiave/valore o null se assente. Usato da Field/Admin all'import per
  // riconoscere file già processati.
  function readMetaFromWorkbook(wb) {
    if (!wb || !wb.Sheets || !wb.Sheets['_pin24_meta']) return null;
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['_pin24_meta'], { defval: '' });
    const out = {};
    for (const r of rows) {
      if (!r || !r.key) continue;
      let v = r.value;
      // Prova a deserializzare JSON-strings (array, oggetti)
      if (typeof v === 'string' && (v.startsWith('[') || v.startsWith('{'))) {
        try { v = JSON.parse(v); } catch (_) { /* mantieni stringa */ }
      }
      out[r.key] = v;
    }
    return out;
  }

  // Scrive CSV (per anomalie testo)
  function writeCsv(rows, filename) {
    const wb = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet(rows);
    const csv = XLSX.utils.sheet_to_csv(sheet, { FS: ';' });
    // BOM UTF-8 così Excel apre il CSV in italiano senza disastri
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    triggerDownload(blob, filename);
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 200);
  }

  global.XLSX_IO = { readFile, writeXlsx, writeXlsxWithMeta, readMetaFromWorkbook, writeCsv };

})(typeof window !== 'undefined' ? window : globalThis);
