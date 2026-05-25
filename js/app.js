// ═══════════════════════════════════════════════════════════════════
// app.js — orchestrazione GUI (l'unico modulo UI-coupled)
// Tutti gli altri moduli (BONIFICA, ISTAT, REGION_FILTER, XLSX_IO, EXPORT)
// sono agnostici e riusabili in futuro Admin
// ═══════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ───────── Stato sessione ─────────
  let state = {
    file: null,
    baseName: '',
    rawRows: [],
    afterBonifica: { rows: [], issues: [], stats: {} },
    afterIstat: { rows: [], diffs: [], stats: {} },
    afterRegion: { ready: [], excluded: [], detected: null, pct: 0, distribution: {} },
    afterGeo: { rows: [], stats: {} },
    selectedRegion: null
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

  // ───────── DROP ZONE handlers ─────────
  function bindDropzone() {
    dz.addEventListener('click', () => fileInput.click());
    btnPick.addEventListener('click', (e) => {
      e.stopPropagation();
      fileInput.click();
    });
    fileInput.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) handleFile(f);
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
      if (f) handleFile(f);
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
      selectedRegion: null
    };
    progress.classList.add('hidden');
    results.classList.add('hidden');
    errorBox.classList.add('hidden');
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
      setStep(1, { 1: 'active' });
      await tick(60);
      const read = await XLSX_IO.readFile(file);
      state.rawRows = read.rows;
      const b = BONIFICA.processRows(read.rows);
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
    const items = [
      { key: 'final',    name: 'PVR ready (per Field/Admin)', count: readyRows.length, fn: () => EXPORT.exportFinal(readyRows, state.baseName) },
      { key: 'diff',     name: 'Correzioni ISTAT (dip. dati)', count: state.afterIstat.diffs.length, fn: () => EXPORT.exportDiff(state.afterIstat.diffs, state.baseName) },
      { key: 'issues',   name: 'Anomalie testo (dip. dati)', count: state.afterBonifica.issues.length, fn: () => EXPORT.exportIssues(state.afterBonifica.issues, state.baseName) },
      { key: 'excluded', name: 'Outlier fuori regione (dip. dati)', count: state.afterRegion.excluded.length, fn: () => EXPORT.exportExcluded(state.afterRegion.excluded, state.baseName) },
      { key: 'lowgeo',   name: 'Geocoding low (dip. dati)', count: lowGeoRows.length, fn: () => EXPORT.exportGeocodingLow(lowGeoRows, state.baseName) }
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
    EXPORT.exportAll({
      ready: readyRows,
      diffs: state.afterIstat.diffs,
      issues: state.afterBonifica.issues,
      excluded: state.afterRegion.excluded,
      geocodingLow: lowGeoRows
    }, state.baseName);
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

  // ───────── Init ─────────
  bindDropzone();

})();
