/* Hyper-local weather PWA — no build step, no API keys.
 * Data: Open-Meteo (forecast, 15-min nowcast, air quality, geocoding),
 *       NWS api.weather.gov (alerts, nearest station obs, forecaster text — US only),
 *       IEM NEXRAD tiles (US radar) / RainViewer (global radar), BigDataCloud (reverse geocode).
 */
'use strict';
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  const store = {
    get(k, d) { try { const v = localStorage.getItem('wx.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('wx.' + k, JSON.stringify(v)); } catch { /* quota / private mode */ } },
  };

  const S = {
    units: store.get('units', /^en-US$/i.test(navigator.language || 'en-US') ? 'us' : 'metric'),
    places: store.get('places', []),
    sel: store.get('sel', 'gps'),
    loc: null, wx: null, aq: null, nws: null,
    fetchedAt: 0, loading: false, token: 0,
  };

  /* ---------------- Units & formatting ---------------- */
  const us = () => S.units === 'us';
  const U = {
    t: c => (us() ? c * 9 / 5 + 32 : c),
    wind: k => (us() ? k / 1.609344 : k), windU: () => (us() ? 'mph' : 'km/h'),
    pr: mm => (us() ? mm / 25.4 : mm), prU: () => (us() ? 'in' : 'mm'),
    vis: m => (us() ? m / 1609.344 : m / 1000), visU: () => (us() ? 'mi' : 'km'),
    pres: h => (us() ? h * 0.02953 : h), presU: () => (us() ? 'inHg' : 'hPa'),
    dist: km => (us() ? km / 1.609344 : km), distU: () => (us() ? 'mi' : 'km'),
  };
  const ok = v => v != null && !Number.isNaN(v);
  const fT = c => (ok(c) ? Math.round(U.t(c)) + '°' : '--');
  const fW = k => (ok(k) ? Math.round(U.wind(k)) : '--');
  const fP = mm => (ok(mm) ? (us() ? U.pr(mm).toFixed(2) : U.pr(mm).toFixed(1)) : '--');

  let TZ;
  const fmtCache = {};
  const fmt = (key, opts) => (fmtCache[key + TZ] ||= new Intl.DateTimeFormat(undefined, { ...opts, timeZone: TZ }));
  const hourL = ts => fmt('h', { hour: 'numeric' }).format(ts * 1000).replace(/\s/g, '').replace(/^0/, '');
  const timeL = ts => fmt('hm', { hour: 'numeric', minute: '2-digit' }).format(ts * 1000);
  const dayL = ts => fmt('wd', { weekday: 'short' }).format(ts * 1000);
  const ago = ms => {
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h} hr ${m % 60 ? (m % 60) + ' min ' : ''}ago` : `${Math.floor(h / 24)} d ago`;
  };
  const dur = mins => {
    mins = Math.max(5, Math.round(mins / 5) * 5);
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60), m = mins % 60;
    return m ? `${h} hr ${m} min` : `${h} hr`;
  };

  /* ---------------- Weather codes & icons ---------------- */
  const WMO = {
    0: 'Clear', 1: 'Mostly Clear', 2: 'Partly Cloudy', 3: 'Cloudy', 45: 'Fog', 48: 'Freezing Fog',
    51: 'Light Drizzle', 53: 'Drizzle', 55: 'Heavy Drizzle', 56: 'Freezing Drizzle', 57: 'Freezing Drizzle',
    61: 'Light Rain', 63: 'Rain', 65: 'Heavy Rain', 66: 'Freezing Rain', 67: 'Freezing Rain',
    71: 'Light Snow', 73: 'Snow', 75: 'Heavy Snow', 77: 'Snow Grains',
    80: 'Showers', 81: 'Rain Showers', 82: 'Heavy Showers', 85: 'Snow Showers', 86: 'Heavy Snow Showers',
    95: 'Thunderstorms', 96: 'Thunderstorms & Hail', 99: 'Severe Thunderstorms',
  };
  const condText = (code, day) => (code <= 1 && !day ? (code === 0 ? 'Clear' : 'Mostly Clear') : code === 0 && day ? 'Sunny' : code === 1 && day ? 'Mostly Sunny' : WMO[code] || '—');
  const isSnow = c => (c >= 71 && c <= 77) || c === 85 || c === 86;
  const isRain = c => (c >= 51 && c <= 67) || (c >= 80 && c <= 82);
  const isStorm = c => c >= 95;

  const COL = { sun: '#FFC83D', moon: '#E9EDF8', cloud: '#F4F7FB', cloud2: '#AEB9CB', rain: '#5AB8FF', snow: '#fff', bolt: '#FFD43B', fog: '#D3DAE4' };
  const CLOUD = 'M20 46h27a11 11 0 0 0 1.5-21.9A15 15 0 0 0 20.2 20 13 13 0 0 0 20 46z';
  const sunG = (cx, cy, r) => {
    let rays = '';
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4, c = Math.cos(a), s = Math.sin(a);
      rays += `M${(cx + c * (r + 4)).toFixed(1)} ${(cy + s * (r + 4)).toFixed(1)}L${(cx + c * (r + 8.5)).toFixed(1)} ${(cy + s * (r + 8.5)).toFixed(1)}`;
    }
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${COL.sun}"/><path d="${rays}" stroke="${COL.sun}" stroke-width="3" stroke-linecap="round"/>`;
  };
  const moonG = (cx, cy, r) =>
    `<path transform="rotate(-25 ${cx} ${cy})" d="M${cx} ${cy - r}A${r} ${r} 0 1 0 ${cx} ${cy + r}A${r * 0.62} ${r} 0 1 1 ${cx} ${cy - r}z" fill="${COL.moon}"/>`;
  const cloudG = (tf, fill = COL.cloud) => `<path transform="${tf}" d="${CLOUD}" fill="${fill}"/>`;
  const drops = (n, col = COL.rain, len = 9) => {
    const xs = n === 2 ? [27, 39] : [22, 32, 42];
    return xs.map((x, i) => `<path d="M${x} ${44 + (i % 2) * 4}l-3 ${len}" stroke="${col}" stroke-width="3" stroke-linecap="round"/>`).join('');
  };
  const flakes = () => [[22, 47], [32, 53], [42, 47], [27, 58], [37, 59]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.6" fill="${COL.snow}"/>`).join('');
  const PRECIP_CLOUD = 'translate(4 -4) scale(.88)';

  function icon(code, day = 1) {
    let g = '';
    if (code <= 1) g = day ? sunG(32, 32, 12) : moonG(32, 32, 16);
    else if (code === 2) g = (day ? sunG(23, 22, 9) : moonG(24, 21, 12)) + cloudG('translate(10 12) scale(.8)');
    else if (code === 3) g = cloudG('translate(-2 -6) scale(.9)', COL.cloud2) + cloudG('translate(6 8) scale(.85)');
    else if (code === 45 || code === 48)
      g = cloudG('translate(4 -6) scale(.88)', COL.cloud2) + `<path d="M12 46h40M18 53h34M12 60h30" stroke="${COL.fog}" stroke-width="3.2" stroke-linecap="round"/>`;
    else if (code >= 51 && code <= 57) g = cloudG(PRECIP_CLOUD) + drops(3, COL.rain, 5) + (code >= 56 ? `<circle cx="37" cy="58" r="2.4" fill="#fff"/>` : '');
    else if (code === 66 || code === 67) g = cloudG(PRECIP_CLOUD) + drops(2) + `<circle cx="33" cy="57" r="2.6" fill="#fff"/>`;
    else if (isRain(code)) g = (code >= 80 && day ? sunG(16, 14, 7) : '') + cloudG(PRECIP_CLOUD) + drops(3);
    else if (isSnow(code)) g = cloudG(PRECIP_CLOUD) + flakes();
    else if (isStorm(code))
      g = cloudG(PRECIP_CLOUD, '#9AA6BA') + `<path d="M35 36l-9 14h7l-4 12 13-17h-7l4-9z" fill="${COL.bolt}"/>` + `<path d="M20 44l-3 9M46 44l-3 9" stroke="${COL.rain}" stroke-width="3" stroke-linecap="round"/>`;
    else g = cloudG('translate(0 0)');
    return `<svg viewBox="0 0 64 64" aria-hidden="true">${g}</svg>`;
  }

  const PIN = '<svg viewBox="0 0 24 24"><path d="M21 3L3 10.5l7.5 2.5L13 21z"/></svg>';

  /* ---------------- Color helpers ---------------- */
  const TSTOPS = [[-20, [167, 139, 250]], [-5, [96, 165, 250]], [5, [56, 189, 248]], [12, [45, 212, 191]], [18, [163, 230, 53]], [24, [250, 204, 21]], [30, [251, 146, 60]], [37, [239, 68, 68]]];
  function tColor(c) {
    if (c <= TSTOPS[0][0]) return `rgb(${TSTOPS[0][1]})`;
    for (let i = 1; i < TSTOPS.length; i++) {
      const [t1, c1] = TSTOPS[i];
      if (c <= t1) {
        const [t0, c0] = TSTOPS[i - 1], f = (c - t0) / (t1 - t0);
        return `rgb(${c0.map((v, j) => Math.round(v + (c1[j] - v) * f))})`;
      }
    }
    return `rgb(${TSTOPS.at(-1)[1]})`;
  }

  /* ---------------- Networking ---------------- */
  async function getJSON(url, timeout = 15000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  const CURRENT = 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,dew_point_2m,visibility,uv_index';
  const HOURLY = 'temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,is_day,wind_speed_10m,wind_gusts_10m,uv_index,pressure_msl';
  const DAILY = 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,daylight_duration,uv_index_max,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max';
  function forecastURL(lat, lon, minutely) {
    const p = new URLSearchParams({
      latitude: lat.toFixed(4), longitude: lon.toFixed(4), timezone: 'auto', timeformat: 'unixtime',
      current: CURRENT, hourly: HOURLY, daily: DAILY, forecast_days: 10, past_hours: 24, forecast_hours: 48,
    });
    if (minutely) { p.set('minutely_15', 'precipitation,snowfall,weather_code'); p.set('forecast_minutely_15', '13'); }
    return 'https://api.open-meteo.com/v1/forecast?' + p;
  }
  const aqURL = (lat, lon) => `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=us_aqi,european_aqi,pm2_5,pm10,ozone&timezone=auto`;

  function likelyUS(lat, lon) {
    return (lat > 24 && lat < 50 && lon > -125.5 && lon < -66) || // CONUS
      (lat > 51 && lat < 72 && lon > -170 && lon < -129) ||       // Alaska
      (lat > 18.5 && lat < 22.5 && lon > -161 && lon < -154) ||   // Hawaii
      (lat > 17.5 && lat < 18.6 && lon > -67.5 && lon < -65);     // Puerto Rico
  }
  const inConus = (lat, lon) => lat > 23 && lat < 51 && lon > -127 && lon < -65;

  function haversine(a1, o1, a2, o2) {
    const R = 6371, r = Math.PI / 180, dA = (a2 - a1) * r, dO = (o2 - o1) * r;
    const h = Math.sin(dA / 2) ** 2 + Math.cos(a1 * r) * Math.cos(a2 * r) * Math.sin(dO / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  async function reverseGeocode(lat, lon) {
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    const cache = store.get('rgeo', {});
    if (cache[key]) return cache[key];
    const g = await getJSON(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
    const name = g.locality || g.city || g.principalSubdivision || 'My Location';
    const sub = [g.city && g.city !== name ? g.city : '', g.principalSubdivisionCode?.split('-')[1] || g.principalSubdivision, g.countryCode !== 'US' ? g.countryName : '']
      .filter(Boolean).join(', ');
    const res = { name, sub, cc: g.countryCode };
    const keys = Object.keys(cache);
    if (keys.length > 30) delete cache[keys[0]];
    cache[key] = res;
    store.set('rgeo', cache);
    return res;
  }

  async function loadNWS(lat, lon) {
    const ll = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    const alertsP = getJSON(`https://api.weather.gov/alerts/active?point=${ll}`).catch(() => null);
    const out = { alerts: [], obs: null, periods: [], city: null };
    try {
      const pt = (await getJSON(`https://api.weather.gov/points/${ll}`)).properties;
      const rl = pt.relativeLocation?.properties;
      if (rl) out.city = `${rl.city}, ${rl.state}`;
      const [stations, fc] = await Promise.all([
        getJSON(pt.observationStations).catch(() => null),
        getJSON(pt.forecast).catch(() => null),
      ]);
      out.periods = fc?.properties?.periods?.slice(0, 3) || [];
      for (const f of (stations?.features || []).slice(0, 4)) {
        try {
          const id = f.properties.stationIdentifier;
          const p = (await getJSON(`https://api.weather.gov/stations/${id}/observations/latest`)).properties;
          if (p.temperature?.value == null) continue;
          const age = Date.now() - Date.parse(p.timestamp);
          if (!(age < 3 * 3600e3)) continue;
          const [slon, slat] = f.geometry.coordinates;
          out.obs = {
            id, name: f.properties.name, km: haversine(lat, lon, slat, slon), at: Date.parse(p.timestamp),
            temp: p.temperature.value, text: p.textDescription, dew: p.dewpoint?.value, rh: p.relativeHumidity?.value,
            wind: p.windSpeed?.value, gust: p.windGust?.value, dir: p.windDirection?.value, pres: p.barometricPressure?.value,
          };
          break;
        } catch { /* try next station */ }
      }
    } catch { /* points can 404 for marine / edge locations */ }
    const al = await alertsP;
    out.alerts = (al?.features || []).filter(f => f.properties?.status !== 'Test');
    return out;
  }

  /* ---------------- Location ---------------- */
  function resolveLocation() {
    if (S.sel !== 'gps') {
      const p = S.places.find(p => p.id === S.sel);
      if (p) return Promise.resolve({ ...p, gps: false });
      S.sel = 'gps'; store.set('sel', 'gps');
    }
    const last = store.get('lastGps', null);
    return new Promise((res, rej) => {
      if (!navigator.geolocation) return last ? res({ ...last, stale: true }) : rej(new Error('nogeo'));
      navigator.geolocation.getCurrentPosition(pos => {
        const { latitude: lat, longitude: lon, accuracy } = pos.coords;
        const near = last && haversine(lat, lon, last.lat, last.lon) < 0.3;
        const l = { id: 'gps', gps: true, lat, lon, acc: accuracy, name: near ? last.name : 'My Location', sub: near ? last.sub : '' };
        store.set('lastGps', l);
        res(l);
      }, err => (last ? res({ ...last, stale: true }) : rej(err)),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
    });
  }

  /* ---------------- Main refresh ---------------- */
  async function refresh() {
    if (S.loading) return;
    S.loading = true;
    const token = ++S.token;
    setSpin(true);
    try {
      let loc;
      try { loc = await resolveLocation(); } catch {
        openSheet('Location access is off or unavailable. Search for a place, or enable Location for Safari in Settings → Privacy.');
        return;
      }
      if (token !== S.token) return;
      const sameSpot = S.loc && S.loc.id === loc.id && haversine(S.loc.lat, S.loc.lon, loc.lat, loc.lon) < 0.3;
      if (!sameSpot) { S.nws = null; S.aq = null; }
      S.loc = loc;
      renderLoc();
      const { lat, lon } = loc;
      const nwsOK = likelyUS(lat, lon);
      const wxP = getJSON(forecastURL(lat, lon, true)).catch(() => getJSON(forecastURL(lat, lon, false)));
      const aqP = getJSON(aqURL(lat, lon)).catch(() => null);
      const geoP = loc.gps ? reverseGeocode(lat, lon).catch(() => null) : Promise.resolve(null);
      const nwsP = nwsOK ? loadNWS(lat, lon).catch(() => null) : Promise.resolve(null);

      const wx = await wxP;
      if (token !== S.token) return;
      S.wx = wx; S.fetchedAt = Date.now();
      document.body.classList.remove('loading');
      renderAll();
      Radar.setLocation(lat, lon);

      aqP.then(aq => { if (token === S.token) { S.aq = aq || false; renderTiles(); snapshot(); } });
      geoP.then(g => {
        if (token !== S.token || !g) return;
        Object.assign(S.loc, { name: g.name, sub: g.sub });
        store.set('lastGps', { ...store.get('lastGps', {}), name: g.name, sub: g.sub });
        renderLoc(); snapshot();
      });
      nwsP.then(n => {
        if (token !== S.token || !n) return;
        S.nws = n;
        if (S.loc.gps && S.loc.name === 'My Location' && n.city) { S.loc.name = n.city.split(',')[0]; S.loc.sub = n.city.split(',')[1]?.trim(); renderLoc(); }
        renderAlerts(); renderNWS(); renderTiles(); Radar.setAlerts(n.alerts);
        snapshot();
      });
      snapshot();
    } catch (e) {
      console.error(e);
      toast(navigator.onLine === false ? 'You’re offline — showing last update' : 'Couldn’t update weather. Pull down to retry.');
    } finally {
      if (token === S.token) { S.loading = false; setSpin(false); }
    }
  }

  function snapshot() {
    store.set('snap', { loc: S.loc, wx: S.wx, aq: S.aq, nws: S.nws, at: S.fetchedAt });
  }

  /* ---------------- Rendering ---------------- */
  function nowIdx(times) {
    const now = Date.now() / 1000;
    const i = times.findIndex(t => t + 3600 > now);
    return i < 0 ? times.length - 1 : i;
  }

  function renderAll() {
    if (!S.wx) return;
    TZ = S.wx.timezone;
    renderLoc(); renderHero(); renderAlerts(); renderNowcast(); renderHourly(); renderDaily(); renderNWS(); renderTiles(); renderFooter();
    $('#btn-units').textContent = us() ? '°F' : '°C';
  }

  function renderLoc() {
    const l = S.loc;
    if (!l) return;
    $('#loc-name').innerHTML = (l.gps ? PIN : '') + `<span>${esc(l.name)}</span>`;
    $('#loc-sub').textContent = l.sub || '';
    $('#mini-name').textContent = l.name;
    const chip = $('#loc-chip');
    if (l.gps) {
      chip.hidden = false;
      chip.classList.toggle('stale', !!l.stale);
      const acc = l.acc ? (us() ? `±${Math.round(l.acc * 3.281).toLocaleString()} ft` : `±${Math.round(l.acc).toLocaleString()} m`) : '';
      chip.innerHTML = `<i></i>${l.stale ? 'Last known location' : 'Precise location'}${acc && !l.stale ? ' · ' + acc : ''} · ${l.lat.toFixed(3)}, ${l.lon.toFixed(3)}`;
    } else chip.hidden = true;
  }

  function themeFor(code, day) {
    if (isStorm(code)) return 'storm';
    if (isSnow(code)) return 'snow';
    if (isRain(code)) return day ? 'rain' : 'rain-night';
    if (code === 45 || code === 48) return 'fog';
    if (code === 3) return day ? 'cloudy-day' : 'cloudy-night';
    if (code === 2) return day ? 'partly-day' : 'partly-night';
    return day ? 'clear-day' : 'clear-night';
  }

  function renderHero() {
    const c = S.wx.current, d = S.wx.daily;
    $('#temp-now').textContent = fT(c.temperature_2m);
    $('#mini-temp').textContent = fT(c.temperature_2m);
    $('#cond-now').textContent = condText(c.weather_code, c.is_day);
    $('#hilo').innerHTML = `H:${fT(d.temperature_2m_max[0])}&nbsp;&nbsp;L:${fT(d.temperature_2m_min[0])}<span class="feels"> · Feels ${fT(c.apparent_temperature)}</span>`;
    const theme = themeFor(c.weather_code, c.is_day);
    document.body.dataset.theme = theme;
    const meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.content = getComputedStyle(document.body).getPropertyValue('--g1').trim() || '#0b1026';
    FX.set(c.weather_code, c.is_day, c.precipitation, c.cloud_cover);
  }

  function renderAlerts() {
    const box = $('#alerts');
    const list = S.nws?.alerts || [];
    box.innerHTML = list.map(f => {
      const p = f.properties;
      const sev = /extreme|severe/i.test(p.severity) ? '' : /moderate/i.test(p.severity) ? 'moderate' : 'minor';
      const until = p.ends || p.expires;
      return `<details class="alert ${sev}"><summary>
        <svg viewBox="0 0 24 24"><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/></svg>
        <div><div class="a-title">${esc(p.event)}</div><div class="a-sub">${until ? 'Until ' + esc(fmt('ad', { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(until))) + ' · ' : ''}${esc(p.senderName || 'NWS')}</div></div>
      </summary><div class="a-body">${esc(p.headline || '')}\n\n${esc(p.description || '')}${p.instruction ? `<b>What to do</b>${esc(p.instruction)}` : ''}</div></details>`;
    }).join('');
  }

  /* 15-minute precipitation for the next ~3 hours */
  function precipSeries() {
    const now = Date.now() / 1000;
    const m = S.wx.minutely_15;
    if (m?.time?.length) {
      const out = [];
      m.time.forEach((t, i) => { if (t + 900 > now && out.length < 12) out.push({ t, p: m.precipitation[i] ?? 0, snow: (m.snowfall?.[i] ?? 0) > 0 || isSnow(m.weather_code?.[i]) }); });
      if (out.length >= 8) return out;
    }
    const h = S.wx.hourly, i0 = nowIdx(h.time), out = [];
    for (let i = i0; i < i0 + 3 && i < h.time.length; i++)
      for (let q = 0; q < 4; q++) out.push({ t: h.time[i] + q * 900, p: (h.precipitation[i] ?? 0) / 4, snow: isSnow(h.weather_code[i]) });
    return out.filter(s => s.t + 900 > now).slice(0, 12);
  }

  function renderNowcast() {
    const s = precipSeries();
    const now = Date.now() / 1000;
    const TH = 0.02; // mm per 15 min ≈ trace
    const wet = s.map(v => v.p >= TH);
    const kind = s.some((v, i) => wet[i] && v.snow) ? 'Snow' : 'Rain';
    const minsTo = i => (s[i].t - now) / 60;
    let txt;
    if (!s.length) txt = 'Precipitation outlook unavailable';
    else if (wet[0]) {
      const end = wet.indexOf(false);
      const max = Math.max(...s.map(v => v.p)) * 4;
      const intensity = max > 7.6 ? 'Heavy ' : max < 1 ? 'Light ' : '';
      txt = end === -1 ? `${intensity}${kind.toLowerCase()} continuing for the next 3 hours` : `${kind} ending in about ${dur(minsTo(end))}`;
      txt = txt[0].toUpperCase() + txt.slice(1);
    } else {
      const st = wet.indexOf(true);
      if (st === -1) {
        const h = S.wx.hourly, i0 = nowIdx(h.time);
        const later = h.time.slice(i0 + 3, i0 + 12).findIndex((t, k) => (h.precipitation_probability[i0 + 3 + k] ?? 0) >= 50);
        txt = later === -1 ? 'No precipitation expected in the next 3 hours' : `Dry for now — ${isSnow(h.weather_code[i0 + 3 + later]) ? 'snow' : 'rain'} likely around ${timeL(h.time[i0 + 3 + later])}`;
      } else txt = `${kind} starting in about ${dur(minsTo(st))}`;
    }
    $('#nowcast-summary').textContent = txt;

    // chart
    const W = 320, H = 84, top = 4, base = 66, n = 12, bw = W / n;
    const scale = v => Math.sqrt(clamp(v * 4 / 10, 0, 1)); // mm/h, sqrt so drizzle is visible; 10 mm/h tops out
    let bars = '';
    s.forEach((v, i) => {
      const h = v.p >= TH ? Math.max(3, scale(v.p) * (base - top)) : 2;
      const col = v.p >= TH ? (v.snow ? '#e8f1ff' : v.p * 4 > 7.6 ? '#2f7cff' : '#5ab8ff') : 'rgba(255,255,255,.18)';
      bars += `<rect x="${(i * bw + 2).toFixed(1)}" y="${(base - h).toFixed(1)}" width="${(bw - 4).toFixed(1)}" height="${h.toFixed(1)}" rx="2.5" fill="${col}"/>`;
    });
    const grid = [['Heavy', scale(7.6 / 4)], ['Med', scale(2.5 / 4)], ['Light', scale(0.5 / 4)]]
      .map(([l, f]) => { const y = (base - f * (base - top)).toFixed(1); return `<line class="grid" x1="0" x2="${W}" y1="${y}" y2="${y}"/><text x="${W + 4}" y="${+y + 3}">${l}</text>`; }).join('');
    const labels = ['Now', '1h', '2h', '3h'].map((l, i) => `<text x="${Math.min(i * 4 * bw, W - 14)}" y="${H - 2}">${l}</text>`).join('');
    $('#nowcast-chart').innerHTML = `<svg viewBox="0 0 ${W + 34} ${H}" preserveAspectRatio="xMinYMid meet">${grid}${bars}${labels}</svg>`;
  }

  function renderHourly() {
    const h = S.wx.hourly, d = S.wx.daily, i0 = nowIdx(h.time);
    const end = Math.min(h.time.length, i0 + 30);
    const sunEvents = [];
    d.time.forEach((_, k) => { sunEvents.push({ t: d.sunrise[k], kind: 'Sunrise' }, { t: d.sunset[k], kind: 'Sunset' }); });
    let html = '';
    for (let i = i0; i < end; i++) {
      const t = h.time[i], pop = h.precipitation_probability[i];
      html += `<div class="h"><div class="h-t ${i === i0 ? 'now' : ''}">${i === i0 ? 'Now' : hourL(t)}</div>
        ${icon(h.weather_code[i], h.is_day[i])}<div class="h-pop">${pop >= 20 ? Math.round(pop / 5) * 5 + '%' : ''}</div>
        <div class="h-v">${fT(i === i0 ? S.wx.current.temperature_2m : h.temperature_2m[i])}</div></div>`;
      for (const ev of sunEvents) {
        if (ev.t > Math.max(t, i === i0 ? Date.now() / 1000 : 0) && ev.t < t + 3600 && i + 1 < end) {
          const ic = ev.kind === 'Sunrise'
            ? `<svg viewBox="0 0 64 64"><path d="M14 46h36" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M20 46a12 12 0 0 1 24 0z" fill="${COL.sun}"/><path d="M32 22v-8M26 18l6-6 6 6" stroke="${COL.sun}" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`
            : `<svg viewBox="0 0 64 64"><path d="M14 46h36" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M20 46a12 12 0 0 1 24 0z" fill="#FB923C"/><path d="M32 12v8M26 16l6 6 6-6" stroke="#FB923C" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`;
          html += `<div class="h sun"><div class="h-t">${timeL(ev.t).replace(/\s/g, '')}</div>${ic}<div class="h-pop"></div><div class="h-v">${ev.kind}</div></div>`;
        }
      }
    }
    $('#hourly').innerHTML = html;

    // A one-line headline like the iOS app
    const c = S.wx.current;
    const wetCode = k => isRain(h.weather_code[k]) || isSnow(h.weather_code[k]) || isStorm(h.weather_code[k]);
    const kindAt = k => (isStorm(h.weather_code[k]) ? 'Thunderstorms' : isSnow(h.weather_code[k]) ? 'Snow' : 'Rain');
    const win = [];
    for (let k = i0 + 1; k < Math.min(h.time.length, i0 + 13); k++) win.push(k);
    let sum;
    if (wetCode(i0)) {
      const dry = win.find(k => !wetCode(k));
      sum = dry ? `${kindAt(i0)} ending around ${hourL(h.time[dry])}.` : `${kindAt(i0)} continuing through the next 12 hours.`;
    } else {
      const wet = win.find(k => wetCode(k) && (h.precipitation_probability[k] ?? 0) >= 40);
      const shift = win.find(k => themeFor(h.weather_code[k], 1) !== themeFor(c.weather_code, 1));
      sum = wet ? `${kindAt(wet)} likely around ${hourL(h.time[wet])}.`
        : shift ? `${condText(h.weather_code[shift], h.is_day[shift])} conditions expected around ${hourL(h.time[shift])}.`
          : `${condText(c.weather_code, c.is_day)} conditions will continue for the next several hours.`;
    }
    const gustMax = Math.max(...h.wind_gusts_10m.slice(i0, i0 + 12).filter(ok));
    if (gustMax > 40) sum += ` Wind gusts up to ${fW(gustMax)} ${U.windU()}.`;
    $('#hourly-summary').textContent = sum;
  }

  function renderDaily() {
    const d = S.wx.daily;
    const lo = Math.min(...d.temperature_2m_min.filter(ok)), hi = Math.max(...d.temperature_2m_max.filter(ok));
    const span = Math.max(1, hi - lo);
    const cur = S.wx.current.temperature_2m;
    $('#daily').innerHTML = d.time.map((t, i) => {
      const mn = d.temperature_2m_min[i], mx = d.temperature_2m_max[i];
      const l = (mn - lo) / span * 100, w = (mx - mn) / span * 100;
      const pop = d.precipitation_probability_max[i];
      const dot = i === 0 && ok(cur) ? `<i style="left:${clamp((cur - lo) / span * 100, 0, 100)}%"></i>` : '';
      return `<div class="d"><div class="d-row">
        <div class="d-day">${i === 0 ? 'Today' : dayL(t)}</div>
        <div class="d-ic">${icon(d.weather_code[i], 1)}<span>${pop >= 20 ? Math.round(pop / 5) * 5 + '%' : ''}</span></div>
        <div class="d-lo">${fT(mn)}</div>
        <div class="d-bar"><span style="left:${l}%;width:${Math.max(w, 2)}%;background:linear-gradient(90deg,${tColor(mn)},${tColor(mx)})"></span>${dot}</div>
        <div class="d-hi">${fT(mx)}</div></div>
        <div class="d-more">
          <div>Precip<b>${fP(d.precipitation_sum[i])} ${U.prU()}</b></div>
          <div>Wind<b>${fW(d.wind_speed_10m_max[i])} ${U.windU()}</b></div>
          <div>UV<b>${ok(d.uv_index_max[i]) ? Math.round(d.uv_index_max[i]) : '--'}</b></div>
          <div>Sun<b>${timeL(d.sunrise[i]).replace(/\s?[AP]M/i, '')}–${timeL(d.sunset[i]).replace(/\s?[AP]M/i, '')}</b></div>
        </div></div>`;
    }).join('');
  }

  function renderNWS() {
    const p = S.nws?.periods || [];
    $('#card-nws').hidden = !p.length;
    $('#nws-periods').innerHTML = p.slice(0, 2).map(x => `<div class="nws-p"><b>${esc(x.name)}</b><p>${esc(x.detailedForecast)}</p></div>`).join('');
  }

  /* ---- Detail tiles ---- */
  const tile = (title, svgPath, body, cls = '') =>
    `<section class="card tile ${cls}"><h3 class="card-h"><svg viewBox="0 0 24 24"><path d="${svgPath}"/></svg>${title}</h3>${body}</section>`;
  const IC = {
    wind: 'M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h8',
    feels: 'M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z',
    uv: 'M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4M8 12a4 4 0 1 0 8 0 4 4 0 0 0-8 0',
    aqi: 'M4 15h10a3 3 0 1 1-3 3M4 11h14a3 3 0 1 0-3-3M4 7h6',
    hum: 'M12 3c3 4 6 7.5 6 11a6 6 0 0 1-12 0c0-3.5 3-7 6-11z',
    vis: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
    pres: 'M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18zM12 12l4-4',
    precip: 'M7 4c2 3 4 5 4 7.5a4 4 0 0 1-8 0C3 9 5 7 7 4zM17 10c1.5 2 3 3.8 3 5.5a3 3 0 0 1-6 0c0-1.7 1.5-3.5 3-5.5z',
    sun: 'M3 18h18M7 18a5 5 0 0 1 10 0M12 4v4M5 9l2 2M19 9l-2 2',
    moon: 'M20 14A8 8 0 1 1 10 4a6 6 0 0 0 10 10z',
    station: 'M12 21V10M8 21h8M12 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM5.6 3.6a8 8 0 0 0 0 11.3M18.4 3.6a8 8 0 0 1 0 11.3',
  };

  function renderTiles() {
    if (!S.wx) return;
    const c = S.wx.current, h = S.wx.hourly, d = S.wx.daily, i0 = nowIdx(h.time);
    const out = [];
    const nowS = Date.now() / 1000;

    // Wind
    const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    const wd = c.wind_direction_10m ?? 0, ws = c.wind_speed_10m;
    const beau = ws < 2 ? 'Calm' : ws < 12 ? 'Light breeze' : ws < 29 ? 'Moderate breeze' : ws < 50 ? 'Strong wind' : ws < 75 ? 'Gale' : 'Storm-force wind';
    let ticks = '';
    for (let a = 0; a < 360; a += 15) {
      const r = a * Math.PI / 180, r1 = a % 90 ? 45 : 42;
      ticks += `<line x1="${60 + Math.sin(r) * r1}" y1="${60 - Math.cos(r) * r1}" x2="${60 + Math.sin(r) * 48}" y2="${60 - Math.cos(r) * 48}" stroke="rgba(255,255,255,${a % 90 ? .25 : .6})" stroke-width="${a % 90 ? 1 : 2}"/>`;
    }
    const compass = `<svg class="dial" viewBox="0 0 120 120">${ticks}
      ${['N', 'E', 'S', 'W'].map((l, k) => `<text x="${60 + Math.sin(k * Math.PI / 2) * 36}" y="${64 - Math.cos(k * Math.PI / 2) * 36}" fill="rgba(255,255,255,.7)" font-size="10" font-weight="600" text-anchor="middle">${l}</text>`).join('')}
      <g transform="rotate(${wd + 180} 60 60)"><path d="M60 12l6 14h-12z" fill="#fff"/><line x1="60" y1="24" x2="60" y2="100" stroke="#fff" stroke-width="2.5"/><circle cx="60" cy="100" r="4" fill="none" stroke="#fff" stroke-width="2.5"/></g>
      <circle cx="60" cy="60" r="20" fill="rgba(20,30,50,.85)"/>
      <text x="60" y="61" fill="#fff" font-size="17" font-weight="600" text-anchor="middle">${fW(ws)}</text>
      <text x="60" y="73" fill="rgba(255,255,255,.7)" font-size="8.5" text-anchor="middle">${U.windU()}</text></svg>`;
    out.push(tile('Wind', IC.wind, `${compass}<div class="note">${beau} from the ${dirs[Math.round(wd / 22.5) % 16]}${ok(c.wind_gusts_10m) ? ` · gusts ${fW(c.wind_gusts_10m)} ${U.windU()}` : ''}</div>`));

    // Feels like
    const diff = c.apparent_temperature - c.temperature_2m;
    const feelsNote = Math.abs(diff) < 1.5 ? 'Similar to the actual temperature.'
      : diff < 0 ? (c.wind_speed_10m > 10 ? 'Wind is making it feel cooler.' : 'Feels cooler than the actual temperature.')
        : (c.relative_humidity_2m > 50 ? 'Humidity is making it feel warmer.' : 'Sunshine is making it feel warmer.');
    out.push(tile('Feels like', IC.feels, `<div class="big">${fT(c.apparent_temperature)}</div><div class="note">Actual ${fT(c.temperature_2m)}. ${feelsNote}</div>`));

    // UV
    const uv = ok(c.uv_index) ? c.uv_index : h.uv_index[i0] ?? 0;
    const uvCat = uv < 3 ? 'Low' : uv < 6 ? 'Moderate' : uv < 8 ? 'High' : uv < 11 ? 'Very High' : 'Extreme';
    let uvNote = 'Low for the rest of the day.';
    const todayEnd = d.time[1] ?? nowS + 86400;
    const highHours = h.time.map((t, k) => [t, h.uv_index[k]]).filter(([t, v]) => t >= h.time[i0] && t < todayEnd && v >= 3);
    if (highHours.length) uvNote = uv >= 3 ? `Use sun protection until ${hourL(highHours.at(-1)[0] + 3600)}.` : `Use sun protection ${hourL(highHours[0][0])}–${hourL(highHours.at(-1)[0] + 3600)}.`;
    out.push(tile('UV index', IC.uv, `<div class="big">${Math.round(uv)}</div><div class="sub">${uvCat}</div><div class="meter uv"><i style="left:${clamp(uv / 11 * 100, 0, 100)}%"></i></div><div class="note">${uvNote}</div>`));

    // Air quality
    const aq = S.aq?.current;
    if (aq && ok(aq.us_aqi)) {
      const v = aq.us_aqi;
      const cat = v <= 50 ? 'Good' : v <= 100 ? 'Moderate' : v <= 150 ? 'Unhealthy for sensitive groups' : v <= 200 ? 'Unhealthy' : v <= 300 ? 'Very unhealthy' : 'Hazardous';
      out.push(tile('Air quality', IC.aqi, `<div class="big">${Math.round(v)}</div><div class="sub">${cat}</div><div class="meter aqi"><i style="left:${clamp(v / 400 * 100, 0, 100)}%"></i></div>
        <div class="note">PM2.5 ${ok(aq.pm2_5) ? Math.round(aq.pm2_5) : '--'} µg/m³ · O₃ ${ok(aq.ozone) ? Math.round(aq.ozone) : '--'} µg/m³</div>`));
    } else out.push(tile('Air quality', IC.aqi, `<div class="big">--</div><div class="note">${S.aq === null ? 'Loading…' : 'Unavailable'}</div>`));

    // Humidity
    out.push(tile('Humidity', IC.hum, `<div class="big">${ok(c.relative_humidity_2m) ? Math.round(c.relative_humidity_2m) : '--'}%</div><div class="note">The dew point is ${fT(c.dew_point_2m)} right now.${c.dew_point_2m > 18 ? ' It feels muggy.' : c.dew_point_2m < 5 ? ' The air is dry.' : ''}</div>`));

    // Visibility
    const vis = c.visibility;
    const visNote = !ok(vis) ? '' : vis >= 16000 ? 'Perfectly clear view.' : vis >= 10000 ? 'Clear view.' : vis >= 4000 ? 'Light haze is reducing visibility.' : vis >= 1000 ? 'Haze or mist is reducing visibility.' : 'Fog is significantly reducing visibility.';
    const visV = ok(vis) ? U.vis(vis) : null;
    out.push(tile('Visibility', IC.vis, `<div class="big">${visV == null ? '--' : visV >= 10 ? Math.round(visV) : visV.toFixed(1)} <span style="font-size:20px">${U.visU()}</span></div><div class="note">${visNote}</div>`));

    // Pressure
    const p0 = c.pressure_msl, p3 = h.pressure_msl[i0 - 3];
    const dp = ok(p0) && ok(p3) ? p0 - p3 : 0;
    const trend = dp > 1 ? ['Rising', '↑'] : dp < -1 ? ['Falling', '↓'] : ['Steady', '→'];
    const pFrac = clamp((p0 - 970) / (1050 - 970), 0, 1);
    const ang = -120 + pFrac * 240, rad = a => (a - 90) * Math.PI / 180;
    const arcPt = a => `${60 + Math.cos(rad(a)) * 44} ${60 + Math.sin(rad(a)) * 44}`;
    const gauge = `<svg class="dial" viewBox="0 0 120 100"><path d="M${arcPt(-120)}A44 44 0 1 1 ${arcPt(120)}" fill="none" stroke="rgba(255,255,255,.2)" stroke-width="6" stroke-linecap="round"/>
      <path d="M${arcPt(-120)}A44 44 0 ${ang > 60 ? 1 : 0} 1 ${arcPt(ang)}" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/>
      <text x="60" y="58" fill="#fff" font-size="17" font-weight="600" text-anchor="middle">${ok(p0) ? (us() ? U.pres(p0).toFixed(2) : Math.round(p0)) : '--'}</text>
      <text x="60" y="72" fill="rgba(255,255,255,.7)" font-size="9" text-anchor="middle">${U.presU()} ${trend[1]}</text></svg>`;
    out.push(tile('Pressure', IC.pres, `${gauge}<div class="note">${trend[0]} over the last 3 hours${Math.abs(dp) > 1 ? ` (${dp > 0 ? '+' : ''}${us() ? U.pres(dp).toFixed(2) : dp.toFixed(1)})` : ''}.</div>`));

    // Precipitation totals
    let past = 0, next = 0;
    h.time.forEach((t, k) => {
      const v = h.precipitation[k] ?? 0;
      if (t + 3600 <= nowS && t >= nowS - 86400) past += v;
      else if (t >= h.time[i0] && t < h.time[i0] + 86400) next += v;
    });
    out.push(tile('Precipitation', IC.precip, `<div class="big">${fP(past)} <span style="font-size:20px">${U.prU()}</span></div><div class="sub">in last 24h</div><div class="note">${next >= 0.1 ? `${fP(next)} ${U.prU()} expected in the next 24h.` : 'None expected in the next 24h.'}</div>`));

    // Sun
    const rise = d.sunrise[0], set = d.sunset[0];
    const f = clamp((nowS - rise) / (set - rise), 0, 1), up = nowS > rise && nowS < set;
    const sx = 10 + 140 * f, sy = 52 - 38 * Math.sin(Math.PI * f);
    let curve = '';
    for (let k = 0; k <= 40; k++) { const q = k / 40; curve += `${k ? 'L' : 'M'}${(10 + 140 * q).toFixed(1)} ${(52 - 38 * Math.sin(Math.PI * q)).toFixed(1)}`; }
    const nextEv = nowS < rise ? ['Sunrise', rise] : nowS < set ? ['Sunset', set] : ['Sunrise', d.sunrise[1]];
    const dl = d.daylight_duration[0];
    out.push(tile(nextEv[0], IC.sun, `<div class="big">${timeL(nextEv[1])}</div>
      <svg class="arc" viewBox="0 0 160 62"><line x1="0" x2="160" y1="52" y2="52" stroke="rgba(255,255,255,.35)"/>
      <path d="${curve}" fill="none" stroke="rgba(255,255,255,.45)" stroke-width="2" stroke-dasharray="3 3"/>
      <circle cx="${sx.toFixed(1)}" cy="${(up ? sy : 52).toFixed(1)}" r="6" fill="${up ? COL.sun : 'rgba(255,255,255,.5)'}" ${up ? 'style="filter:drop-shadow(0 0 6px #ffc83d)"' : ''}/></svg>
      <div class="note">${nextEv[0] === 'Sunset' ? 'Sunrise ' + timeL(rise) : 'Sunset ' + timeL(set)} · ${ok(dl) ? `${Math.floor(dl / 3600)}h ${Math.round(dl % 3600 / 60)}m daylight` : ''}</div>`));

    // Moon
    const mp = moonPhase(new Date());
    out.push(tile('Moon', IC.moon, `<div class="moon">${moonSVG(mp.phase, S.loc?.lat ?? 1)}<div><div class="sub">${mp.name}</div><div class="note" style="padding:0">${Math.round(mp.illum * 100)}% illuminated</div></div></div>
      <div class="note">Next full moon ${fmt('md', { month: 'short', day: 'numeric' }).format(mp.nextFull)}</div>`));

    // Nearest station (US)
    const o = S.nws?.obs;
    if (o) {
      out.push(tile('Nearest station', IC.station, `<div class="row"><span><b>${esc(o.id)}</b> · ${esc(o.name)}</span></div>
        <div class="row"><span>${U.dist(o.km).toFixed(1)} ${U.distU()} away</span><span>observed ${ago(o.at)}</span></div>
        <div class="station-grid">
          <div><b>${fT(o.temp)}</b>Temp</div>
          <div><b>${ok(o.rh) ? Math.round(o.rh) + '%' : '--'}</b>Humidity</div>
          <div><b>${ok(o.wind) ? fW(o.wind) : '--'}</b>${U.windU()}</div>
          <div><b>${fT(o.dew)}</b>Dew pt</div>
        </div>${o.text ? `<div class="note">${esc(o.text)}</div>` : ''}`, 'wide'));
    }
    $('#tiles').innerHTML = out.join('');
  }

  function moonPhase(date) {
    const syn = 29.530588853, ref = Date.UTC(2000, 0, 6, 18, 14);
    const days = (date - ref) / 86400000;
    const phase = ((days / syn) % 1 + 1) % 1;
    const illum = (1 - Math.cos(2 * Math.PI * phase)) / 2;
    const names = ['New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous', 'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent'];
    const name = names[Math.round(phase * 8) % 8];
    const toFull = ((0.5 - phase + 1) % 1) * syn;
    return { phase, illum, name, nextFull: new Date(date.getTime() + (toFull < 0.5 ? toFull + syn : toFull) * 86400000) };
  }
  function moonSVG(p, lat) {
    const r = 26, cx = 30, cy = 30, rx = Math.abs(Math.cos(2 * Math.PI * p)) * r;
    let d;
    if (p < 0.5) d = `M${cx} ${cy - r}A${r} ${r} 0 0 1 ${cx} ${cy + r}A${rx} ${r} 0 0 ${p < 0.25 ? 0 : 1} ${cx} ${cy - r}z`;
    else d = `M${cx} ${cy - r}A${r} ${r} 0 0 0 ${cx} ${cy + r}A${rx} ${r} 0 0 ${p < 0.75 ? 0 : 1} ${cx} ${cy - r}z`;
    return `<svg viewBox="0 0 60 60"><g ${lat < 0 ? 'transform="matrix(-1 0 0 1 60 0)"' : ''}><circle cx="${cx}" cy="${cy}" r="${r}" fill="rgba(255,255,255,.12)"/><path d="${d}" fill="#EEF1F8"/></g></svg>`;
  }

  function renderFooter() {
    $('#updated').textContent = S.fetchedAt ? `Updated ${ago(S.fetchedAt)}` : '';
  }

  /* ---------------- Ambient effects (rain / snow / stars) ---------------- */
  const FX = (() => {
    const cv = $('#fx'), ctx = cv.getContext('2d');
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let mode = 'none', parts = [], raf = 0, W = 0, H = 0, dpr = 1, intensity = 0;
    function size() {
      dpr = Math.min(2, devicePixelRatio || 1);
      W = innerWidth; H = innerHeight;
      cv.width = W * dpr; cv.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    }
    function seed() {
      const n = mode === 'rain' ? Math.round(40 + 160 * intensity) : mode === 'snow' ? Math.round(40 + 80 * intensity) : mode === 'stars' ? 70 : 0;
      parts = Array.from({ length: n }, () => ({
        x: Math.random() * W, y: Math.random() * H, z: 0.4 + Math.random() * 0.6, ph: Math.random() * 6.28,
      }));
    }
    function frame(ts) {
      ctx.clearRect(0, 0, W, H);
      if (mode === 'rain') {
        ctx.strokeStyle = 'rgba(200,225,255,.35)'; ctx.lineCap = 'round';
        ctx.beginPath();
        for (const p of parts) {
          p.y += 14 * p.z; p.x -= 1.5 * p.z;
          if (p.y > H) { p.y = -20; p.x = Math.random() * W; }
          ctx.lineWidth = p.z * 1.3;
          ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + 1.5 * p.z, p.y - 14 * p.z);
        }
        ctx.stroke();
      } else if (mode === 'snow') {
        ctx.fillStyle = 'rgba(255,255,255,.8)';
        for (const p of parts) {
          p.y += 1.2 * p.z; p.x += Math.sin(ts / 1200 + p.ph) * 0.5;
          if (p.y > H) { p.y = -5; p.x = Math.random() * W; }
          ctx.beginPath(); ctx.arc(p.x, p.y, 2.2 * p.z, 0, 6.283); ctx.fill();
        }
      } else if (mode === 'stars') {
        for (const p of parts) {
          if (p.y > H * 0.6) continue;
          ctx.fillStyle = `rgba(255,255,255,${(0.25 + 0.5 * p.z * (0.6 + 0.4 * Math.sin(ts / 900 + p.ph))).toFixed(2)})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.z * 1.1, 0, 6.283); ctx.fill();
        }
      }
      raf = requestAnimationFrame(frame);
    }
    function run() {
      cancelAnimationFrame(raf); raf = 0;
      ctx.clearRect(0, 0, W, H);
      if (mode !== 'none' && !document.hidden && !reduce) raf = requestAnimationFrame(frame);
    }
    addEventListener('resize', size);
    document.addEventListener('visibilitychange', run);
    size();
    return {
      set(code, day, precip, cloud) {
        const m = isSnow(code) ? 'snow' : (isRain(code) || isStorm(code)) ? 'rain' : (!day && code <= 2 && (cloud ?? 0) < 60) ? 'stars' : 'none';
        const it = clamp((precip || 0) / 5, 0.15, 1);
        if (m === mode && Math.abs(it - intensity) < 0.1) return;
        mode = m; intensity = it; seed(); run();
      },
    };
  })();

  /* ---------------- Radar ---------------- */
  const Radar = (() => {
    let map, me, alertsLayer, layers = [], frames = [], idx = 0, timer = 0, playing = false;
    let source = null, forced = null, center = null, loadedFor = null, loadedAt = 0;
    const wrap = $('#radar-wrap'), slot = $('#radar-slot');
    const range = $('#radar-range'), playBtn = $('#radar-play'), timeEl = $('#radar-time'), srcEl = $('#radar-src');

    function init() {
      if (map || !window.L) return;
      map = L.map('map', { zoomControl: false, attributionControl: true, minZoom: 3, maxZoom: 12, zoomSnap: 0.5, fadeAnimation: true });
      map.attributionControl.setPrefix(false);
      map.createPane('labels'); map.getPane('labels').style.zIndex = 450; map.getPane('labels').style.pointerEvents = 'none';
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', { subdomains: 'abcd', maxZoom: 19, attribution: '© OpenStreetMap © CARTO' }).addTo(map);
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', { subdomains: 'abcd', maxZoom: 19, pane: 'labels' }).addTo(map);
      setInteractive(false);
      range.addEventListener('input', () => { stop(); show(+range.value); });
      playBtn.addEventListener('click', e => { e.stopPropagation(); playing ? stop() : play(); });
      $('#radar-tap').addEventListener('click', expand);
      $('#radar-close').addEventListener('click', collapse);
      $('#radar-locate').addEventListener('click', () => center && map.flyTo(center, 9, { duration: 0.6 }));
      srcEl.addEventListener('click', () => {
        if (!center || !inConus(...center)) return;
        forced = source === 'iem' ? 'rv' : 'iem';
        load(true);
      });
    }

    function setInteractive(on) {
      ['dragging', 'touchZoom', 'doubleClickZoom', 'scrollWheelZoom', 'boxZoom', 'keyboard'].forEach(k => map[k] && (on ? map[k].enable() : map[k].disable()));
    }
    function expand() {
      document.body.appendChild(wrap);
      wrap.classList.add('full');
      setInteractive(true);
      setTimeout(() => map.invalidateSize(), 50);
      history.pushState({ radar: 1 }, '');
    }
    function collapse(fromPop) {
      if (!wrap.classList.contains('full')) return;
      wrap.classList.remove('full');
      slot.appendChild(wrap);
      setInteractive(false);
      setTimeout(() => { map.invalidateSize(); center && map.setView(center, 8, { animate: false }); }, 50);
      if (fromPop !== true && history.state?.radar) history.back();
    }
    addEventListener('popstate', () => collapse(true));

    async function setLocation(lat, lon) {
      init();
      if (!map) return;
      const moved = !center || haversine(center[0], center[1], lat, lon) > 1;
      if (!inConus(lat, lon)) forced = null;
      center = [lat, lon];
      if (moved) map.setView(center, 8, { animate: false });
      if (!me) me = L.marker(center, { icon: L.divIcon({ className: 'me-dot', iconSize: [16, 16] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
      else me.setLatLng(center);
      const want = forced || (inConus(lat, lon) ? 'iem' : 'rv');
      if (want !== loadedFor || Date.now() - loadedAt > 4 * 60e3) await load();
    }

    async function load() {
      const src = forced || (center && inConus(...center) ? 'iem' : 'rv');
      stop();
      layers.forEach(l => map.removeLayer(l));
      layers = []; frames = [];
      try {
        if (src === 'iem') {
          const step = 5 * 60e3, base = Math.floor((Date.now() - 2 * 60e3) / step) * step;
          for (let m = 55; m >= 0; m -= 5) {
            const name = m === 0 ? 'nexrad-n0q-900913' : `nexrad-n0q-900913-m${String(m).padStart(2, '0')}m`;
            frames.push({ t: base - m * 60e3, url: `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/${name}/{z}/{x}/{y}.png?_=${base}` });
          }
        } else {
          const j = await getJSON('https://api.rainviewer.com/public/weather-maps.json');
          const all = [...(j.radar?.past || []), ...(j.radar?.nowcast || []).map(f => ({ ...f, fc: true }))];
          for (const f of all) frames.push({ t: f.time * 1000, fc: f.fc, url: `${j.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, native: 7 });
        }
      } catch (e) {
        timeEl.textContent = 'Offline';
        return;
      }
      source = src; loadedFor = src; loadedAt = Date.now();
      srcEl.textContent = src === 'iem' ? 'NEXRAD' : 'Global';
      srcEl.style.cursor = center && inConus(...center) ? 'pointer' : '';
      $('#radar-legend').classList.toggle('rv', src === 'rv');
      for (const f of frames) {
        const l = L.tileLayer(f.url, {
          opacity: 0, zIndex: 5, maxZoom: 12, ...(f.native ? { maxNativeZoom: f.native } : {}),
          attribution: src === 'iem' ? 'NEXRAD via IEM' : 'RainViewer', className: 'radar-frame',
        });
        l.addTo(map);
        layers.push(l);
      }
      range.max = frames.length - 1;
      const lastPast = frames.reduce((a, f, i) => (f.fc ? a : i), 0);
      show(lastPast);
      setTimeout(play, 1200);
    }

    function show(i) {
      if (!frames.length) return;
      layers[idx]?.setOpacity(0);
      idx = (i + frames.length) % frames.length;
      layers[idx].setOpacity(0.78);
      range.value = idx;
      const f = frames[idx];
      const mins = Math.round((f.t - Date.now()) / 60000);
      timeEl.innerHTML = `${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(f.t)}<small>${f.fc ? 'forecast' : mins > -6 ? 'latest' : mins + ' min'}</small>`;
    }
    function play() {
      if (!frames.length || playing) return;
      playing = true; playBtn.classList.add('playing');
      const tick = () => {
        if (!playing) return;
        const next = (idx + 1) % frames.length;
        show(next);
        timer = setTimeout(tick, next === frames.length - 1 ? 1600 : 450);
      };
      timer = setTimeout(tick, 450);
    }
    function stop() { playing = false; clearTimeout(timer); playBtn.classList.remove('playing'); }

    function setAlerts(alerts) {
      if (!map) return;
      alertsLayer && map.removeLayer(alertsLayer);
      const feats = (alerts || []).filter(f => f.geometry?.type).map(f => ({ type: 'Feature', geometry: f.geometry, properties: f.properties || {} }));
      if (!feats.length) { alertsLayer = null; return; }
      alertsLayer = L.geoJSON({ type: 'FeatureCollection', features: feats }, {
        style: f => ({ color: /extreme|severe/i.test(f.properties.severity) ? '#ff4d4f' : '#ffb020', weight: 2, fillOpacity: 0.08 }),
        interactive: false,
      }).addTo(map);
    }
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
    return { setLocation, setAlerts, reload: () => center && load() };
  })();

  /* ---------------- Locations sheet ---------------- */
  const sheet = $('#sheet'), searchEl = $('#search');
  function openSheet(msg) {
    const m = $('#sheet-msg');
    m.hidden = !msg; m.textContent = msg || '';
    sheet.classList.add('open'); sheet.setAttribute('aria-hidden', 'false');
    renderPlaces();
    if (msg) setTimeout(() => searchEl.focus(), 350);
  }
  function closeSheet() {
    sheet.classList.remove('open'); sheet.setAttribute('aria-hidden', 'true');
    searchEl.value = ''; $('#search-results').innerHTML = ''; searchEl.blur();
  }

  async function renderPlaces() {
    const gpsLast = store.get('lastGps', null);
    const rows = [{ id: 'gps', name: 'My Location', sub: gpsLast?.name && gpsLast.name !== 'My Location' ? gpsLast.name : 'Current location', lat: gpsLast?.lat, lon: gpsLast?.lon, gps: true }, ...S.places];
    const draw = temps => {
      $('#place-list').innerHTML = rows.map((p, k) => `<div class="place ${S.sel === p.id ? 'sel' : ''}" data-id="${esc(p.id)}" role="button">
        <div><div class="p-name">${p.gps ? PIN : ''}${esc(p.name)}</div><div class="p-sub">${esc(p.sub || '')}</div></div>
        <div class="p-t">${temps?.[k] ? icon(temps[k].code, temps[k].day) + fT(temps[k].t) : ''}</div>
        ${p.gps ? '' : `<button class="p-del" data-del="${esc(p.id)}" aria-label="Remove">×</button>`}</div>`).join('');
    };
    draw(null);
    const withCoords = rows.filter(r => ok(r.lat));
    if (!withCoords.length) return;
    try {
      const j = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${withCoords.map(r => r.lat.toFixed(3))}&longitude=${withCoords.map(r => r.lon.toFixed(3))}&current=temperature_2m,weather_code,is_day&timezone=auto`);
      const arr = Array.isArray(j) ? j : [j];
      const temps = rows.map(r => { const k = withCoords.indexOf(r); const c = arr[k]?.current; return c ? { t: c.temperature_2m, code: c.weather_code, day: c.is_day } : null; });
      if (sheet.classList.contains('open')) draw(temps);
    } catch { /* temps are a nicety */ }
  }

  $('#place-list').addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      S.places = S.places.filter(p => p.id !== del.dataset.del);
      store.set('places', S.places);
      if (S.sel === del.dataset.del) selectPlace('gps');
      renderPlaces();
      return;
    }
    const row = e.target.closest('.place');
    if (row) { selectPlace(row.dataset.id); closeSheet(); }
  });

  function selectPlace(id) {
    S.sel = id; store.set('sel', id);
    S.loading = false; // allow a new refresh to supersede any in-flight one
    S.nws = null; S.aq = null;
    $('#alerts').innerHTML = '';
    window.scrollTo({ top: 0 });
    refresh();
  }

  let searchT = 0, lastResults = [];
  searchEl.addEventListener('input', () => {
    clearTimeout(searchT);
    const q = searchEl.value.trim();
    if (q.length < 2) { $('#search-results').innerHTML = ''; return; }
    searchT = setTimeout(async () => {
      try {
        const j = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=en&format=json`);
        if (searchEl.value.trim() !== q) return;
        lastResults = j.results || [];
        $('#search-results').innerHTML = lastResults.length
          ? lastResults.map((r, i) => `<button class="sr" data-i="${i}">${esc(r.name)}<small>${esc([r.admin2, r.admin1, r.country].filter(Boolean).join(', '))}</small></button>`).join('')
          : '<div class="sr"><small>No matches</small></div>';
      } catch { $('#search-results').innerHTML = '<div class="sr"><small>Search unavailable — check your connection</small></div>'; }
    }, 250);
  });
  $('#search-results').addEventListener('click', e => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    const r = lastResults[+b.dataset.i];
    const id = `${r.latitude.toFixed(3)},${r.longitude.toFixed(3)}`;
    if (!S.places.some(p => p.id === id)) {
      S.places.push({ id, name: r.name, sub: [r.admin1, r.country_code !== 'US' ? r.country : ''].filter(Boolean).join(', '), lat: r.latitude, lon: r.longitude });
      store.set('places', S.places);
    }
    selectPlace(id);
    closeSheet();
  });
  $('#btn-places').addEventListener('click', () => openSheet());
  $('#sheet-close').addEventListener('click', closeSheet);
  $('.sheet-backdrop').addEventListener('click', closeSheet);

  /* ---------------- Misc UI ---------------- */
  $('#btn-units').addEventListener('click', () => {
    S.units = us() ? 'metric' : 'us';
    store.set('units', S.units);
    renderAll();
  });

  $('#daily').addEventListener('click', e => e.target.closest('.d')?.classList.toggle('open'));

  let toastT = 0;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3500);
  }

  const ptr = $('#ptr');
  function setSpin(on) {
    ptr.classList.toggle('spin', on);
    ptr.classList.toggle('on', on);
    if (!on) ptr.style.transform = '';
  }

  // Pull-to-refresh (standalone web apps have none built in)
  let startY = null, pulled = 0;
  addEventListener('touchstart', e => {
    if (window.scrollY <= 0 && !sheet.classList.contains('open') && !$('#radar-wrap').classList.contains('full')) startY = e.touches[0].clientY;
  }, { passive: true });
  addEventListener('touchmove', e => {
    if (startY == null || S.loading) return;
    pulled = e.touches[0].clientY - startY;
    if (pulled > 10) {
      ptr.classList.add('on', 'pull');
      const f = clamp(pulled / 80, 0, 1);
      ptr.style.transform = `translateY(${f * 16 - 10}px) rotate(${pulled * 3}deg) scale(${0.6 + 0.4 * f})`;
    }
  }, { passive: true });
  addEventListener('touchend', () => {
    if (startY == null) return;
    ptr.classList.remove('pull');
    if (pulled > 80 && !S.loading) { ptr.style.transform = ''; refresh(); } else if (!S.loading) setSpin(false);
    startY = null; pulled = 0;
  });

  // Compact header once the big temperature scrolls away
  new IntersectionObserver(([e]) => $('#topbar').classList.toggle('compact', !e.isIntersecting), { rootMargin: '-60px 0px 0px 0px' })
    .observe($('#temp-now'));

  // Keep data fresh
  const stale = ms => Date.now() - S.fetchedAt > ms;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { if (stale(5 * 60e3)) refresh(); else Radar.reload(); }
  });
  setInterval(() => {
    renderFooter();
    if (!document.hidden && stale(10 * 60e3)) refresh();
    else if (S.wx && !document.hidden) renderNowcast();
  }, 60e3);
  addEventListener('online', () => stale(60e3) && refresh());

  // Install hint for iOS Safari (not already installed)
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (!standalone && /iPhone|iPad|iPod/.test(navigator.userAgent)) $('#install-hint').hidden = false;

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  /* ---------------- Boot ---------------- */
  const snap = store.get('snap', null);
  if (snap?.wx && snap.loc && (snap.loc.id === S.sel || (S.sel === 'gps' && snap.loc.gps))) {
    Object.assign(S, { loc: snap.loc, wx: snap.wx, aq: snap.aq, nws: snap.nws, fetchedAt: snap.at });
    renderAll();
    Radar.setLocation(snap.loc.lat, snap.loc.lon);
    Radar.setAlerts(snap.nws?.alerts);
  } else {
    document.body.classList.add('loading');
  }
  refresh();
})();
