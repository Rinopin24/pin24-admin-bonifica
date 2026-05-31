// ═══════════════════════════════════════════════════════════════════
// export.js — produzione dei 5 file output finali con naming Tour ID
// ═══════════════════════════════════════════════════════════════════
// Pattern naming (MVP2, decisione 2026-05-25):
//   <Tour-ID>_<data-inizio>_<Fase>_<N>PVR.xlsx
//
// Fasi mappate:
//   final / ready    → "Bonificato"
//   diff istat       → "DiffISTAT"
//   issues testo     → "Issues-testo"        (CSV per dipartimento dati)
//   excluded outl.   → "Excluded-outliers"
//   geocoding low    → "Geocoding-low"
//
// Il file "Bonificato" include un foglio nascosto _pin24_meta con i
// metadati del tour. Field/Admin lo leggono all'import per evitare
// doppia processazione.
//
// Memoria di riferimento: [[coordinamento-admin-field-pipeline]].
// ═══════════════════════════════════════════════════════════════════

(function (global) {
  'use strict';

  const FASE = {
    BONIFICATO: 'Bonificato',
    DIFF_ISTAT: 'DiffISTAT',
    ISSUES: 'Issues-testo',
    EXCLUDED: 'Excluded-outliers',
    GEO_LOW: 'Geocoding-low'
  };

  // tool_version letto LAZY al momento dell'export (NON al load del modulo),
  // perché export.js carica prima di app.js → al load PIN24_BONIFICA_VERSION
  // non è ancora definita. Single source of truth in app.js APP_VERSION.
  // Estrae solo il numero versione dalla stringa "v1.1.4 · 31 mag 2026" → "1.1.4".
  // Fix bug 2026-05-31: prima TOOL_VERSION era const hardcoded '1.1.0', mai
  // sincronizzato con APP_VERSION.
  function getToolVersion() {
    try {
      const raw = (typeof window !== 'undefined' && window.PIN24_BONIFICA_VERSION) || '';
      const m = /v?(\d+\.\d+\.\d+)/.exec(raw);
      return m ? m[1] : '1.1.4';
    } catch (e) { return '1.1.4'; }
  }

  function sanitizeBase(filename) {
    return String(filename || 'pvr')
      .replace(/\.(xlsx|xls|csv)$/i, '')
      .replace(/[()]/g, '')
      .replace(/\s+/g, '_')
      .trim();
  }

  // Costruisce nome file convenzionale.
  // setup: { tour_id, data_inizio, ... }  (richiesto)
  // fase:  stringa "Bonificato" / "DiffISTAT" / ecc.
  // count: numero PVR/righe contenute nel file
  // ext:   "xlsx" o "csv"
  function _buildFilename(setup, fase, count, ext) {
    if (!setup || !setup.tour_id || !setup.data_inizio || !fase) {
      // Fallback al naming legacy quando setup mancante (es. uso programmatico
      // del modulo da contesto non-MVP2). Non dovrebbe mai accadere in UI.
      return `pin24_${fase || 'output'}_${Date.now()}.${ext}`;
    }
    const safeCount = (typeof count === 'number' && count > 0) ? `_${count}PVR` : '';
    return `${setup.tour_id}_${setup.data_inizio}_${fase}${safeCount}.${ext}`;
  }

  // Metadati strutturati scritti dentro il file Bonificato.
  // Schema deve essere stabile tra versioni (forward-compatible) per non
  // rompere Field/Admin all'import.
  function _buildMeta(setup, pvrCount) {
    const now = new Date().toISOString();
    return {
      bonificato: true,
      bonificato_at: now,
      tool_name: 'pin24-admin-bonifica',
      tool_version: getToolVersion(),
      schema_version: 1,
      tour_id: setup.tour_id || '',
      data_inizio: setup.data_inizio || '',
      regione: setup.regione_sigla || '',
      regione_label: setup.regione_label || '',
      cliente: setup.cliente || '',
      pvr_count: pvrCount || 0
    };
  }

  function exportFinal(rows, setup) {
    if (!rows || rows.length === 0) return null;
    const fn = _buildFilename(setup, FASE.BONIFICATO, rows.length, 'xlsx');
    if (XLSX_IO.writeXlsxWithMeta) {
      XLSX_IO.writeXlsxWithMeta(rows, fn, {
        sheetName: 'PVR',
        meta: _buildMeta(setup, rows.length)
      });
    } else {
      XLSX_IO.writeXlsx(rows, fn);
    }
    return fn;
  }

  function exportDiff(diffs, setup) {
    if (!diffs || diffs.length === 0) return null;
    const fn = _buildFilename(setup, FASE.DIFF_ISTAT, diffs.length, 'xlsx');
    XLSX_IO.writeXlsx(diffs, fn);
    return fn;
  }

  function exportIssues(issues, setup) {
    if (!issues || issues.length === 0) return null;
    const fn = _buildFilename(setup, FASE.ISSUES, issues.length, 'csv');
    XLSX_IO.writeCsv(issues, fn);
    return fn;
  }

  function exportExcluded(excluded, setup) {
    if (!excluded || excluded.length === 0) return null;
    const fn = _buildFilename(setup, FASE.EXCLUDED, excluded.length, 'xlsx');
    XLSX_IO.writeXlsx(excluded, fn);
    return fn;
  }

  function exportGeocodingLow(lowRows, setup) {
    if (!lowRows || lowRows.length === 0) return null;
    const fn = _buildFilename(setup, FASE.GEO_LOW, lowRows.length, 'xlsx');
    XLSX_IO.writeXlsx(lowRows, fn);
    return fn;
  }

  // setup = { tour_id, data_inizio, regione_sigla, regione_label, cliente }
  function exportAll(result, setup) {
    const written = [];
    let fn;
    fn = exportFinal(result.ready, setup);            if (fn) written.push(fn);
    fn = exportDiff(result.diffs, setup);             if (fn) written.push(fn);
    fn = exportIssues(result.issues, setup);          if (fn) written.push(fn);
    fn = exportExcluded(result.excluded, setup);      if (fn) written.push(fn);
    fn = exportGeocodingLow(result.geocodingLow, setup); if (fn) written.push(fn);
    return written;
  }

  global.EXPORT = {
    FASE,
    get TOOL_VERSION() { return getToolVersion(); }, // lazy getter (vedi commento riga 30)
    exportFinal,
    exportDiff,
    exportIssues,
    exportExcluded,
    exportGeocodingLow,
    exportAll,
    sanitizeBase,
    _buildFilename,
    _buildMeta
  };

})(typeof window !== 'undefined' ? window : globalThis);
