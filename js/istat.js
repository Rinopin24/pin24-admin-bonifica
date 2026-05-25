// ═══════════════════════════════════════════════════════════════════
// istat.js — porting JavaScript di istat-validate.py
// Cross-validazione sede ↔ provincia ↔ regione contro DB ISTAT.
// DB scaricato da github.com/matteocontrini/comuni-json e cachato in
// localStorage. Refresh automatico ogni 30 giorni.
// ═══════════════════════════════════════════════════════════════════

(function (global) {
  'use strict';

  const COMUNI_URL = 'https://raw.githubusercontent.com/matteocontrini/comuni-json/master/comuni.json';
  const CACHE_KEY = 'pin24_istat_comuni';
  const CACHE_TS_KEY = 'pin24_istat_comuni_ts';
  const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 giorni

  let _lookup = null; // { byNomeNorm: Map<string, [comune,…]>, all: [...] }

  // ───────── Normalizzazione confronto (NFKD + uppercase) ─────────
  function normName(s) {
    if (s == null) return '';
    return String(s).trim()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '') // rimuovi diacritici
      .toUpperCase();
  }

  // ───────── Loader DB con cache localStorage ─────────
  async function loadComuniDB(onProgress) {
    try {
      const ts = parseInt(localStorage.getItem(CACHE_TS_KEY) || '0', 10);
      const fresh = (Date.now() - ts) < CACHE_TTL_MS;
      if (fresh) {
        const cached = localStorage.getItem(CACHE_KEY);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (onProgress) onProgress(`DB ISTAT da cache (${parsed.length} comuni)`);
          return parsed;
        }
      }
    } catch (_) { /* cache corrotta, ignora */ }

    if (onProgress) onProgress('Scarico DB ISTAT da github.com…');
    const resp = await fetch(COMUNI_URL);
    if (!resp.ok) throw new Error(`Download DB ISTAT fallito: HTTP ${resp.status}`);
    const data = await resp.json();
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(data));
      localStorage.setItem(CACHE_TS_KEY, String(Date.now()));
    } catch (e) {
      // Storage pieno → ignora, il DB sarà disponibile in memoria per questa sessione
      console.warn('[istat] cache localStorage fallita:', e.message);
    }
    if (onProgress) onProgress(`DB ISTAT caricato (${data.length} comuni)`);
    return data;
  }

  // ───────── Costruzione indice lookup ─────────
  function buildLookup(comuni) {
    const byNomeNorm = new Map();
    for (const c of comuni) {
      const key = normName(c.nome);
      if (!byNomeNorm.has(key)) byNomeNorm.set(key, []);
      byNomeNorm.get(key).push(c);
    }
    return { byNomeNorm, all: comuni };
  }

  // ───────── Validazione singolo record ─────────
  // Ritorna { corrected: Object|null, changes: [{field, before, after}], reason }
  function validateRecord(row, cols) {
    const sedeRaw = row[cols.sede];
    const provRaw = row[cols.provincia];
    const regRaw = row[cols.regione];
    if (!sedeRaw) return { corrected: null, changes: [], reason: 'no_sede' };

    const key = normName(sedeRaw);
    const matches = _lookup.byNomeNorm.get(key) || [];

    if (matches.length === 0) {
      return {
        corrected: null,
        changes: [],
        reason: 'non_correggibile',
        note: `Comune '${sedeRaw}' non trovato nel DB ISTAT. ` +
              `Verificare ortografia (es. fusione comunale, accenti, doppia denominazione).`
      };
    }

    if (matches.length > 1) {
      // Più comuni con stesso nome: prova a disambiguare con provincia o regione
      const provN = normName(provRaw);
      const regN = normName(regRaw);
      let pick = matches.find(c => normName(c.sigla) === provN);
      if (!pick) pick = matches.find(c => normName(c.regione && c.regione.nome) === regN);
      if (!pick) {
        return {
          corrected: null,
          changes: [],
          reason: 'ambiguo',
          note: `Comune '${sedeRaw}' presente in ${matches.length} province. Disambiguazione fallita.`
        };
      }
      return _checkAndDiff(row, cols, pick);
    }

    return _checkAndDiff(row, cols, matches[0]);
  }

  function _checkAndDiff(row, cols, istat) {
    const changes = [];
    const corrected = { ...row };
    const istatProv = istat.sigla;
    const istatReg = istat.regione && istat.regione.nome;
    const curProv = row[cols.provincia];
    const curReg = row[cols.regione];

    if (curProv && normName(curProv) !== normName(istatProv)) {
      changes.push({ field: 'provincia', before: curProv, after: istatProv });
      corrected[cols.provincia] = istatProv;
    }
    if (curReg && istatReg && normName(curReg) !== normName(istatReg)) {
      changes.push({ field: 'regione', before: curReg, after: istatReg });
      corrected[cols.regione] = istatReg;
    }

    if (changes.length === 0) return { corrected: null, changes: [], reason: 'ok' };
    return { corrected, changes, reason: 'corretto' };
  }

  // ───────── Pick colonne ─────────
  function pickColumns(headers) {
    const find = (cands) => {
      const lower = headers.map(h => String(h).toLowerCase());
      for (const c of cands) {
        const i = lower.indexOf(c.toLowerCase());
        if (i >= 0) return headers[i];
      }
      return null;
    };
    return {
      sede: find(['Sede', 'sede', 'Comune', 'comune', 'Comune Sede']),
      provincia: find(['Provincia', 'provincia', 'Prov', 'PV']),
      regione: find(['regione_PV', 'Regione', 'regione', 'Regione PV'])
    };
  }

  // ───────── Processa intero array di record ─────────
  async function processRows(rows, onProgress) {
    if (!rows || rows.length === 0) {
      return { rows: [], diffs: [], stats: { total: 0, corrected: 0, non_correggibili: 0 } };
    }
    if (!_lookup) {
      const data = await loadComuniDB(onProgress);
      _lookup = buildLookup(data);
    }
    const headers = Object.keys(rows[0]);
    const cols = pickColumns(headers);
    if (!cols.sede) {
      throw new Error('Nessuna colonna Sede/Comune trovata per validazione ISTAT.');
    }
    const idCol = ['Cod_Punto', 'cod_punto', 'Codice Punto'].find(c => headers.includes(c));

    let nCorrected = 0;
    let nNonCorreg = 0;
    const diffs = [];

    const outRows = rows.map(row => {
      const res = validateRecord(row, cols);
      if (res.reason === 'corretto' && res.corrected) {
        nCorrected++;
        const diff = {
          cod_punto: idCol ? row[idCol] : null,
          sede_prima: row[cols.sede],
          sede_dopo: res.corrected[cols.sede] || row[cols.sede],
          provincia_prima: row[cols.provincia] || '',
          provincia_dopo: res.corrected[cols.provincia] || row[cols.provincia] || '',
          regione_prima: row[cols.regione] || '',
          regione_dopo: res.corrected[cols.regione] || row[cols.regione] || '',
          tipo_correzione: res.changes.map(c => `${c.field}: '${c.before}'→'${c.after}'`).join('; '),
          azione_alla_fonte: `Aggiornare sul DB Tableau: ${res.changes.map(c => `${c.field} '${c.before}'→'${c.after}'`).join('; ')}`
        };
        diffs.push(diff);
        return res.corrected;
      }
      if (res.reason === 'non_correggibile') {
        nNonCorreg++;
        diffs.push({
          cod_punto: idCol ? row[idCol] : null,
          sede_prima: row[cols.sede],
          sede_dopo: '',
          provincia_prima: row[cols.provincia] || '',
          provincia_dopo: '',
          regione_prima: row[cols.regione] || '',
          regione_dopo: '',
          tipo_correzione: 'non_correggibile',
          azione_alla_fonte: res.note || ''
        });
      }
      return row;
    });

    return {
      rows: outRows,
      diffs,
      stats: {
        total: rows.length,
        corrected: nCorrected,
        non_correggibili: nNonCorreg,
        cols
      }
    };
  }

  global.ISTAT = {
    loadComuniDB,
    processRows,
    validateRecord,
    pickColumns,
    _normName: normName
  };

})(typeof window !== 'undefined' ? window : globalThis);
