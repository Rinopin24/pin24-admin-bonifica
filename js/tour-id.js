// ═══════════════════════════════════════════════════════════════════
// tour-id.js — Generazione Tour ID + gestione indice master tours
// ═══════════════════════════════════════════════════════════════════
// Tour ID formato: T<YYYY>-<MM>-<sigla-regione>-<NN>
// Esempio: T2026-05-PUG-01
//
// Componenti:
//   T            prefisso fisso (distingue da altri file)
//   2026-05      anno-mese del tour (da data inizio)
//   PUG          sigla ISTAT 3 lettere (vedi REGION_SIGLA)
//   01           progressivo dentro mese+regione (auto-calcolato dall'indice)
//
// Indice master: array di entries persistito in localStorage chiave
// `pin24_tours_index`. In MVP3 sarà sincronizzato su Drive.
//
// Modulo agnostico (no UI), pattern identico a BONIFICA/ISTAT/REGION_FILTER.
// ═══════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const STORAGE_KEY = 'pin24_tours_index';
  const TOUR_ID_VERSION = 1;

  // ───────── Mapping regione Italia → sigla ISTAT 3 lettere ─────────
  // Convenzione utilizzata dall'ISTAT per i codici regione abbreviati.
  // Tabella ufficiale 20 regioni. La sigla è case-insensitive in input
  // ma sempre maiuscola in output (parte del Tour ID).
  const REGION_SIGLA = {
    'Abruzzo':                  'ABR',
    'Basilicata':               'BAS',
    'Calabria':                 'CAL',
    'Campania':                 'CAM',
    'Emilia-Romagna':           'EMR',
    'Friuli-Venezia Giulia':    'FVG',
    'Lazio':                    'LAZ',
    'Liguria':                  'LIG',
    'Lombardia':                'LOM',
    'Marche':                   'MAR',
    'Molise':                   'MOL',
    'Piemonte':                 'PIE',
    'Puglia':                   'PUG',
    'Sardegna':                 'SAR',
    'Sicilia':                  'SIC',
    'Toscana':                  'TOS',
    'Trentino-Alto Adige':      'TAA',
    'Umbria':                   'UMB',
    "Valle d'Aosta":            'VAL',
    'Veneto':                   'VEN'
  };

  // Reverse lookup: sigla → label completa (per UI archivio/dettaglio)
  const SIGLA_TO_LABEL = Object.fromEntries(
    Object.entries(REGION_SIGLA).map(([label, sigla]) => [sigla, label])
  );

  // Lista regioni ordinata alfabetica (per dropdown UI)
  const REGION_LIST = Object.keys(REGION_SIGLA).sort();

  // ───────── Helpers ─────────

  // Estrae anno-mese (YYYY-MM) da una stringa data ISO YYYY-MM-DD
  // Tolleranza: accetta anche stringhe Date-parsable in altri formati.
  function _yearMonth(dateStr) {
    if (!dateStr) return null;
    // Tenta parsing diretto YYYY-MM-DD (formato <input type="date">)
    const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}`;
    // Fallback: passa per Date object
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      return `${yyyy}-${mm}`;
    }
    return null;
  }

  // Restituisce la sigla ISTAT per una stringa regione (case-insensitive,
  // tollerante a piccole varianti). Null se non trovata.
  function siglaForRegion(regionLabel) {
    if (!regionLabel) return null;
    const norm = String(regionLabel).trim();
    // Match esatto
    if (REGION_SIGLA[norm]) return REGION_SIGLA[norm];
    // Match case-insensitive
    const lower = norm.toLowerCase();
    for (const [label, sigla] of Object.entries(REGION_SIGLA)) {
      if (label.toLowerCase() === lower) return sigla;
    }
    // Se l'input è già una sigla 3 lettere maiuscola riconosciuta, ritornala
    const upper = norm.toUpperCase();
    if (SIGLA_TO_LABEL[upper]) return upper;
    return null;
  }

  function labelForSigla(sigla) {
    if (!sigla) return null;
    return SIGLA_TO_LABEL[String(sigla).toUpperCase()] || null;
  }

  // ───────── Indice master tours (persistito in localStorage) ─────────

  // Carica l'indice da localStorage. Sempre ritorna un array (vuoto se assente).
  function loadToursIndex() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : (Array.isArray(parsed.tours) ? parsed.tours : []);
    } catch (_) {
      return [];
    }
  }

  function saveToursIndex(arr) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(arr || []));
      return true;
    } catch (_) {
      return false;
    }
  }

  // Calcola il prossimo progressivo NN per il combo (anno-mese, sigla).
  // Esempio: se nell'indice esistono T2026-05-PUG-01 e T2026-05-PUG-02,
  // ritorna 3.
  function nextProgressivoFor(yearMonth, sigla) {
    if (!yearMonth || !sigla) return 1;
    const tours = loadToursIndex();
    const prefix = `T${yearMonth}-${sigla}-`;
    const existing = tours
      .filter(t => t && typeof t.tour_id === 'string' && t.tour_id.startsWith(prefix))
      .map(t => {
        const m = t.tour_id.match(/-(\d+)$/);
        return m ? parseInt(m[1], 10) : 0;
      });
    if (existing.length === 0) return 1;
    return Math.max(...existing) + 1;
  }

  // ───────── Generazione e parsing Tour ID ─────────

  // Genera Tour ID dato un setup. NON aggiunge automaticamente all'indice.
  // (L'aggiunta avviene esplicitamente con addTourEntry quando l'elaborazione
  // parte davvero, per evitare entries fantasma di abort.)
  //
  // Input:
  //   setup.data_inizio: stringa YYYY-MM-DD
  //   setup.regione:     stringa label completa (es. "Puglia") o sigla ("PUG")
  //
  // Ritorna: { ok: true, tour_id, yearMonth, sigla, progressivo }
  //          { ok: false, error }
  function generate(setup) {
    if (!setup) return { ok: false, error: 'Setup mancante' };
    const yearMonth = _yearMonth(setup.data_inizio);
    if (!yearMonth) return { ok: false, error: 'Data inizio tour non valida' };
    const sigla = siglaForRegion(setup.regione);
    if (!sigla) return { ok: false, error: `Regione "${setup.regione}" non riconosciuta` };
    const progressivo = nextProgressivoFor(yearMonth, sigla);
    const nn = String(progressivo).padStart(2, '0');
    const tour_id = `T${yearMonth}-${sigla}-${nn}`;
    return { ok: true, tour_id, yearMonth, sigla, progressivo, regione_label: labelForSigla(sigla) };
  }

  // Parse di un Tour ID nei suoi componenti. Null se non valido.
  // Esempio input: "T2026-05-PUG-01"
  // Output: { yearMonth: "2026-05", anno: 2026, mese: 5, sigla: "PUG",
  //           regione_label: "Puglia", progressivo: 1 }
  function parse(tourId) {
    if (!tourId) return null;
    const m = String(tourId).match(/^T(\d{4})-(\d{2})-([A-Z]{3})-(\d+)$/);
    if (!m) return null;
    return {
      yearMonth: `${m[1]}-${m[2]}`,
      anno: parseInt(m[1], 10),
      mese: parseInt(m[2], 10),
      sigla: m[3],
      regione_label: labelForSigla(m[3]),
      progressivo: parseInt(m[4], 10),
      tour_id: tourId
    };
  }

  // ───────── Gestione entries indice ─────────

  // Crea una entry tour vuota con schema completo. Centralizzato qui
  // perché tutti i consumer dell'indice devono produrre/leggere entries
  // forward-compatible (vedi project_admin_search_tour_ux memoria).
  function createEntry(opts) {
    const o = opts || {};
    const now = new Date().toISOString();
    return {
      tour_id:                  o.tour_id          || '',
      data_inizio:              o.data_inizio      || '',
      data_fine:                o.data_fine        || null,
      regione:                  o.regione_sigla    || o.regione || '',
      regione_label:            o.regione_label    || labelForSigla(o.regione_sigla || o.regione) || '',
      province:                 Array.isArray(o.province) ? o.province : [],
      cliente:                  o.cliente          || '',
      operatori:                Array.isArray(o.operatori) ? o.operatori : [],
      totale_pvr:               typeof o.totale_pvr === 'number' ? o.totale_pvr : null,
      totale_pvr_bonificati:    typeof o.totale_pvr_bonificati === 'number' ? o.totale_pvr_bonificati : null,
      stato:                    o.stato            || 'in_corso',
      percentuale_completamento: typeof o.percentuale_completamento === 'number' ? o.percentuale_completamento : 0,
      drive_folder_url:         o.drive_folder_url || null,
      report_url:               o.report_url       || null,
      mappa_url:                o.mappa_url        || null,
      note:                     o.note             || '',
      created_at:               o.created_at       || now,
      updated_at:               o.updated_at       || now,
      tool_version:             TOUR_ID_VERSION
    };
  }

  // Aggiunge una entry all'indice. Se esiste già un tour col medesimo
  // tour_id, ritorna { ok: false, error: 'duplicate' } senza modificare.
  function addEntry(entry) {
    if (!entry || !entry.tour_id) return { ok: false, error: 'Entry senza tour_id' };
    const tours = loadToursIndex();
    if (tours.some(t => t && t.tour_id === entry.tour_id)) {
      return { ok: false, error: 'duplicate', tour_id: entry.tour_id };
    }
    tours.push(entry);
    saveToursIndex(tours);
    return { ok: true, tour_id: entry.tour_id };
  }

  // Aggiorna una entry esistente (merge shallow). Crea se non esiste.
  function upsertEntry(tour_id, patch) {
    if (!tour_id) return { ok: false, error: 'tour_id mancante' };
    const tours = loadToursIndex();
    const idx = tours.findIndex(t => t && t.tour_id === tour_id);
    const now = new Date().toISOString();
    if (idx === -1) {
      const entry = createEntry({ ...(patch || {}), tour_id });
      tours.push(entry);
    } else {
      tours[idx] = { ...tours[idx], ...(patch || {}), tour_id, updated_at: now };
    }
    saveToursIndex(tours);
    return { ok: true, tour_id };
  }

  function findByTourId(tour_id) {
    if (!tour_id) return null;
    return loadToursIndex().find(t => t && t.tour_id === tour_id) || null;
  }

  // ───────── Export API ─────────

  window.TOUR_ID = {
    // Metadata
    VERSION: TOUR_ID_VERSION,
    REGION_LIST: REGION_LIST,
    REGION_SIGLA: REGION_SIGLA,
    // Region helpers
    siglaForRegion: siglaForRegion,
    labelForSigla: labelForSigla,
    // Tour ID lifecycle
    generate: generate,
    parse: parse,
    // Index management
    loadToursIndex: loadToursIndex,
    saveToursIndex: saveToursIndex,
    nextProgressivoFor: nextProgressivoFor,
    createEntry: createEntry,
    addEntry: addEntry,
    upsertEntry: upsertEntry,
    findByTourId: findByTourId
  };
})();
