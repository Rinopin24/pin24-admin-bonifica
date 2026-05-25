// ═══════════════════════════════════════════════════════════════════
// bonifica.js — porting JavaScript di normalize-addresses.py
// Modulo PURO (agnostico da UI). Riusabile in futura app Admin.
// ═══════════════════════════════════════════════════════════════════

(function (global) {
  'use strict';

  // ───────── Abbreviazioni note (C/so → Corso, V.le → Viale, …) ─────────
  const ABBR_MAP = {
    'c/so': 'Corso', 'c.so': 'Corso', 'cso': 'Corso',
    'v.le': 'Viale', 'v/le': 'Viale', 'vle': 'Viale',
    'p.zza': 'Piazza', 'p.za': 'Piazza', 'pzza': 'Piazza', 'p/zza': 'Piazza',
    'l.go': 'Largo', 'lgo': 'Largo',
    'b.go': 'Borgo', 'bgo': 'Borgo',
    'v.lo': 'Vicolo', 'vlo': 'Vicolo',
    'str.': 'Strada', 's.da': 'Strada',
    's.s.': 'Strada Statale', 'ss.': 'Strada Statale',
    's.p.': 'Strada Provinciale', 'sp.': 'Strada Provinciale',
    'c.da': 'Contrada', 'cda': 'Contrada',
    'loc.': 'Località', 'fraz.': 'Frazione', 'trav.': 'Traversa',
    'f.lli': 'Fratelli', 'fratelli.': 'Fratelli'
  };

  const LOWERCASE_WORDS = new Set([
    'di','da','del','dei','degli','della','dello','delle',
    'dal','dalla','dalle','dai','dagli',
    'in','con','su','per','tra','fra',
    'al','alla','ai','agli','alle','allo',
    'e','o','ed','od',
    'il','lo','la','gli','le','un','una','uno'
  ]);

  const ALWAYS_LOWERCASE = new Set(['snc','km','mt','kg','n.','no.','nr.']);
  const PRESERVE_UPPERCASE = new Set(['C/O','S/N']);
  const AMBIGUOUS_PREFIXES = new Set([
    'S.','M.','G.','D.','F.','A.','B.','P.','C.','L.','R.','T.'
  ]);

  const KNOWN_STREET_TYPES = new Set([
    'via','viale','vialetto','corso','piazza','piazzale','piazzetta',
    'largo','borgo','borghetto','vicolo','viuzza',
    'strada','stradone','contrada','località','frazione','traversa',
    'lungomare','lungolago','lungotevere','lungarno',
    'salita','discesa','rampa','passeggiata','galleria','scala',
    'rettifilo',
    'calle','campo','campiello','fondamenta',
    'corte','cortile'
  ]);

  const ROMAN_RE = /^[IVXLCDM]{1,5}\.?$/;
  const CIVICO_HAS_DIGIT_RE = /\d/;
  // Pattern encoding rotto (mojibake UTF-8/Latin1, +adjacente, etc.)
  // NB: in JS niente flag 'ASCII'; usiamo classi unicode-aware.
  const ENCODING_BROKEN_RE = /([ÂÃ][-ÿ])|(\+[A-Za-zÀ-ÿ])|([A-Za-zÀ-ÿ]\+)|(\?\?)|(�)|(¦)|([A-Za-z]-[¦°§])/;

  // ───────── Smart Title Case italiano ─────────
  function smartTitle(s, isFirstToken) {
    // Token con cifre (civici 12/A, 155A, ecc.) → uppercase lettere interne
    if (CIVICO_HAS_DIGIT_RE.test(s)) {
      // 12/A → 12/A, 12-14b → 12-14B, 155a → 155A
      return s.replace(/([a-zA-Z])/g, c => c.toUpperCase());
    }
    if (PRESERVE_UPPERCASE.has(s.toUpperCase())) return s.toUpperCase();
    if (ALWAYS_LOWERCASE.has(s.toLowerCase())) return s.toLowerCase();
    if (ROMAN_RE.test(s)) return s.toUpperCase();
    const lower = s.toLowerCase();
    if (!isFirstToken && LOWERCASE_WORDS.has(lower)) return lower;
    // Standard title case: prima maiuscola, resto minuscolo
    // Gestisce anche apostrofi: D'AOSTA → D'Aosta
    return lower.charAt(0).toUpperCase() + lower.slice(1).replace(
      /(['’])([a-zà-ÿ])/g,
      (_m, q, c) => q + c.toUpperCase()
    );
  }

  function applySmartTitle(s) {
    // Preserva la struttura del separatore virgola/spazio
    const parts = s.split(/(\s+|,)/);
    let firstWord = true;
    const out = parts.map(tok => {
      if (/^\s+$/.test(tok) || tok === ',') return tok;
      if (!tok) return tok;
      const res = smartTitle(tok, firstWord);
      firstWord = false;
      return res;
    });
    return out.join('');
  }

  // ───────── Espansione abbreviazioni ─────────
  function expandAbbreviations(s) {
    const tokens = s.split(' ');
    return tokens.map(t => {
      const m = t.match(/^([\w./]+?)([,;:]?)$/);
      if (!m) return t;
      const core = m[1];
      const trailing = m[2];
      const key = core.toLowerCase();
      if (ABBR_MAP[key]) return ABBR_MAP[key] + trailing;
      return t;
    }).join(' ');
  }

  // ───────── Normalizzazione civico finale ─────────
  function normalizeCivicoSeparator(s) {
    // Aggiunge virgola prima del civico se manca: "Via Roma 12" → "Via Roma, 12"
    // Solo se l'indirizzo sembra completo (almeno 2 parole + numero finale)
    const m = s.match(/^(.+?)\s+(\d+(?:\/[A-Z0-9]+)?(?:bis|ter)?)$/i);
    if (m && !/,/.test(s)) {
      const parts = m[1].trim().split(/\s+/);
      if (parts.length >= 2) {
        return m[1].trim() + ', ' + m[2];
      }
    }
    return s;
  }

  // ───────── Funzione pura principale ─────────
  function normalizeAddress(raw) {
    const flags = [];
    if (raw == null) return { value: '', flags: ['vuoto'] };
    let s = String(raw).trim();
    if (!s) return { value: '', flags: ['vuoto'] };

    if (ENCODING_BROKEN_RE.test(s)) flags.push('encoding_broken');

    // Riparazione N° corrotti
    s = s.replace(/\bN[-¦¡§°]{1,2}/g, 'N ');
    s = s.replace(/N¦/g, 'N ').replace(/N¡/g, 'N ');

    // Rimuove indicatori "Nro/Nr/N./N°" se seguiti da numero
    s = s.replace(/\b(?:Nro?\.?|N\.|N°)\s*(?=,\s*\d)/gi, '');
    s = s.replace(/\b(?:Nro?\.?|N\.|N°)\s+(?=\d)/gi, '');

    // Riparazioni OCR (DGÇÖ → D', LIBERT+Ç → LIBERTÀ)
    const OCR_REPAIRS = [
      ['DGÇÖ', "D'"], ['Dgçö', "D'"], ['dgçö', "d'"],
      ['LIBERT+Ç', 'LIBERTÀ'], ['Libert+ç', 'Libertà'], ['libert+ç', 'libertà']
    ];
    for (const [bad, good] of OCR_REPAIRS) {
      if (s.includes(bad)) {
        s = s.split(bad).join(good);
        if (!flags.includes('encoding_broken')) flags.push('encoding_broken');
      }
    }

    // Compatta spazi multipli
    s = s.replace(/\s+/g, ' ');
    // Spazio prima virgola → "X , 1" → "X, 1"
    s = s.replace(/\s+,/g, ',');
    // Spazio dopo virgola garantito: "X,1" → "X, 1"
    s = s.replace(/,(\S)/g, ', $1');

    // Civico ATTACCATO al nome: "PIAVE12/A" → "PIAVE 12/A"
    if (/[A-Za-zÀ-ÿ]{3,}\d/.test(s)) {
      s = s.replace(/([A-Za-zÀ-ÿ]{3,})(\d)/g, '$1 $2');
      flags.push('civico_attaccato');
    }

    // Cleanup spazi nei civici: "34/ B-C" → "34/B-C"
    s = s.replace(/(\d)\s*([/\-])\s*([A-Za-z0-9])/g, '$1$2$3');

    // Espansione abbreviazioni
    s = expandAbbreviations(s);

    // Iniziale puntata attaccata al cognome: "G.MATTEOTTI" → "G. MATTEOTTI"
    if (/\b[A-Z]\.[A-Z]{2,}/.test(s)) {
      s = s.replace(/\b([A-Z])\.([A-Z]{2,})/g, '$1. $2');
      flags.push('iniziale_attaccata');
    }

    // Detect abbreviazioni puntate ambigue (D., S., G., ecc.)
    const tokens = s.split(' ');
    for (const t of tokens) {
      const m = t.match(/^([\w./]+?)([,;:]?)$/);
      if (!m) continue;
      const core = m[1];
      if (core.length === 2 && core.endsWith('.') &&
          /[a-zA-Z]/.test(core[0]) &&
          AMBIGUOUS_PREFIXES.has(core.toUpperCase())) {
        flags.push('abbr_ambigua');
        break;
      }
    }

    // Smart title case
    s = applySmartTitle(s);

    // Civico separatore finale
    s = normalizeCivicoSeparator(s);

    // Solo numero senza via
    if (/^\d+\s*[a-zA-Z]?$/.test(s.trim())) flags.push('solo_civico');

    // Prima parola NON è tipologia stradale nota
    const firstWord = s.trim().split(' ', 1)[0].toLowerCase().replace(/[.,;:]+$/, '');
    if (firstWord && !/^\d/.test(firstWord) && !KNOWN_STREET_TYPES.has(firstWord)) {
      const isInitialPuntata = /^[a-z]\/[a-z]$/.test(firstWord) || /^[a-z]\.$/.test(firstWord);
      if (!isInitialPuntata) flags.push('tipologia_mancante');
    }

    // Civici anomali (≥ 3 numeri)
    const civici = s.match(/\b\d+\b/g);
    if (civici && civici.length >= 3) flags.push('civico_anomalo');

    // Dedup flag preservando ordine
    const seen = new Set();
    const uniqueFlags = flags.filter(f => seen.has(f) ? false : seen.add(f));

    return { value: s.trim(), flags: uniqueFlags };
  }

  // ───────── Trova colonna indirizzo ─────────
  function pickAddressColumn(headers) {
    const candidates = [
      'Indirizzo Sede', 'indirizzo_sede', 'Indirizzo',
      'indirizzo', 'Via', 'Address'
    ];
    const lower = headers.map(h => String(h).toLowerCase());
    for (const cand of candidates) {
      const i = lower.indexOf(cand.toLowerCase());
      if (i >= 0) return headers[i];
    }
    return null;
  }

  // ───────── Processa un intero array di record ─────────
  // rows: Array<Object> (output di SheetJS sheet_to_json)
  // Ritorna: { rows: rows_modificati, issues: Array<{cod_punto, address, flags}>, stats: {…} }
  function processRows(rows) {
    if (!rows || rows.length === 0) {
      return { rows: [], issues: [], stats: { total: 0, modified: 0, flagged: 0 } };
    }
    const headers = Object.keys(rows[0]);
    const addrCol = pickAddressColumn(headers);
    if (!addrCol) {
      throw new Error('Nessuna colonna indirizzo trovata (cercato: Indirizzo Sede, indirizzo, Via).');
    }
    const idCol = ['Cod_Punto', 'cod_punto', 'Codice Punto'].find(c => headers.includes(c)) || null;

    let modified = 0;
    let flagged = 0;
    const issues = [];

    const outRows = rows.map(row => {
      const original = row[addrCol];
      const { value, flags } = normalizeAddress(original);
      const newRow = { ...row };
      newRow[addrCol] = value;
      newRow[addrCol + '_originale'] = original;
      newRow[addrCol + '_flags'] = flags.join(',');
      if (String(original || '').trim() !== value) modified++;
      if (flags.length > 0) {
        flagged++;
        issues.push({
          cod_punto: idCol ? row[idCol] : null,
          indirizzo_originale: original,
          indirizzo_normalizzato: value,
          flags: flags.join(',')
        });
      }
      return newRow;
    });

    return {
      rows: outRows,
      issues,
      stats: {
        total: rows.length,
        modified,
        flagged,
        addressColumn: addrCol
      }
    };
  }

  // Export pubblico (anche per testing)
  global.BONIFICA = {
    normalizeAddress,
    processRows,
    pickAddressColumn,
    // helpers esposti per test
    _expandAbbreviations: expandAbbreviations,
    _applySmartTitle: applySmartTitle
  };

})(typeof window !== 'undefined' ? window : globalThis);
