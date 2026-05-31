// ═══════════════════════════════════════════════════════════════════
// app.js — orchestrazione GUI (l'unico modulo UI-coupled)
// Tutti gli altri moduli (BONIFICA, ISTAT, REGION_FILTER, XLSX_IO, EXPORT)
// sono agnostici e riusabili in futuro Admin
// ═══════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ───────── APP_VERSION (singola fonte di verità) ─────────
  // Mostrata nel footer e usata dal toast cold start per detect aggiornamenti.
  // Quando si rilascia una nuova versione: aggiornare QUI E il version tag
  // nell'header in index.html.
  const APP_VERSION = 'v1.1.4 · 31 mag 2026';
  const LAST_SEEN_KEY = 'pin24_bonifica_last_seen_version';
  window.PIN24_BONIFICA_VERSION = APP_VERSION;

  // Estrae solo "v1.1.0" da "v1.1.0 · 26 mag 2026" per confronto.
  function _parseVersionNumber(s) {
    const m = String(s || '').match(/v\d+(?:\.\d+){1,3}/);
    return m ? m[0] : '';
  }

  // ───────── Stato sessione ─────────
  let state = {
    file: null,
    baseName: '',
    rawRows: [],
    afterBonifica: { rows: [], issues: [], stats: {} },
    afterIstat: { rows: [], diffs: [], stats: {} },
    afterRegion: { ready: [], excluded: [], detected: null, pct: 0, distribution: {} },
    afterGeo: { rows: [], stats: {} },
    selectedRegion: null,
    // Setup tour MVP2: { tour_id, data_inizio, regione_sigla, regione_label, cliente }
    // Popolato dal form setup tour dopo il drop file, PRIMA dell'elaborazione.
    tourSetup: null
  };

  // ───────── DOM refs ─────────
  const $ = (id) => document.getElementById(id);
  const dz = $('dropzone');
  const fileInput = $('file-input');
  const btnPick = $('btn-pick');
  const progress = $('progress');
  const progressFill = $('progress-fill');
  const progressStage = $('progress-stage');
  const progressSteps = $('progress-steps');
  const results = $('results');
  const resultsMeta = $('results-meta');
  const kpiRow = $('kpi-row');
  const regionPanel = $('region-panel');
  const regionDetected = $('region-detected');
  const regionPct = $('region-pct');
  const regionSelect = $('region-select');
  const btnRegionApply = $('btn-region-apply');
  const tabs = $('tabs');
  const tableHead = document.querySelector('#result-table thead');
  const tableBody = document.querySelector('#result-table tbody');
  const downloadRow = $('download-row');
  const errorBox = $('error-box');
  const errorMessage = $('error-message');
  const btnRestart = $('btn-restart');
  const btnRestartError = $('btn-restart-error');
  const btnExportAll = $('btn-export-all');

  // ───────── Setup tour MVP2 — DOM refs ─────────
  const tourSetup = $('tour-setup');
  const setupDataInizio = $('setup-data-inizio');
  const setupRegione = $('setup-regione');
  const setupCliente = $('setup-cliente');
  const setupPreview = $('setup-preview');
  const setupPreviewId = $('setup-preview-id');
  const setupError = $('setup-error');
  const btnSetupCancel = $('btn-setup-cancel');
  const btnSetupConfirm = $('btn-setup-confirm');
  // MVP2.1 — auto-detect regione + conferma/modifica
  const regionDetectedBlock = $('region-detected-block');
  const regionDetectedInfo = regionDetectedBlock.querySelector('.region-detected-info');
  const regionDetectedActions = $('region-detected-actions');
  const regionConfirmedBadge = $('region-confirmed-badge');
  const regionConfirmedLabel = $('region-confirmed-label');
  const btnRegionConfirm = $('btn-region-confirm');
  const btnRegionModify = $('btn-region-modify');
  const btnRegionChange = $('btn-region-change');
  const regionOverrideBlock = $('region-override-block');
  const regionOverrideNotice = $('region-override-notice');
  // Stato regione UI: 'pending' (auto-detect non confermato) | 'confirmed' (ok)
  let _regionUIState = 'pending';
  let _detectedRegion = null;
  let _detectedPct = 0;

  // ═══════════════════════════════════════════════════════════════
  //   SETUP TOUR MVP2 — form bloccante dopo drop file
  // ═══════════════════════════════════════════════════════════════
  // Flow: drop file → showSetupForm(file) → 3 input compilati →
  // preview Tour ID live → click "Avvia elaborazione" → handleFile(file)
  // riceve state.tourSetup popolato.
  //
  // Vincolo: data + regione obbligatorie non-skippabili (decisione
  // 2026-05-25, vedi project_coordinamento_admin_field_pipeline memoria).

  async function showSetupForm(file) {
    // Memorizza il file ma NON parte ancora l'elaborazione
    state.file = file;
    state.baseName = file.name;
    state.tourSetup = null;
    state.rawRows = [];

    // Reset campi form
    setupDataInizio.value = todayIso();
    setupRegione.value = '';
    setupCliente.value = '';
    setupError.classList.add('hidden');
    setupPreview.classList.add('hidden');
    btnSetupConfirm.disabled = true;

    // Reset stato regione UI
    _regionUIState = 'pending';
    _detectedRegion = null;
    _detectedPct = 0;
    regionDetectedActions.classList.add('hidden');
    regionConfirmedBadge.classList.add('hidden');
    regionOverrideBlock.classList.add('hidden');
    regionOverrideNotice.classList.add('hidden');
    regionDetectedInfo.innerHTML = '<span class="region-detected-label">Lettura del file in corso…</span>';

    // Mostra setup, nascondi dropzone
    dz.classList.add('hidden');
    tourSetup.classList.remove('hidden');

    // MVP2.1: pre-lettura file + auto-detect regione prima di chiedere
    // conferma all'utente. Riduce errore umano (selezione manuale random).
    try {
      const read = await XLSX_IO.readFile(file);
      state.rawRows = read.rows || [];
      const detect = REGION_FILTER.detectTourRegion(state.rawRows);
      _renderRegionDetected(detect);
    } catch (err) {
      console.error('[setup] read file fallita:', err);
      regionDetectedInfo.innerHTML = '<span class="region-detected-label">Errore lettura file. Seleziona manualmente la regione qui sotto.</span>';
      // Fallback: mostra override obbligatorio
      regionOverrideBlock.classList.remove('hidden');
    }

    onSetupChange();
  }

  // Renderizza il box "regione rilevata" in base al risultato detect.
  // Casi:
  //   detect.region !== null  → match ≥ threshold → mostra Conferma/Modifica
  //   detect.region === null  → auto-detect incerto → forza dropdown override
  //                             (precompila con la top distribution se esiste)
  function _renderRegionDetected(detect) {
    const pct = detect.pct || 0;
    const pctLabel = Math.round(pct * 100) + '%';
    if (detect.region) {
      _detectedRegion = detect.region;
      _detectedPct = pct;
      const tagClass = pct >= 0.8 ? '' : 'low';
      regionDetectedInfo.innerHTML =
        'Regione rilevata dal file: <strong>' + escapeHtml(detect.region) + '</strong>' +
        '<span class="region-pct-tag ' + tagClass + '">' + pctLabel + '</span>';
      regionDetectedActions.classList.remove('hidden');
      regionConfirmedBadge.classList.add('hidden');
      regionOverrideBlock.classList.add('hidden');
    } else {
      // Auto-detect fallito: mostra dropdown obbligatorio.
      // Se c'è una top distribution, info al utente quale è la più rappresentata.
      const top = Object.entries(detect.distribution || {}).sort((a,b)=>b[1]-a[1])[0];
      const topMsg = top
        ? ' (più rappresentata: <strong>' + escapeHtml(top[0]) + '</strong> con ' + pctLabel + ')'
        : '';
      regionDetectedInfo.innerHTML =
        'Auto-detect incerto' + topMsg + '. <strong>Seleziona manualmente</strong> la regione qui sotto.';
      regionDetectedActions.classList.add('hidden');
      regionConfirmedBadge.classList.add('hidden');
      regionOverrideBlock.classList.remove('hidden');
      // Se top esiste, pre-seleziona e marca come confermata automaticamente
      // (in questo caso non c'è "detected region" certificata da confrontare,
      // quindi non è un "override": l'utente può cambiarla via dropdown se vuole).
      if (top && TOUR_ID.siglaForRegion(top[0])) {
        setupRegione.value = _canonicalRegionLabel(top[0]);
        _regionUIState = 'confirmed';
      } else {
        _regionUIState = 'pending';
      }
    }
  }

  // Normalizza il label regione al formato canonico del dropdown ("Puglia"
  // non "PUGLIA"). REGION_FILTER.detectTourRegion ritorna uppercase tramite
  // normRegion: senza questa conversione, setupRegione.value rimane vuoto
  // perché le options del dropdown hanno value="Puglia" (capitalize) e il
  // browser non trova match con "PUGLIA".
  function _canonicalRegionLabel(any) {
    if (!any || !window.TOUR_ID) return any || '';
    const sigla = TOUR_ID.siglaForRegion(any);
    if (!sigla) return any;
    return TOUR_ID.labelForSigla(sigla) || any;
  }

  // L'utente accetta la regione auto-detected
  function onRegionConfirm() {
    if (!_detectedRegion) return;
    const canon = _canonicalRegionLabel(_detectedRegion);
    setupRegione.value = canon; // popola dropdown nascosto per validate
    _regionUIState = 'confirmed';
    regionDetectedActions.classList.add('hidden');
    regionConfirmedBadge.classList.remove('hidden');
    regionConfirmedLabel.textContent = canon;
    regionOverrideBlock.classList.add('hidden');
    regionOverrideNotice.classList.add('hidden');
    onSetupChange();
  }

  // L'utente vuole forzare una regione diversa
  function onRegionModify() {
    _regionUIState = 'pending';
    regionDetectedActions.classList.add('hidden');
    regionConfirmedBadge.classList.add('hidden');
    regionOverrideBlock.classList.remove('hidden');
    // Notice solo se l'auto-detect aveva trovato qualcosa (override vero)
    if (_detectedRegion) {
      regionOverrideNotice.classList.remove('hidden');
    }
    // Pre-seleziona la regione auto-detected come default del dropdown (l'utente
    // può comunque scegliere altra). Normalizza al formato canonico del dropdown.
    if (_detectedRegion) setupRegione.value = _canonicalRegionLabel(_detectedRegion);
    setupRegione.focus();
    onSetupChange();
  }

  // Dal badge "Regione confermata" l'utente può tornare a modificare
  function onRegionChange() {
    onRegionModify();
  }

  // Cambio del dropdown override → considera confermato
  function onRegioneOverrideChange() {
    if (setupRegione.value) {
      _regionUIState = 'confirmed';
      // Mostra notice se la scelta differisce dal detect
      if (_detectedRegion && setupRegione.value !== _detectedRegion) {
        regionOverrideNotice.classList.remove('hidden');
      } else {
        regionOverrideNotice.classList.add('hidden');
      }
    } else {
      _regionUIState = 'pending';
      regionOverrideNotice.classList.add('hidden');
    }
    onSetupChange();
  }

  function hideSetupForm() {
    tourSetup.classList.add('hidden');
  }

  function populateSetupRegions() {
    if (!window.TOUR_ID) return;
    // Pulisci option precedenti tranne il placeholder
    while (setupRegione.options.length > 1) {
      setupRegione.remove(1);
    }
    TOUR_ID.REGION_LIST.forEach(label => {
      const opt = document.createElement('option');
      opt.value = label;
      opt.textContent = label;
      setupRegione.appendChild(opt);
    });
  }

  // Ritorna stringa YYYY-MM-DD (data corrente) per default <input type="date">
  function todayIso() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  // Validazione del setup: ritorna { ok, error?, tourSetup? }
  function validateSetup() {
    const data = setupDataInizio.value.trim();
    const regione = setupRegione.value.trim();
    const cliente = setupCliente.value.trim();

    if (!data) {
      return { ok: false, error: 'Data inizio tour obbligatoria.' };
    }
    // Range ±90gg da oggi
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dataD = new Date(data);
    if (isNaN(dataD.getTime())) {
      return { ok: false, error: 'Data inizio tour non valida.' };
    }
    const diffDays = Math.round((dataD - today) / (1000 * 60 * 60 * 24));
    if (Math.abs(diffDays) > 90) {
      return { ok: false, error: `Data fuori range (±90 giorni). Differenza: ${diffDays} giorni.` };
    }

    // MVP2.1 (ordine fix v1.1.2): controllo conferma esplicita PRIMA di
    // qualunque altro check, così se la regione è rilevata ma non confermata
    // l'utente vede il messaggio significativo invece di "obbligatoria".
    if (_regionUIState !== 'confirmed') {
      return { ok: false, error: 'Conferma la regione del tour (tap su Conferma o Modifica).' };
    }
    if (!regione) {
      return { ok: false, error: 'Regione tour mancante.' };
    }
    const sigla = TOUR_ID.siglaForRegion(regione);
    if (!sigla) {
      return { ok: false, error: `Regione "${regione}" non riconosciuta nel mapping ISTAT.` };
    }

    // Genera Tour ID
    const gen = TOUR_ID.generate({ data_inizio: data, regione: regione });
    if (!gen.ok) {
      return { ok: false, error: gen.error || 'Generazione Tour ID fallita.' };
    }

    return {
      ok: true,
      tourSetup: {
        tour_id: gen.tour_id,
        data_inizio: data,
        regione_sigla: sigla,
        regione_label: gen.regione_label,
        cliente: cliente,
        progressivo: gen.progressivo,
        yearMonth: gen.yearMonth
      }
    };
  }

  // Listener change su input → ricalcola preview + abilita/disabilita conferma
  function onSetupChange() {
    const v = validateSetup();
    if (v.ok) {
      setupPreviewId.textContent = v.tourSetup.tour_id;
      setupPreview.classList.remove('hidden');
      setupError.classList.add('hidden');
      btnSetupConfirm.disabled = false;
    } else {
      setupPreview.classList.add('hidden');
      // Mostra errore solo se l'utente ha già iniziato a compilare (non vuoto totale)
      const isPristine = !setupDataInizio.value && !setupRegione.value && !setupCliente.value;
      if (isPristine) {
        setupError.classList.add('hidden');
      } else {
        setupError.textContent = v.error;
        setupError.classList.remove('hidden');
      }
      btnSetupConfirm.disabled = true;
    }
  }

  function onSetupConfirm() {
    const v = validateSetup();
    if (!v.ok) {
      setupError.textContent = v.error;
      setupError.classList.remove('hidden');
      return;
    }
    state.tourSetup = v.tourSetup;
    hideSetupForm();
    // Ora parte davvero l'elaborazione
    handleFile(state.file);
  }

  function onSetupCancel() {
    state.file = null;
    state.tourSetup = null;
    hideSetupForm();
    dz.classList.remove('hidden');
    fileInput.value = '';
  }

  function bindSetupListeners() {
    populateSetupRegions();
    setupDataInizio.addEventListener('change', onSetupChange);
    setupDataInizio.addEventListener('input', onSetupChange);
    setupRegione.addEventListener('change', onRegioneOverrideChange);
    setupCliente.addEventListener('input', onSetupChange);
    btnSetupConfirm.addEventListener('click', onSetupConfirm);
    btnSetupCancel.addEventListener('click', onSetupCancel);
    // MVP2.1: bottoni conferma/modifica/cambia regione
    btnRegionConfirm.addEventListener('click', onRegionConfirm);
    btnRegionModify.addEventListener('click', onRegionModify);
    btnRegionChange.addEventListener('click', onRegionChange);
  }

  // ───────── DROP ZONE handlers ─────────
  function bindDropzone() {
    dz.addEventListener('click', () => fileInput.click());
    btnPick.addEventListener('click', (e) => {
      e.stopPropagation();
      fileInput.click();
    });
    fileInput.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      // MVP2: prima del processing mostra setup tour (data + regione obbligatorie)
      if (f) showSetupForm(f);
    });
    ['dragenter', 'dragover'].forEach(ev => {
      dz.addEventListener(ev, (e) => {
        e.preventDefault();
        dz.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach(ev => {
      dz.addEventListener(ev, (e) => {
        e.preventDefault();
        dz.classList.remove('dragover');
      });
    });
    dz.addEventListener('drop', (e) => {
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      // MVP2: prima del processing mostra setup tour
      if (f) showSetupForm(f);
    });
  }

  // ───────── Progress helpers ─────────
  function setStep(n, statusMap) {
    // statusMap: { 1: 'active'|'done', …, 4: … }
    progressSteps.querySelectorAll('li').forEach(li => {
      li.classList.remove('active', 'done');
      const step = li.getAttribute('data-step');
      if (statusMap[step]) li.classList.add(statusMap[step]);
    });
    progressStage.textContent = `Fase ${n} di 4`;
    progressFill.style.width = ((n - 1) / 4 * 100 + 25) + '%';
  }
  function updateGeoDetail(text) {
    const el = document.getElementById('geo-detail');
    if (el) el.textContent = text || '';
  }

  function showProgress() {
    dz.classList.add('hidden');
    results.classList.add('hidden');
    errorBox.classList.add('hidden');
    progress.classList.remove('hidden');
  }
  function showResults() {
    dz.classList.add('hidden');
    progress.classList.add('hidden');
    errorBox.classList.add('hidden');
    results.classList.remove('hidden');
  }
  function showError(msg) {
    dz.classList.add('hidden');
    progress.classList.add('hidden');
    results.classList.add('hidden');
    errorBox.classList.remove('hidden');
    errorMessage.textContent = typeof msg === 'string' ? msg : (msg && msg.message) || String(msg);
  }
  function reset() {
    state = {
      file: null, baseName: '',
      rawRows: [],
      afterBonifica: { rows: [], issues: [], stats: {} },
      afterIstat: { rows: [], diffs: [], stats: {} },
      afterRegion: { ready: [], excluded: [], detected: null, pct: 0, distribution: {} },
      afterGeo: { rows: [], stats: {} },
      selectedRegion: null,
      tourSetup: null
    };
    progress.classList.add('hidden');
    results.classList.add('hidden');
    errorBox.classList.add('hidden');
    tourSetup.classList.add('hidden');
    dz.classList.remove('hidden');
    fileInput.value = '';
  }

  // ───────── Pipeline principale ─────────
  async function handleFile(file) {
    try {
      state.file = file;
      state.baseName = file.name;
      showProgress();

      // FASE 1: lettura + bonifica testo
      // MVP2.1: se state.rawRows è già popolato (lettura fatta in setup per
      // auto-detect regione), skippiamo la rilettura. Risparmio ~100-300ms.
      setStep(1, { 1: 'active' });
      await tick(60);
      let rawRows = state.rawRows;
      if (!rawRows || rawRows.length === 0) {
        const read = await XLSX_IO.readFile(file);
        rawRows = read.rows;
        state.rawRows = rawRows;
      }
      const b = BONIFICA.processRows(rawRows);
      state.afterBonifica = b;

      // FASE 2: ISTAT validate
      setStep(2, { 1: 'done', 2: 'active' });
      await tick(60);
      const i = await ISTAT.processRows(b.rows, (msg) => {
        // potremmo aggiornare il titolo qui se utile
      });
      state.afterIstat = i;

      // FASE 3: filter region
      setStep(3, { 1: 'done', 2: 'done', 3: 'active' });
      await tick(60);
      const detect = REGION_FILTER.detectTourRegion(i.rows);
      state.afterRegion.detected = detect.region;
      state.afterRegion.pct = detect.pct;
      state.afterRegion.distribution = detect.distribution;

      // Default: usa la regione auto-detected (se trovata), altrimenti
      // applica nessun filtro e mostra il banner per scelta manuale
      let tourRegion = detect.region;
      if (!tourRegion) {
        // Prendi la prima del distribution (più rappresentata) come default UI
        const top = Object.entries(detect.distribution).sort((a,b)=>b[1]-a[1])[0];
        tourRegion = top ? top[0] : null;
      }
      state.selectedRegion = tourRegion;
      const filt = tourRegion
        ? REGION_FILTER.filterByRegion(i.rows, tourRegion)
        : { ready: i.rows, excluded: [], regionCol: null };
      state.afterRegion.ready = filt.ready;
      state.afterRegion.excluded = filt.excluded;

      // FASE 4: geocoding (cascade Nominatim/Photon, cache IndexedDB)
      setStep(4, { 1: 'done', 2: 'done', 3: 'done', 4: 'active' });
      updateGeoDetail(`0 / ${state.afterRegion.ready.length}`);
      await tick(60);
      const geo = await GEOCODING.processRows(state.afterRegion.ready, (cur, tot, row, res) => {
        const fromCacheTag = (res.source && res.source.endsWith('_cache')) ? ' (cache)' : '';
        updateGeoDetail(`${cur} / ${tot}${fromCacheTag} · ${res.confidence}`);
        const pct = 75 + (cur / tot) * 25;
        progressFill.style.width = pct + '%';
      });
      state.afterGeo = geo;

      setStep(4, { 1: 'done', 2: 'done', 3: 'done', 4: 'done' });
      progressFill.style.width = '100%';
      updateGeoDetail(`${geo.stats.total} geocodati · high ${geo.stats.high || 0} · medium ${geo.stats.medium || 0} · low ${geo.stats.low || 0} · none ${geo.stats.none || 0}`);
      await tick(180);

      renderResults();
      showResults();

      // MVP2: registra il tour nell'indice master (localStorage in MVP2,
      // Drive in MVP3). Schema forward-compatible per archivio futuro.
      // Vedi project_admin_search_tour_ux + coordinamento-admin-field-pipeline.
      try {
        if (window.TOUR_ID && state.tourSetup && state.tourSetup.tour_id) {
          const readyCount = (state.afterGeo.rows && state.afterGeo.rows.length) || state.afterRegion.ready.length;
          // Estrai province uniche dal ready (campo "provincia" o "provincia_PV"
          // se presente, altrimenti vuoto). Lista forward-compatible.
          const provinceSet = new Set();
          (state.afterGeo.rows || state.afterRegion.ready || []).forEach(r => {
            const pv = r && (r.provincia || r.provincia_PV || r.PROVINCIA || r.Provincia);
            if (pv && String(pv).trim()) provinceSet.add(String(pv).trim().toUpperCase());
          });
          TOUR_ID.upsertEntry(state.tourSetup.tour_id, {
            tour_id: state.tourSetup.tour_id,
            data_inizio: state.tourSetup.data_inizio,
            regione: state.tourSetup.regione_sigla,
            regione_label: state.tourSetup.regione_label,
            cliente: state.tourSetup.cliente,
            province: Array.from(provinceSet).sort(),
            totale_pvr: state.rawRows.length,
            totale_pvr_bonificati: readyCount,
            stato: 'in_corso',
            percentuale_completamento: 0,
            tool_version: EXPORT.TOOL_VERSION || '1.1.0'
          });
        }
      } catch (e) {
        console.warn('[app] registrazione indice tours fallita:', e);
      }
    } catch (err) {
      console.error('[app] pipeline fallita:', err);
      showError(err);
    }
  }

  // Mini sleep per rendere visibili gli step
  function tick(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ───────── RESULTS rendering ─────────
  function renderResults() {
    const total = state.rawRows.length;
    const ready = state.afterGeo.rows.length || state.afterRegion.ready.length;
    const excluded = state.afterRegion.excluded.length;
    const diffs = state.afterIstat.diffs.length;
    const issues = state.afterBonifica.issues.length;
    const geoStats = state.afterGeo.stats || {};
    const lowGeoRows = (state.afterGeo.rows || []).filter(r =>
      r.geo_confidence === 'low' || r.geo_confidence === 'none'
    );

    resultsMeta.textContent = `File: ${state.file.name} · ${total} record letti`;

    // KPI cards
    const geoHigh = (geoStats.high || 0) + (geoStats.medium || 0);
    kpiRow.innerHTML = `
      <div class="kpi-card ok">
        <div class="kpi-label">PVR ready</div>
        <div class="kpi-value">${ready}</div>
      </div>
      <div class="kpi-card ok">
        <div class="kpi-label">Geocoding OK</div>
        <div class="kpi-value">${geoHigh}</div>
      </div>
      <div class="kpi-card warn">
        <div class="kpi-label">Correzioni ISTAT</div>
        <div class="kpi-value">${diffs}</div>
      </div>
      <div class="kpi-card warn">
        <div class="kpi-label">Anomalie testo</div>
        <div class="kpi-value">${issues}</div>
      </div>
      <div class="kpi-card crit">
        <div class="kpi-label">Outlier esclusi</div>
        <div class="kpi-value">${excluded}</div>
      </div>
      <div class="kpi-card crit">
        <div class="kpi-label">Geocoding low</div>
        <div class="kpi-value">${lowGeoRows.length}</div>
      </div>
    `;

    // Region panel
    if (state.afterRegion.detected) {
      regionPanel.classList.remove('hidden');
      regionDetected.textContent = state.afterRegion.detected;
      regionPct.textContent = `(${(state.afterRegion.pct * 100).toFixed(1)}% dei record)`;
    } else {
      // Auto-detect fallito: panel con avviso e selezione obbligatoria
      regionPanel.classList.remove('hidden');
      regionDetected.textContent = '(auto-detect fallito)';
      regionPct.textContent = 'seleziona regione manualmente';
    }
    populateRegionSelect();

    renderTab('ready');
    bindTabs();
    renderDownloads();
  }

  function populateRegionSelect() {
    const dist = state.afterRegion.distribution;
    const regions = Object.keys(dist).sort();
    regionSelect.innerHTML = regions.map(r =>
      `<option value="${escapeHtml(r)}" ${r === state.selectedRegion ? 'selected' : ''}>${escapeHtml(r)} (${dist[r]})</option>`
    ).join('');
  }

  btnRegionApply.addEventListener('click', () => {
    const sel = regionSelect.value;
    if (!sel) return;
    state.selectedRegion = sel;
    const filt = REGION_FILTER.filterByRegion(state.afterIstat.rows, sel);
    state.afterRegion.ready = filt.ready;
    state.afterRegion.excluded = filt.excluded;
    renderResults();
  });

  // ───────── Tabs ─────────
  function bindTabs() {
    tabs.querySelectorAll('.tab').forEach(t => {
      t.onclick = () => {
        tabs.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        renderTab(t.getAttribute('data-tab'));
      };
    });
    // Aggiorna i counter sui tab
    const lowGeo = (state.afterGeo.rows || []).filter(r =>
      r.geo_confidence === 'low' || r.geo_confidence === 'none'
    );
    const counts = {
      ready: (state.afterGeo.rows || state.afterRegion.ready).length,
      diff: state.afterIstat.diffs.length,
      issues: state.afterBonifica.issues.length,
      excluded: state.afterRegion.excluded.length,
      lowgeo: lowGeo.length
    };
    tabs.querySelectorAll('.tab').forEach(t => {
      const key = t.getAttribute('data-tab');
      let cnt = t.querySelector('.tab-count');
      if (!cnt) {
        cnt = document.createElement('span');
        cnt.className = 'tab-count';
        t.appendChild(cnt);
      }
      cnt.textContent = counts[key] != null ? counts[key] : '0';
    });
  }

  function renderTab(name) {
    let rows = [];
    let columns = [];
    let rowClass = (r) => '';

    if (name === 'ready') {
      rows = state.afterGeo.rows && state.afterGeo.rows.length > 0
        ? state.afterGeo.rows
        : state.afterRegion.ready;
      columns = pickReadyColumns(rows, true);
    } else if (name === 'diff') {
      rows = state.afterIstat.diffs;
      columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      rowClass = () => 'row-changed';
    } else if (name === 'issues') {
      rows = state.afterBonifica.issues;
      columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      rowClass = () => 'row-changed';
    } else if (name === 'excluded') {
      rows = state.afterRegion.excluded;
      columns = pickReadyColumns(rows);
      rowClass = () => 'row-excluded';
    } else if (name === 'lowgeo') {
      rows = (state.afterGeo.rows || []).filter(r =>
        r.geo_confidence === 'low' || r.geo_confidence === 'none'
      );
      columns = pickReadyColumns(rows, true);
      rowClass = () => 'row-excluded';
    }

    if (rows.length === 0) {
      tableHead.innerHTML = '';
      tableBody.innerHTML = `<tr><td style="padding:24px;text-align:center;color:var(--text-tertiary)">Nessun record in questa categoria</td></tr>`;
      return;
    }
    tableHead.innerHTML = '<tr>' + columns.map(c => `<th>${escapeHtml(c)}</th>`).join('') + '</tr>';
    tableBody.innerHTML = rows.slice(0, 500).map(r => {
      const cls = rowClass(r);
      const tds = columns.map(c => `<td>${escapeHtml(r[c])}</td>`).join('');
      return `<tr class="${cls}">${tds}</tr>`;
    }).join('');
    if (rows.length > 500) {
      tableBody.innerHTML += `<tr><td colspan="${columns.length}" style="padding:14px;text-align:center;color:var(--text-tertiary)">… mostro prime 500 righe. Esporta XLSX per l'elenco completo.</td></tr>`;
    }
  }

  function pickReadyColumns(rows, includeGeo) {
    if (!rows || rows.length === 0) return [];
    const headers = Object.keys(rows[0]);
    // Priorità: id + base anagrafica
    const preferred = [
      'Cod_Punto', 'cod_punto',
      'Sede', 'sede',
      'Indirizzo Sede', 'indirizzo_sede', 'Indirizzo',
      'Provincia', 'provincia'
    ];
    const picked = preferred.filter(c => headers.includes(c));
    // Geo columns aggiunte quando disponibili (post Fase 4)
    if (includeGeo) {
      ['lat', 'lng', 'geo_confidence', 'geo_source'].forEach(c => {
        if (headers.includes(c)) picked.push(c);
      });
    }
    return picked.slice(0, 9);
  }

  // ───────── Downloads ─────────
  function renderDownloads() {
    const readyRows = state.afterGeo.rows && state.afterGeo.rows.length > 0
      ? state.afterGeo.rows
      : state.afterRegion.ready;
    const lowGeoRows = (state.afterGeo.rows || []).filter(r =>
      r.geo_confidence === 'low' || r.geo_confidence === 'none'
    );
    const setup = state.tourSetup || { tour_id: '', data_inizio: '', regione_sigla: '', regione_label: '', cliente: '' };
    const items = [
      { key: 'final',    name: 'PVR ready (per Field/Admin)', count: readyRows.length, fn: () => EXPORT.exportFinal(readyRows, setup) },
      { key: 'diff',     name: 'Correzioni ISTAT (dip. dati)', count: state.afterIstat.diffs.length, fn: () => EXPORT.exportDiff(state.afterIstat.diffs, setup) },
      { key: 'issues',   name: 'Anomalie testo (dip. dati)', count: state.afterBonifica.issues.length, fn: () => EXPORT.exportIssues(state.afterBonifica.issues, setup) },
      { key: 'excluded', name: 'Outlier fuori regione (dip. dati)', count: state.afterRegion.excluded.length, fn: () => EXPORT.exportExcluded(state.afterRegion.excluded, setup) },
      { key: 'lowgeo',   name: 'Geocoding low (dip. dati)', count: lowGeoRows.length, fn: () => EXPORT.exportGeocodingLow(lowGeoRows, setup) }
    ];
    downloadRow.innerHTML = items.map(it => `
      <div class="dl-card">
        <span class="dl-name">${escapeHtml(it.name)}</span>
        <span class="dl-count">${it.count} record</span>
        <button class="btn-secondary" data-dl="${it.key}" ${it.count === 0 ? 'disabled' : ''}>Scarica</button>
      </div>
    `).join('');
    downloadRow.querySelectorAll('[data-dl]').forEach(b => {
      b.addEventListener('click', () => {
        const key = b.getAttribute('data-dl');
        const item = items.find(x => x.key === key);
        if (item) item.fn();
      });
    });
  }

  btnExportAll.addEventListener('click', () => {
    const readyRows = state.afterGeo.rows && state.afterGeo.rows.length > 0
      ? state.afterGeo.rows
      : state.afterRegion.ready;
    const lowGeoRows = (state.afterGeo.rows || []).filter(r =>
      r.geo_confidence === 'low' || r.geo_confidence === 'none'
    );
    const setup = state.tourSetup || { tour_id: '', data_inizio: '', regione_sigla: '', regione_label: '', cliente: '' };
    EXPORT.exportAll({
      ready: readyRows,
      diffs: state.afterIstat.diffs,
      issues: state.afterBonifica.issues,
      excluded: state.afterRegion.excluded,
      geocodingLow: lowGeoRows
    }, setup);
  });

  btnRestart.addEventListener('click', reset);
  btnRestartError.addEventListener('click', reset);

  // ───────── Utils ─────────
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ───────── Update toast (cold start) ─────────
  // Confronta APP_VERSION corrente con quella vista in passato (localStorage).
  // Se diversa → toast "Tool aggiornato alla versione X" per 6s. Stile coerente
  // con il toast Field (icona check verde Lucide).
  // Suono notifica: due beep brevi via Web Audio API. Stessi parametri
  // del toast Field per coerenza. Silent fail se audio non disponibile o
  // se il contesto è suspended (no user gesture su cold start).
  function playNotificationSound() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {});
      const now = ctx.currentTime;
      playBeep(ctx, now,        880, 0.12, 0.18);
      playBeep(ctx, now + 0.18, 1175, 0.12, 0.18);
      setTimeout(() => { try { ctx.close(); } catch (e) {} }, 800);
    } catch (err) { /* silent */ }
  }
  function playBeep(ctx, startAt, freq, duration, gainPeak) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(gainPeak, startAt + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startAt);
    osc.stop(startAt + duration + 0.02);
  }

  function showUpdateToast(versionLabel) {
    const ex = document.getElementById('update-toast');
    if (ex && ex.parentNode) ex.parentNode.removeChild(ex);
    playNotificationSound();
    const el = document.createElement('div');
    el.id = 'update-toast';
    el.className = 'update-toast';
    el.setAttribute('role', 'status');
    el.innerHTML = '' +
      '<span class="update-toast-icon" aria-hidden="true">' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>' +
      '</span>' +
      '<span class="update-toast-text">Tool aggiornato alla versione ' + versionLabel + '</span>';
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('is-visible'));
    setTimeout(() => {
      el.classList.remove('is-visible');
      setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 500);
    }, 6000);
  }

  function checkColdStartVersion() {
    const current = _parseVersionNumber(APP_VERSION);
    if (!current) return;
    let prev = null;
    try { prev = localStorage.getItem(LAST_SEEN_KEY); } catch (_) {}
    if (prev && prev !== current) {
      showUpdateToast(current);
    }
    try { localStorage.setItem(LAST_SEEN_KEY, current); } catch (_) {}
  }

  // ───────── Init ─────────
  // Header e footer version tag (single source of truth = APP_VERSION).
  // Header mostra solo il numero versione (es. "v1.1.2"), footer la stringa
  // estesa con data (es. "v1.1.2 · 26 mag 2026").
  const headerVersionTag = document.getElementById('header-version-tag');
  if (headerVersionTag) {
    const short = _parseVersionNumber(APP_VERSION) || APP_VERSION;
    headerVersionTag.textContent = short;
  }
  const footerVersionTag = document.getElementById('footer-version-tag');
  if (footerVersionTag) footerVersionTag.textContent = APP_VERSION;

  bindDropzone();
  bindSetupListeners();
  checkColdStartVersion();

})();
