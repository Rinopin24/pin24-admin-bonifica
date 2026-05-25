// ═══════════════════════════════════════════════════════════════════
// region-filter.js — porting JavaScript di region-filter.py
// Esclude PVR con regione_PV diversa dalla regione del tour.
// Auto-detect con soglia 80% + override esplicito.
// ═══════════════════════════════════════════════════════════════════

(function (global) {
  'use strict';

  const DEFAULT_THRESHOLD = 0.80;

  function normRegion(s) {
    if (s == null) return '';
    return String(s).trim()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase();
  }

  function pickRegionColumn(headers) {
    const candidates = [
      'regione_PV', 'Regione_PV', 'regione', 'Regione',
      'Regione PV', 'Regione Punto', 'Region'
    ];
    const lower = headers.map(h => String(h).toLowerCase());
    for (const c of candidates) {
      const i = lower.indexOf(c.toLowerCase());
      if (i >= 0) return headers[i];
    }
    return null;
  }

  // Auto-detect regione del tour. Ritorna { region, pct, distribution }
  function detectTourRegion(rows, threshold) {
    threshold = threshold || DEFAULT_THRESHOLD;
    if (!rows || rows.length === 0) return { region: null, pct: 0, distribution: {} };
    const regionCol = pickRegionColumn(Object.keys(rows[0]));
    if (!regionCol) return { region: null, pct: 0, distribution: {} };

    const counts = new Map();
    let total = 0;
    for (const r of rows) {
      const n = normRegion(r[regionCol]);
      if (!n) continue;
      counts.set(n, (counts.get(n) || 0) + 1);
      total++;
    }
    if (total === 0) return { region: null, pct: 0, distribution: {} };

    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const [topRegion, topCount] = sorted[0];
    const topPct = topCount / total;
    const distribution = Object.fromEntries(sorted);
    if (topPct >= threshold) return { region: topRegion, pct: topPct, distribution };
    return { region: null, pct: topPct, distribution };
  }

  // Filtra rows in (ready, excluded) basandosi su regione_PV vs tourRegion
  function filterByRegion(rows, tourRegion) {
    if (!rows || rows.length === 0) return { ready: [], excluded: [], regionCol: null };
    const regionCol = pickRegionColumn(Object.keys(rows[0]));
    if (!regionCol) {
      throw new Error('Nessuna colonna regione_PV (o varianti) trovata.');
    }
    const target = normRegion(tourRegion);
    if (!target) throw new Error('Regione tour vuota.');

    const ready = [];
    const excluded = [];
    for (const r of rows) {
      if (normRegion(r[regionCol]) === target) ready.push(r);
      else excluded.push(r);
    }
    return { ready, excluded, regionCol };
  }

  global.REGION_FILTER = {
    detectTourRegion,
    filterByRegion,
    pickRegionColumn,
    _normRegion: normRegion,
    DEFAULT_THRESHOLD
  };

})(typeof window !== 'undefined' ? window : globalThis);
