// ═══════════════════════════════════════════════════════════════════
// geocoding.js — porting JavaScript di geocode-structured.py
// Cascade: Cache → Nominatim strutturato → Photon → Nominatim free-text
// Cache su IndexedDB (cross-sessione). Throttle conforme policy server.
// ═══════════════════════════════════════════════════════════════════

(function (global) {
  'use strict';

  const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/search';
  const PHOTON_BASE = 'https://photon.komoot.io/api';
  const NOMINATIM_THROTTLE_MS = 1100; // policy 1 req/sec
  const PHOTON_THROTTLE_MS = 300;
  const HTTP_TIMEOUT_MS = 20000;

  // ───────── IndexedDB cache ─────────
  const DB_NAME = 'pin24_geocoding_cache';
  const DB_STORE = 'cache';
  const DB_VERSION = 1;
  let _db = null;

  function openDb() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
    });
  }

  async function cacheGet(key) {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const req = tx.objectStore(DB_STORE).get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = () => resolve(null);
    });
  }

  async function cachePut(key, value) {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put({ key, value, ts: Date.now() });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  }

  function buildCacheKey(street, number, city, prov, cap) {
    return [
      String(street || '').toLowerCase().trim(),
      String(number || '').toLowerCase().trim(),
      String(city || '').toLowerCase().trim(),
      String(prov || '').toUpperCase().trim(),
      String(cap || '').trim()
    ].join('|');
  }

  // ───────── HTTP with timeout ─────────
  async function fetchJson(url) {
    const ctrl = new AbortController();
    const tmo = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'Accept': 'application/json' }
      });
      if (!resp.ok) return null;
      return await resp.json();
    } catch (_) {
      return null;
    } finally {
      clearTimeout(tmo);
    }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ───────── Parsing indirizzo: split via + civico ─────────
  const CIVICO_RE = /\b(\d+(?:\s?[/\-]\s?\d+)?(?:\s?[/\-]\s?[A-Za-z]+)?(?:\s?bis|\s?ter)?)\b/gi;
  const SNC_RE = /\bsn\.?c\b|\bsenza\s+numero\s+civico\b/i;

  function splitStreetAndNumber(indirizzo) {
    const s = String(indirizzo || '').trim();
    if (!s) return { street: '', number: '' };
    if (SNC_RE.test(s)) {
      return { street: s.replace(SNC_RE, '').replace(/[ ,]+$/, '').trim(), number: '' };
    }
    const matches = [...s.matchAll(CIVICO_RE)];
    if (matches.length === 0) return { street: s, number: '' };
    const last = matches[matches.length - 1];
    const street = (s.slice(0, last.index) + s.slice(last.index + last[0].length))
      .replace(/[ ,]+$/, '').trim();
    const number = last[0].replace(/\s+/g, '');
    return { street, number };
  }

  // ───────── Nominatim strutturato ─────────
  async function nominatimStructured(street, number, city, postalcode, state) {
    if (!city && !postalcode && !street) return null;
    const params = new URLSearchParams({
      format: 'jsonv2', countrycodes: 'it', addressdetails: '1', limit: '1'
    });
    if (street) params.set('street', number ? `${number} ${street}` : street);
    if (city) params.set('city', city);
    if (postalcode) params.set('postalcode', postalcode);
    if (state) params.set('state', state);
    const data = await fetchJson(NOMINATIM_BASE + '?' + params.toString());
    await sleep(NOMINATIM_THROTTLE_MS);
    if (!data || !Array.isArray(data) || data.length === 0) return null;
    const r = data[0];
    const lat = parseFloat(r.lat); const lng = parseFloat(r.lon);
    if (isNaN(lat) || isNaN(lng)) return null;
    const addr = r.address || {};
    const hasHouse = !!addr.house_number && number !== '';
    const matchType = hasHouse ? 'house'
      : (addr.road || addr.pedestrian || addr.footway) ? 'street'
      : (addr.city || addr.town || addr.village) ? 'city'
      : 'other';
    const importance = parseFloat(r.importance || 0) || 0;
    return { lat, lng, source: 'nominatim_struct', matchType, importance, raw: r };
  }

  // ───────── Photon free-text + filtro country IT ─────────
  async function photonSearch(query) {
    const alnum = String(query || '').replace(/[^A-Za-z0-9]/g, '');
    if (alnum.length < 3) return null;
    const qClean = String(query).replace(/[,;]+/g, ' ').replace(/\s+/g, ' ').trim();
    const params = new URLSearchParams({ q: qClean, limit: '5' });
    const data = await fetchJson(PHOTON_BASE + '?' + params.toString());
    await sleep(PHOTON_THROTTLE_MS);
    if (!data || !data.features) return null;
    const italian = data.features.filter(f => {
      const p = f.properties || {};
      const c = (p.country || '').toLowerCase();
      const cc = (p.countrycode || '').toLowerCase();
      return c === 'italy' || c === 'italia' || cc === 'it';
    });
    if (italian.length === 0) return null;
    const f = italian[0];
    const props = f.properties || {};
    const coords = (f.geometry && f.geometry.coordinates) || [];
    if (coords.length < 2) return null;
    const lng = parseFloat(coords[0]); const lat = parseFloat(coords[1]);
    if (isNaN(lat) || isNaN(lng)) return null;
    const hasHouse = !!props.housenumber;
    const v = (props.osm_value || '').toLowerCase();
    const matchType = hasHouse ? 'house'
      : ['residential','tertiary','primary','secondary','service','unclassified','pedestrian','footway'].includes(v) ? 'street'
      : ['city','town','village','hamlet'].includes(v) ? 'city'
      : 'other';
    return { lat, lng, source: 'photon', matchType, importance: 0, raw: props };
  }

  // ───────── Nominatim free-text fallback ─────────
  async function nominatimFreetext(query) {
    const params = new URLSearchParams({
      format: 'jsonv2', q: query, countrycodes: 'it',
      addressdetails: '1', limit: '1'
    });
    const data = await fetchJson(NOMINATIM_BASE + '?' + params.toString());
    await sleep(NOMINATIM_THROTTLE_MS);
    if (!data || !Array.isArray(data) || data.length === 0) return null;
    const r = data[0];
    const lat = parseFloat(r.lat); const lng = parseFloat(r.lon);
    if (isNaN(lat) || isNaN(lng)) return null;
    const addr = r.address || {};
    const matchType = addr.house_number ? 'house'
      : (addr.road || addr.pedestrian) ? 'street'
      : (addr.city || addr.town || addr.village) ? 'city'
      : 'other';
    return { lat, lng, source: 'nominatim_q', matchType, importance: parseFloat(r.importance || 0) || 0, raw: r };
  }

  // ───────── Confidence scoring ─────────
  function normLoose(s) {
    return String(s || '').toLowerCase().trim()
      .normalize('NFKD').replace(/[̀-ͯ]/g, '');
  }

  function scoreHit(hit, expectedCity) {
    let score = 0;
    if (hit.matchType === 'house') score += 0.6;
    else if (hit.matchType === 'street') score += 0.4;
    else if (hit.matchType === 'city') score += 0.2;

    const addr = (hit.raw && hit.raw.address) || hit.raw || {};
    const returnedCity = addr.city || addr.town || addr.village || addr.hamlet || '';
    if (expectedCity && returnedCity) {
      const ec = normLoose(expectedCity);
      const rc = normLoose(returnedCity);
      if (ec === rc) score += 0.25;
      else if (rc.includes(ec) || ec.includes(rc)) score += 0.1;
    }
    score += Math.min(hit.importance || 0, 0.5) * 0.2;
    score = Math.min(score, 1.0);

    const label = score >= 0.7 ? 'high'
      : score >= 0.45 ? 'medium'
      : score >= 0.2 ? 'low'
      : 'none';
    return { label, score };
  }

  // ───────── Cascade per singolo record ─────────
  async function geocodeRecord(row, cols) {
    const indirizzo = row[cols.indirizzo] || '';
    const sede = row[cols.sede] || '';
    const provincia = row[cols.provincia] || '';
    const cap = row[cols.cap] || '';
    const regione = row[cols.regione] || '';

    if (!indirizzo && !sede) {
      return { lat: null, lng: null, source: '', matchType: '', confidence: 'none', score: 0, note: 'Privo di indirizzo' };
    }

    const { street, number } = splitStreetAndNumber(indirizzo);
    const cacheKey = buildCacheKey(street, number, sede, provincia, cap);
    const cached = await cacheGet(cacheKey);
    if (cached) {
      return { ...cached, source: cached.source + '_cache' };
    }

    // 1. Nominatim strutturato
    let hit = await nominatimStructured(street, number, sede, cap, regione);
    if (!hit) {
      // 2. Photon
      const q = `${indirizzo}, ${sede}${cap ? ', ' + cap : ''}, Italia`;
      hit = await photonSearch(q);
    }
    if (!hit) {
      // 3. Nominatim free-text
      const q = `${indirizzo}, ${sede}, Italia`;
      hit = await nominatimFreetext(q);
    }

    let result;
    if (!hit) {
      result = { lat: null, lng: null, source: 'none', matchType: 'none', confidence: 'none', score: 0, note: 'Nessun geocoder ha riconosciuto l\'indirizzo' };
    } else {
      const { label, score } = scoreHit(hit, sede);
      result = {
        lat: hit.lat, lng: hit.lng,
        source: hit.source, matchType: hit.matchType,
        confidence: label, score: parseFloat(score.toFixed(3)),
        note: ''
      };
    }

    await cachePut(cacheKey, result);
    return result;
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
      indirizzo: find(['Indirizzo Sede', 'indirizzo_sede', 'Indirizzo', 'indirizzo', 'Via']),
      sede: find(['Sede', 'sede', 'Comune', 'comune']),
      provincia: find(['Provincia', 'provincia', 'Prov', 'PV']),
      cap: find(['Cap Sede', 'cap', 'CAP', 'cap_sede']),
      regione: find(['regione_PV', 'Regione', 'regione', 'Regione PV'])
    };
  }

  // ───────── Pipeline geocoding completo ─────────
  async function processRows(rows, onProgress) {
    if (!rows || rows.length === 0) {
      return { rows: [], stats: { total: 0, high: 0, medium: 0, low: 0, none: 0 } };
    }
    const headers = Object.keys(rows[0]);
    const cols = pickColumns(headers);
    if (!cols.indirizzo && !cols.sede) {
      throw new Error('Nessuna colonna indirizzo/sede per geocoding.');
    }
    const stats = { total: rows.length, high: 0, medium: 0, low: 0, none: 0, fromCache: 0 };
    const outRows = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const res = await geocodeRecord(row, cols);
      if (res.source && res.source.endsWith('_cache')) stats.fromCache++;
      stats[res.confidence] = (stats[res.confidence] || 0) + 1;
      outRows.push({
        ...row,
        lat: res.lat,
        lng: res.lng,
        geo_source: res.source,
        geo_match_type: res.matchType,
        geo_confidence: res.confidence,
        geo_score: res.score,
        geo_note: res.note
      });
      if (onProgress) onProgress(i + 1, rows.length, row, res);
    }
    return { rows: outRows, stats };
  }

  global.GEOCODING = { processRows, geocodeRecord, splitStreetAndNumber, scoreHit, pickColumns };

})(typeof window !== 'undefined' ? window : globalThis);
