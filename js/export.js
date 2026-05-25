// ═══════════════════════════════════════════════════════════════════
// export.js — produzione dei 4 file output finali
// 1. <basename>_final.xlsx        → PVR ready per Field/Admin
// 2. <basename>_diff_istat.xlsx   → correzioni ISTAT per dip. dati
// 3. <basename>_issues_testo.csv  → anomalie testo per dip. dati
// 4. <basename>_excluded_outliers.xlsx → PVR fuori regione tour
// ═══════════════════════════════════════════════════════════════════

(function (global) {
  'use strict';

  function sanitizeBase(filename) {
    // Rimuove estensione e parentesi/spazi indesiderabili
    return String(filename || 'pvr')
      .replace(/\.(xlsx|xls|csv)$/i, '')
      .replace(/[()]/g, '')
      .replace(/\s+/g, '_')
      .trim();
  }

  function exportFinal(rows, baseName) {
    if (!rows || rows.length === 0) return null;
    const fn = sanitizeBase(baseName) + '_final.xlsx';
    XLSX_IO.writeXlsx(rows, fn);
    return fn;
  }

  function exportDiff(diffs, baseName) {
    if (!diffs || diffs.length === 0) return null;
    const fn = sanitizeBase(baseName) + '_diff_istat.xlsx';
    XLSX_IO.writeXlsx(diffs, fn);
    return fn;
  }

  function exportIssues(issues, baseName) {
    if (!issues || issues.length === 0) return null;
    const fn = sanitizeBase(baseName) + '_issues_testo.csv';
    XLSX_IO.writeCsv(issues, fn);
    return fn;
  }

  function exportExcluded(excluded, baseName) {
    if (!excluded || excluded.length === 0) return null;
    const fn = sanitizeBase(baseName) + '_excluded_outliers.xlsx';
    XLSX_IO.writeXlsx(excluded, fn);
    return fn;
  }

  function exportGeocodingLow(lowRows, baseName) {
    if (!lowRows || lowRows.length === 0) return null;
    const fn = sanitizeBase(baseName) + '_geocoding_low.xlsx';
    XLSX_IO.writeXlsx(lowRows, fn);
    return fn;
  }

  function exportAll(result, baseName) {
    const written = [];
    let fn;
    fn = exportFinal(result.ready, baseName); if (fn) written.push(fn);
    fn = exportDiff(result.diffs, baseName); if (fn) written.push(fn);
    fn = exportIssues(result.issues, baseName); if (fn) written.push(fn);
    fn = exportExcluded(result.excluded, baseName); if (fn) written.push(fn);
    fn = exportGeocodingLow(result.geocodingLow, baseName); if (fn) written.push(fn);
    return written;
  }

  global.EXPORT = { exportFinal, exportDiff, exportIssues, exportExcluded, exportGeocodingLow, exportAll, sanitizeBase };

})(typeof window !== 'undefined' ? window : globalThis);
