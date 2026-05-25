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

  global.XLSX_IO = { readFile, writeXlsx, writeCsv };

})(typeof window !== 'undefined' ? window : globalThis);
