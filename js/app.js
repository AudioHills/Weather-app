/* Hyper-local weather PWA — no build step, no API keys.
 * Forecast / 15-min nowcast / air quality / search: Open-Meteo
 * Canada: Environment and Climate Change Canada (radar composite, alerts, city-page obs + forecast)
 * US: National Weather Service (alerts, nearest station, forecast text), NEXRAD via IEM
 * Elsewhere: RainViewer radar. Base map: OpenFreeMap (vector, keyless).
 */
'use strict';
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const ok = v => v != null && !Number.isNaN(v);
  const num = v => (v == null || v === '' ? null : Number.isFinite(+v) ? +v : null);

  const store = {
    get(k, d) { try { const v = localStorage.getItem('wx.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('wx.' + k, JSON.stringify(v)); } catch { /* quota / private mode */ } },
  };

  const S = {
    units: store.get('units', /^en-US$/i.test(navigator.language || '') ? 'us' : 'metric'),
    places: store.get('places', []),
    sel: store.get('sel', 'gps'),
    loc: null, wx: null, aq: null, local: null,
    fetchedAt: 0, loading: false, token: 0, daySel: 0,
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
  const fT = c => (ok(c) ? Math.round(U.t(c)) + '°' : '--');
  const fW = k => (ok(k) ? Math.round(U.wind(k)) : '--');
  const fP = mm => (ok(mm) ? (us() ? U.pr(mm).toFixed(2) : U.pr(mm).toFixed(1)) : '--');
  const fPres = h => (ok(h) ? (us() ? U.pres(h).toFixed(2) : Math.round(h)) : '--');

  let TZ;
  const fmtCache = {};
  const fmt = (key, opts) => (fmtCache[key + TZ] ||= new Intl.DateTimeFormat(undefined, { ...opts, timeZone: TZ }));
  const hourL = ts => fmt('h', { hour: 'numeric' }).format(ts * 1000).replace(/\s/g, '').replace(/^0(?=\d)/, '');
  const timeL = ts => fmt('hm', { hour: 'numeric', minute: '2-digit' }).format(ts * 1000);
  const dayL = ts => fmt('wd', { weekday: 'short' }).format(ts * 1000);
  const ago = ms => {
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h} h ${m % 60 ? (m % 60) + ' min ' : ''}ago` : `${Math.floor(h / 24)} d ago`;
  };
  const dur = mins => {
    mins = Math.max(5, Math.round(mins / 5) * 5);
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60), m = mins % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  };
  const titleCase = s => String(s || '').replace(/\b([a-z])/g, c => c.toUpperCase());

  /* ---------------- Weather codes & icons ---------------- */
  const WMO = {
    0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Freezing fog',
    51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
    61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
    71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
    80: 'Showers', 81: 'Rain showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Heavy snow showers',
    95: 'Thunderstorms', 96: 'Thunderstorms, hail', 99: 'Severe thunderstorms',
  };
  const condText = (code, day) => (code === 0 && day ? 'Sunny' : code === 1 && day ? 'Mostly sunny' : WMO[code] || '—');
  const isSnow = c => (c >= 71 && c <= 77) || c === 85 || c === 86;
  const isRain = c => (c >= 51 && c <= 67) || (c >= 80 && c <= 82);
  const isStorm = c => c >= 95;
  const isWet = c => isRain(c) || isSnow(c) || isStorm(c);

  const COL = { sun: '#FFC23D', moon: '#E4E8FF', cloud: '#EEF2F8', cloud2: '#9AA6BC', rain: '#4FA8FF', snow: '#fff', bolt: '#FFD43B', fog: '#C8D0DC' };
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
  const PC = 'translate(4 -4) scale(.88)';

  function iconG(code, day = 1) {
    if (code <= 1) return day ? sunG(32, 32, 12) : moonG(32, 32, 16);
    if (code === 2) return (day ? sunG(23, 22, 9) : moonG(24, 21, 12)) + cloudG('translate(10 12) scale(.8)');
    if (code === 3) return cloudG('translate(-2 -6) scale(.9)', COL.cloud2) + cloudG('translate(6 8) scale(.85)');
    if (code === 45 || code === 48)
      return cloudG('translate(4 -6) scale(.88)', COL.cloud2) + `<path d="M12 46h40M18 53h34M12 60h30" stroke="${COL.fog}" stroke-width="3.2" stroke-linecap="round"/>`;
    if (code >= 51 && code <= 57) return cloudG(PC) + drops(3, COL.rain, 5) + (code >= 56 ? `<circle cx="37" cy="58" r="2.4" fill="#fff"/>` : '');
    if (code === 66 || code === 67) return cloudG(PC) + drops(2) + `<circle cx="33" cy="57" r="2.6" fill="#fff"/>`;
    if (isRain(code)) return (code >= 80 && day ? sunG(16, 14, 7) : '') + cloudG(PC) + drops(3);
    if (isSnow(code)) return cloudG(PC) + flakes();
    if (isStorm(code))
      return cloudG(PC, '#8E9AB0') + `<path d="M35 36l-9 14h7l-4 12 13-17h-7l4-9z" fill="${COL.bolt}"/><path d="M20 44l-3 9M46 44l-3 9" stroke="${COL.rain}" stroke-width="3" stroke-linecap="round"/>`;
    return cloudG('translate(0 0)');
  }
  const icon = (code, day = 1, cls = '') => `<svg viewBox="0 0 64 64" class="${cls}" aria-hidden="true">${iconG(code, day)}</svg>`;

  /* ---------------- Color & path helpers ---------------- */
  const TSTOPS = [[-25, [196, 181, 253]], [-10, [129, 140, 248]], [0, [56, 189, 248]], [8, [45, 212, 191]], [15, [132, 225, 90]], [21, [250, 204, 21]], [27, [251, 146, 60]], [34, [239, 68, 68]]];
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
  // Smooth line through points (Catmull-Rom → cubic Bézier)
  function smooth(pts) {
    if (!pts.length) return '';
    let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += `C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
    }
    return d;
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
    if (minutely) { p.set('minutely_15', 'precipitation,snowfall,weather_code,temperature_2m'); p.set('forecast_minutely_15', '13'); }
    return 'https://api.open-meteo.com/v1/forecast?' + p;
  }
  const aqURL = (lat, lon) => `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=us_aqi,pm2_5,pm10,ozone&timezone=auto`;

  const inConus = (lat, lon) => lat > 24 && lat < 50 && lon > -125.5 && lon < -66;
  const inNorthAmerica = (lat, lon) => lat > 24 && lat < 72 && lon > -141.5 && lon < -50;
  function guessCountry(lat, lon) {
    if (lat >= 49.2 && lat < 84 && lon > -141.1 && lon < -52) return 'CA';
    if ((lat > 51 && lat < 72 && lon > -170 && lon < -141) || (lat > 18.5 && lat < 22.5 && lon > -161 && lon < -154)) return 'US';
    if (inConus(lat, lon) && lat < 41.5) return 'US';
    return null; // near the border — ask both services
  }

  function haversine(a1, o1, a2, o2) {
    const R = 6371, r = Math.PI / 180, dA = (a2 - a1) * r, dO = (o2 - o1) * r;
    const h = Math.sin(dA / 2) ** 2 + Math.cos(a1 * r) * Math.cos(a2 * r) * Math.sin(dO / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  async function reverseGeocode(lat, lon) {
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    const cache = store.get('rgeo2', {});
    if (cache[key]) return cache[key];
    const g = await getJSON(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
    const name = g.locality || g.city || g.principalSubdivision || 'My location';
    const region = g.principalSubdivisionCode?.split('-')[1] || g.principalSubdivision;
    const sub = [g.city && g.city !== name ? g.city : '', region].filter(Boolean).join(', ');
    const res = { name, sub, cc: g.countryCode || null };
    const keys = Object.keys(cache);
    if (keys.length > 30) delete cache[keys[0]];
    cache[key] = res;
    store.set('rgeo2', cache);
    return res;
  }

  /* ---- US: National Weather Service ---- */
  async function loadNWS(lat, lon) {
    const ll = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    const alertsP = getJSON(`https://api.weather.gov/alerts/active?point=${ll}`).catch(() => null);
    const out = { src: 'nws', alerts: [], obs: null, periods: [], city: null };
    try {
      const pt = (await getJSON(`https://api.weather.gov/points/${ll}`)).properties;
      const rl = pt.relativeLocation?.properties;
      if (rl) out.city = `${rl.city}, ${rl.state}`;
      const [stations, fc] = await Promise.all([
        getJSON(pt.observationStations).catch(() => null),
        getJSON(pt.forecast).catch(() => null),
      ]);
      out.periods = (fc?.properties?.periods || []).slice(0, 3).map(p => ({ name: p.name, text: p.detailedForecast }));
      for (const f of (stations?.features || []).slice(0, 4)) {
        try {
          const id = f.properties.stationIdentifier;
          const p = (await getJSON(`https://api.weather.gov/stations/${id}/observations/latest`)).properties;
          if (p.temperature?.value == null) continue;
          const at = Date.parse(p.timestamp);
          if (!(Date.now() - at < 3 * 3600e3)) continue;
          const [slon, slat] = f.geometry.coordinates;
          out.obs = {
            id, name: f.properties.name, km: haversine(lat, lon, slat, slon), at,
            temp: p.temperature.value, text: p.textDescription, dew: p.dewpoint?.value, rh: p.relativeHumidity?.value,
            wind: p.windSpeed?.value, pres: p.barometricPressure?.value != null ? p.barometricPressure.value / 100 : null,
          };
          break;
        } catch { /* try next station */ }
      }
    } catch { /* points can 404 offshore */ }
    const al = await alertsP;
    out.alerts = (al?.features || []).filter(f => f.properties?.status !== 'Test').map(f => {
      const p = f.properties;
      return {
        title: p.event, color: /extreme|severe/i.test(p.severity) ? 'red' : /moderate/i.test(p.severity) ? 'orange' : 'yellow',
        until: p.ends || p.expires, sender: p.senderName || 'NWS', body: [p.headline, p.description].filter(Boolean).join('\n\n'),
        instr: p.instruction, geometry: f.geometry,
      };
    });
    return out;
  }

  /* ---- Canada: Environment and Climate Change Canada (GeoMet OGC API) ---- */
  const ECCC = 'https://api.weather.gc.ca/collections';
  // ECCC nests most values as {value: {en, fr}} and some as {en, fr}
  const en = n => (n == null ? null : typeof n !== 'object' ? n : n.value && typeof n.value === 'object' ? n.value.en : n.en ?? (typeof n.value !== 'object' ? n.value : null));
  async function loadECCC(lat, lon) {
    const out = { src: 'eccc', alerts: [], obs: null, periods: [], city: null };
    const d = 0.02;
    const alertsP = getJSON(`${ECCC}/weather-alerts/items?f=json&lang=en&limit=50&bbox=${lon - d},${lat - d},${lon + d},${lat + d}`).catch(() => null);
    try {
      let feats = [];
      for (const D of [0.45, 1.4]) {
        const j = await getJSON(`${ECCC}/citypageweather-realtime/items?f=json&lang=en&limit=40&bbox=${lon - D * 1.4},${lat - D},${lon + D * 1.4},${lat + D}`);
        feats = (j.features || []).filter(f => f.geometry?.coordinates);
        if (feats.length) break;
      }
      const best = feats.map(f => ({ f, km: haversine(lat, lon, f.geometry.coordinates[1], f.geometry.coordinates[0]) })).sort((a, b) => a.km - b.km)[0];
      if (best) {
        const p = best.f.properties || {};
        out.city = en(p.name) || null;
        const cc = p.currentConditions || {};
        const temp = num(en(cc.temperature));
        if (temp != null) {
          const ts = en(cc.timestamp);
          const pres = num(en(cc.pressure));
          out.obs = {
            id: 'ECCC', name: en(cc.station) || out.city || 'Environment Canada', km: best.km, kmIsCity: true,
            at: ts ? Date.parse(ts) : null, temp, text: en(cc.condition), dew: num(en(cc.dewpoint)), rh: num(en(cc.relativeHumidity)),
            wind: num(en(cc.wind?.speed)), pres: pres != null ? pres * 10 : null,
          };
        }
        out.periods = (p.forecastGroup?.forecasts || []).slice(0, 3).map(f => ({
          name: en(f.period?.textForecastName) || en(f.period) || '', text: en(f.textSummary) || '',
        })).filter(x => x.text);
      }
    } catch { /* city page is a nicety */ }
    const al = await alertsP;
    const seen = new Set();
    for (const f of al?.features || []) {
      const p = f.properties || {};
      const title = titleCase(p.alert_name_en || p.alert_short_name_en || 'Weather alert');
      const key = title + (p.expiration_datetime || '');
      if (seen.has(key)) continue;
      seen.add(key);
      const colour = String(p.risk_colour_en || '').toLowerCase();
      out.alerts.push({
        title, color: ['red', 'orange', 'yellow'].includes(colour) ? colour : 'grey',
        until: p.expiration_datetime, sender: `Environment Canada${p.feature_name_en ? ' · ' + p.feature_name_en : ''}`,
        body: p.alert_text_en || '', geometry: f.geometry,
      });
    }
    return out;
  }

  async function loadLocal(lat, lon, cc) {
    if (cc === 'CA') return loadECCC(lat, lon);
    if (cc === 'US') return loadNWS(lat, lon);
    if (cc || !inNorthAmerica(lat, lon)) return null;
    // Unknown, near the border: ask both and keep whichever covers this point
    const [a, b] = await Promise.all([loadECCC(lat, lon).catch(() => null), loadNWS(lat, lon).catch(() => null)]);
    const score = x => (x ? (x.periods.length ? 2 : 0) + (x.obs ? 1 : 0) : -1);
    return score(b) > score(a) ? b : a;
  }

  /* Models sometimes call "snow" during cold rain (snow aloft that melts before it lands).
   * Above +2.5 °C at the surface that's essentially never what you see, so call it rain. */
  const SNOW_TO_RAIN = { 71: 61, 73: 63, 75: 65, 77: 61, 85: 80, 86: 81 };
  const RAIN_ABOVE = 2.5;
  function sanitize(wx) {
    const fix = (codes, temps) => codes?.forEach((c, i) => { if (SNOW_TO_RAIN[c] && temps?.[i] > RAIN_ABOVE) codes[i] = SNOW_TO_RAIN[c]; });
    const c = wx.current;
    if (c && SNOW_TO_RAIN[c.weather_code] && c.temperature_2m > RAIN_ABOVE) c.weather_code = SNOW_TO_RAIN[c.weather_code];
    fix(wx.hourly?.weather_code, wx.hourly?.temperature_2m);
    fix(wx.daily?.weather_code, wx.daily?.temperature_2m_min);
    const m = wx.minutely_15;
    if (m?.time) {
      // fall back to the hourly temperature when the 15-min one is missing
      const hT = t => { const h = wx.hourly, k = h?.time?.findIndex(x => x + 3600 > t); return k >= 0 ? h.temperature_2m[k] : null; };
      m.time.forEach((t, i) => {
        const temp = m.temperature_2m?.[i] ?? hT(t);
        if (temp > RAIN_ABOVE) {
          if (SNOW_TO_RAIN[m.weather_code?.[i]]) m.weather_code[i] = SNOW_TO_RAIN[m.weather_code[i]];
          if (m.snowfall) m.snowfall[i] = 0;
        }
      });
    }
    return wx;
  }

  /* An actual observation beats a model guess for "what's happening now".
   * Returns a WMO-style code for an ECCC / NWS condition phrase. */
  function codeFromText(t) {
    const s = String(t || '').toLowerCase();
    if (!s || /not observed|n\/a/.test(s)) return null;
    if (/thunder/.test(s)) return 95;
    if (/freezing (rain|drizzle)|ice pellets|sleet/.test(s)) return 66;
    if (/snow|flurr/.test(s)) return /heavy/.test(s) ? 75 : /light|flurr/.test(s) ? 71 : 73;
    if (/drizzle/.test(s)) return 51;
    if (/shower/.test(s)) return 80;
    if (/rain/.test(s)) return /heavy/.test(s) ? 65 : /light/.test(s) ? 61 : 63;
    if (/fog|mist|haze|smoke/.test(s)) return 45;
    if (/overcast|mostly cloudy|^cloudy/.test(s)) return 3;
    if (/partly|few clouds|mainly cloudy|scattered/.test(s)) return 2;
    if (/mainly (sunny|clear)|mostly (sunny|clear)/.test(s)) return 1;
    if (/clear|sunny|fair/.test(s)) return 0;
    return null;
  }
  function nowCondition() {
    const c = S.wx.current, o = S.local?.obs;
    if (o?.text && o.at && Date.now() - o.at < 90 * 60e3 && !(o.km > 60)) {
      const code = codeFromText(o.text);
      if (code != null) return { code, text: o.text.charAt(0).toUpperCase() + o.text.slice(1).toLowerCase(), src: `Observed · ${o.name} · ${ago(o.at)}` };
    }
    return { code: c.weather_code, text: condText(c.weather_code, c.is_day), src: 'Model estimate · Open-Meteo' };
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
        const l = { id: 'gps', gps: true, lat, lon, acc: accuracy, name: near ? last.name : 'My location', sub: near ? last.sub : '', cc: near ? last.cc : null };
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
        openSheet('Location is off or unavailable. Search for a place, or allow Location for Safari in Settings → Privacy & Security.');
        return;
      }
      if (token !== S.token) return;
      const sameSpot = S.loc && S.loc.id === loc.id && haversine(S.loc.lat, S.loc.lon, loc.lat, loc.lon) < 0.3;
      if (!sameSpot) { S.local = null; S.aq = null; }
      S.loc = loc;
      renderLoc();
      const { lat, lon } = loc;
      const wxP = getJSON(forecastURL(lat, lon, true)).catch(() => getJSON(forecastURL(lat, lon, false)));
      const aqP = getJSON(aqURL(lat, lon)).catch(() => null);
      const geoP = loc.gps ? reverseGeocode(lat, lon).catch(() => null) : Promise.resolve(null);
      const ccP = loc.cc ? Promise.resolve(loc.cc) : geoP.then(g => g?.cc || guessCountry(lat, lon));
      const localP = ccP.then(cc => loadLocal(lat, lon, cc)).catch(() => null);

      const wx = await wxP;
      if (token !== S.token) return;
      S.wx = sanitize(wx); S.fetchedAt = Date.now();
      document.body.classList.remove('loading');
      renderAll();
      ccP.then(cc => { if (token === S.token) Radar.setLocation(lat, lon, cc, wx.current.temperature_2m); });

      aqP.then(aq => { if (token === S.token) { S.aq = aq || false; renderTiles(); snapshot(); } });
      geoP.then(g => {
        if (token !== S.token || !g) return;
        Object.assign(S.loc, { name: g.name, sub: g.sub, cc: g.cc });
        store.set('lastGps', { ...store.get('lastGps', {}), name: g.name, sub: g.sub, cc: g.cc });
        renderLoc(); snapshot();
      });
      localP.then(n => {
        if (token !== S.token) return;
        S.local = n || false;
        if (n && S.loc.gps && S.loc.name === 'My location' && n.city) { S.loc.name = n.city.split(',')[0]; renderLoc(); }
        renderNow(); renderAlerts(); renderNotes(); renderTiles(); Radar.setAlerts(n?.alerts);
        snapshot();
      });
      snapshot();
    } catch (e) {
      console.error(e);
      toast(navigator.onLine === false ? 'Offline — showing the last update' : 'Couldn’t update. Pull down to retry.');
    } finally {
      if (token === S.token) { S.loading = false; setSpin(false); }
    }
  }

  function snapshot() {
    store.set('snap2', { loc: S.loc, wx: S.wx, aq: S.aq, local: S.local, at: S.fetchedAt });
  }

  /* ---------------- Rendering ---------------- */
  function nowIdx(times) {
    const now = Date.now() / 1000;
    const i = times.findIndex(t => t + 3600 > now);
    return i < 0 ? times.length - 1 : i;
  }
  const clock = () => fmt('clk', { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(Date.now());

  function renderAll() {
    if (!S.wx) return;
    TZ = S.wx.timezone;
    document.body.dataset.units = S.units;
    renderLoc(); renderNow(); renderAlerts(); renderNowcast(); renderHourly(); renderDaily(); renderNotes(); renderTiles(); renderFooter();
  }

  function renderLoc() {
    const l = S.loc;
    if (!l) return;
    $('#loc-name').textContent = l.name;
    $('#live').className = 'live' + (l.gps ? (l.stale ? ' stale' : ' on') : '');
    let meta = l.sub || '';
    if (l.gps) {
      const acc = l.acc && !l.stale ? (us() ? `±${Math.round(l.acc * 3.281)} ft` : `±${Math.round(l.acc)} m`) : 'last known';
      meta = [meta, acc].filter(Boolean).join(' · ');
    }
    $('#loc-meta').textContent = meta || `${l.lat.toFixed(3)}, ${l.lon.toFixed(3)}`;
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

  function renderNow() {
    const c = S.wx.current, d = S.wx.daily, h = S.wx.hourly;
    $('#temp-now').innerHTML = `${ok(c.temperature_2m) ? Math.round(U.t(c.temperature_2m)) : '--'}<sup>°</sup>`;
    const nc = nowCondition();
    $('#now-icon').innerHTML = icon(nc.code, c.is_day);
    $('#cond-now').textContent = nc.text;
    $('#cond-src').textContent = nc.src;
    $('#now-clock').textContent = clock();
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const wd = dirs[Math.round((c.wind_direction_10m ?? 0) / 45) % 8];
    const pop = d.precipitation_probability_max[0];
    $('#now-stats').innerHTML = `
      <div><small>Feels</small><b>${fT(c.apparent_temperature)}</b></div>
      <div><small>Hi / Lo</small><b>${fT(d.temperature_2m_max[0])}<i>/${fT(d.temperature_2m_min[0])}</i></b></div>
      <div><small>Wind</small><b>${fW(c.wind_speed_10m)}<i>${wd}</i></b></div>
      <div><small>Precip</small><b>${ok(pop) ? Math.round(pop) : '--'}<i>%</i></b></div>`;
    $('#now-line').textContent = hourlySummary(h, c, nc.code);
    document.body.dataset.theme = themeFor(nc.code, c.is_day);
    FX.set(nc.code, c.is_day, c.precipitation, c.cloud_cover);
  }

  function hourlySummary(h, c, code = c.weather_code) {
    const i0 = nowIdx(h.time);
    const kindAt = k => (isStorm(h.weather_code[k]) ? 'Thunderstorms' : isSnow(h.weather_code[k]) ? 'Snow' : 'Rain');
    const win = [];
    for (let k = i0 + 1; k < Math.min(h.time.length, i0 + 13); k++) win.push(k);
    let sum;
    if (isWet(code)) {
      const dry = win.find(k => !isWet(h.weather_code[k]));
      const kind = isStorm(code) ? 'Thunderstorms' : isSnow(code) ? 'Snow' : 'Rain';
      sum = dry ? `${kind} easing around ${hourL(h.time[dry])}.` : `${kind} through the next 12 hours.`;
    } else {
      const wet = win.find(k => isWet(h.weather_code[k]) && (h.precipitation_probability[k] ?? 0) >= 40);
      const shift = win.find(k => themeFor(h.weather_code[k], 1) !== themeFor(code, 1));
      sum = wet ? `${kindAt(wet)} likely from around ${hourL(h.time[wet])}.`
        : shift ? `${condText(h.weather_code[shift], h.is_day[shift])} from around ${hourL(h.time[shift])}.`
          : `${condText(code, c.is_day)} for the next several hours.`;
    }
    const gustMax = Math.max(...h.wind_gusts_10m.slice(i0, i0 + 12).filter(ok));
    if (gustMax > 40) sum += ` Gusts to ${fW(gustMax)} ${U.windU()}.`;
    return sum;
  }

  function renderAlerts() {
    const list = S.local?.alerts || [];
    $('#alerts').innerHTML = list.map(a => `<details class="alert ${a.color}"><summary>
        <span class="a-ic"><svg viewBox="0 0 24 24"><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/></svg></span>
        <span><div class="a-title">${esc(a.title)}</div><div class="a-sub mono">${a.until ? 'Until ' + esc(fmt('ad', { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(a.until))) + ' · ' : ''}${esc(a.sender)}</div></span>
      </summary><div class="a-body">${esc(a.body)}${a.instr ? `<b>What to do</b>${esc(a.instr)}` : ''}</div></details>`).join('');
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
    if (!s.length) txt = 'Outlook unavailable';
    else if (wet[0]) {
      const end = wet.indexOf(false);
      const max = Math.max(...s.map(v => v.p)) * 4;
      txt = end === -1 ? `${max > 7.6 ? 'Heavy' : max < 1 ? 'Light' : 'Steady'} ${kind.toLowerCase()} for the next 3 hours` : `${kind} stopping in about ${dur(minsTo(end))}`;
    } else {
      const st = wet.indexOf(true);
      if (st === -1) {
        const h = S.wx.hourly, i0 = nowIdx(h.time);
        const later = h.time.slice(i0 + 3, i0 + 12).findIndex((t, k) => (h.precipitation_probability[i0 + 3 + k] ?? 0) >= 50);
        txt = later === -1 ? 'Dry for the next 3 hours' : `Dry for now — ${isSnow(h.weather_code[i0 + 3 + later]) ? 'snow' : 'rain'} likely by ${timeL(h.time[i0 + 3 + later])}`;
      } else txt = `${kind} starting in about ${dur(minsTo(st))}`;
    }
    $('#nowcast-summary').textContent = txt;

    const W = 320, H = 104, top = 10, base = 78;
    const scale = v => Math.sqrt(clamp(v * 4 / 10, 0, 1)); // mm/h; sqrt keeps drizzle visible, 10 mm/h tops out
    const n = Math.max(1, s.length - 1);
    const pts = s.map((v, i) => [i / n * W, base - (v.p >= TH ? scale(v.p) : 0) * (base - top)]);
    const col = kind === 'Snow' ? '#dff1ff' : '#4fa8ff';
    const line = smooth(pts);
    const area = pts.length ? `${line}L${W} ${base}L0 ${base}z` : '';
    const grid = [['heavy', 7.6 / 4], ['mod', 2.5 / 4], ['light', 0.5 / 4]].map(([l, v]) => {
      const y = (base - scale(v) * (base - top)).toFixed(1);
      return `<line class="gridl" x1="0" x2="${W}" y1="${y}" y2="${y}"/><text class="axis" x="${W + 6}" y="${+y + 3}">${l}</text>`;
    }).join('');
    const labels = ['now', '+1h', '+2h', '+3h'].map((l, i) => `<text class="axis" x="${i * W / 3}" y="${H - 4}" text-anchor="${i === 0 ? 'start' : i === 3 ? 'end' : 'middle'}">${l}</text>`).join('');
    $('#nowcast-chart').innerHTML = `<svg viewBox="0 0 ${W + 40} ${H}">
      <defs><linearGradient id="ncg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".75"/><stop offset="1" stop-color="${col}" stop-opacity=".05"/></linearGradient></defs>
      ${grid}<line x1="0" x2="${W}" y1="${base}" y2="${base}" stroke="rgba(255,255,255,.18)"/>
      <path d="${area}" fill="url(#ncg)"/><path d="${line}" fill="none" stroke="${col}" stroke-width="2.2" stroke-linejoin="round"/>
      <circle cx="0" cy="${pts[0]?.[1] ?? base}" r="4" fill="#fff"/>${labels}</svg>`;
  }

  function renderHourly() {
    const h = S.wx.hourly, d = S.wx.daily, i0 = nowIdx(h.time);
    const idx = [];
    for (let i = i0; i < Math.min(h.time.length, i0 + 30); i++) idx.push(i);
    const CW = 54, W = idx.length * CW, H = 224;
    const temps = idx.map((i, k) => (k === 0 ? S.wx.current.temperature_2m : h.temperature_2m[i]));
    const lo = Math.min(...temps), hi = Math.max(...temps), span = Math.max(3, hi - lo);
    const yT = t => 140 - (t - lo) / span * 50;
    const pts = temps.map((t, k) => [k * CW + CW / 2, yT(t)]);
    const line = smooth(pts);
    const stops = temps.map((t, k) => `<stop offset="${(k / Math.max(1, temps.length - 1)).toFixed(3)}" stop-color="${tColor(t)}"/>`).join('');
    let g = `<defs><linearGradient id="hg" gradientUnits="userSpaceOnUse" x1="${CW / 2}" x2="${W - CW / 2}" y1="0" y2="0">${stops}</linearGradient>
      <linearGradient id="hgf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".1"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>`;
    g += `<path d="${line}L${pts.at(-1)[0]} 152L${pts[0][0]} 152z" fill="url(#hgf)"/>`;
    g += `<path d="${line}" fill="none" stroke="url(#hg)" stroke-width="3" stroke-linecap="round"/>`;
    idx.forEach((i, k) => {
      const x = k * CW + CW / 2, pop = h.precipitation_probability[i] ?? 0;
      g += `<text class="h-hour ${k === 0 ? 'now' : ''}" x="${x}" y="14" text-anchor="middle">${k === 0 ? 'NOW' : hourL(h.time[i])}</text>`;
      g += `<svg x="${x - 15}" y="22" width="30" height="30" viewBox="0 0 64 64">${iconG(h.weather_code[i], h.is_day[i])}</svg>`;
      g += `<text class="h-temp" x="${x}" y="${(pts[k][1] - 10).toFixed(1)}" text-anchor="middle">${fT(temps[k])}</text>`;
      g += `<circle cx="${x}" cy="${pts[k][1].toFixed(1)}" r="${k === 0 ? 4.5 : 2.5}" fill="${k === 0 ? '#fff' : tColor(temps[k])}"/>`;
      const bh = Math.max(2, pop / 100 * 34);
      g += `<rect x="${x - 9}" y="${(200 - bh).toFixed(1)}" width="18" height="${bh.toFixed(1)}" rx="3" fill="${pop >= 20 ? '#4fa8ff' : 'rgba(255,255,255,.1)'}" opacity="${pop >= 20 ? (0.35 + pop / 160).toFixed(2) : 1}"/>`;
      if (pop >= 20) g += `<text class="h-pop" x="${x}" y="216" text-anchor="middle">${Math.round(pop / 5) * 5}%</text>`;
    });
    // Sunrise / sunset markers
    const t0 = h.time[i0], t1 = h.time[idx.at(-1)] + 3600, nowS = Date.now() / 1000;
    d.time.forEach((_, k) => {
      for (const [ts, up] of [[d.sunrise[k], 1], [d.sunset[k], 0]]) {
        if (ts <= Math.max(t0, nowS) || ts >= t1 - 3600) continue;
        const x = (ts - t0) / 3600 * CW + CW / 2;
        g += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="60" y2="200" stroke="var(--a1)" stroke-dasharray="2 3" opacity=".6"/>`;
        g += `<text class="h-sun" x="${(x + 4).toFixed(1)}" y="164">${up ? '↑' : '↓'} ${timeL(ts).replace(/\s/g, '').toLowerCase()}</text>`;
      }
    });
    $('#hourly').innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${g}</svg>`;
  }

  function renderDaily() {
    const d = S.wx.daily;
    const lo = Math.min(...d.temperature_2m_min.filter(ok)), hi = Math.max(...d.temperature_2m_max.filter(ok));
    const span = Math.max(1, hi - lo), RH = 150, PAD = 22;
    const y = t => PAD + (hi - t) / span * (RH - 2 * PAD);
    const cur = S.wx.current.temperature_2m;
    $('#daily').innerHTML = `<div class="days">${d.time.map((t, i) => {
      const mn = d.temperature_2m_min[i], mx = d.temperature_2m_max[i], pop = d.precipitation_probability_max[i];
      const top = y(mx), bot = y(mn);
      const dot = i === 0 && ok(cur) ? `<i class="nowdot" style="top:${clamp(y(cur), top, bot).toFixed(1)}px"></i>` : '';
      return `<button class="day ${i === S.daySel ? 'sel' : ''}" data-i="${i}">
        <span class="dn">${i === 0 ? 'Today' : dayL(t)}</span><span class="dd">${fmt('dm', { day: 'numeric', month: 'numeric' }).format(t * 1000)}</span>
        ${icon(d.weather_code[i], 1, 'ic')}<span class="dp">${pop >= 20 ? Math.round(pop / 5) * 5 + '%' : ''}</span>
        <span class="rng"><span class="hi" style="top:${(top - 20).toFixed(1)}px">${fT(mx)}</span>
          <span class="cap" style="top:${top.toFixed(1)}px;height:${Math.max(8, bot - top).toFixed(1)}px;background:linear-gradient(180deg,${tColor(mx)},${tColor(mn)})"></span>${dot}
          <span class="lo" style="top:${(bot + 2).toFixed(1)}px">${fT(mn)}</span></span></button>`;
    }).join('')}</div>`;
    renderDayDetail();
  }

  function renderDayDetail() {
    const d = S.wx.daily, i = S.daySel;
    const dl = d.daylight_duration[i];
    $('#day-detail').innerHTML = `<div class="dd-head"><b>${i === 0 ? 'Today' : fmt('wdl', { weekday: 'long' }).format(d.time[i] * 1000)}</b>
        <span>${condText(d.weather_code[i], 1)} · ${fT(d.temperature_2m_max[i])} / ${fT(d.temperature_2m_min[i])}</span></div>
      <div class="kv">
        <div><small>Precip</small><b>${fP(d.precipitation_sum[i])} ${U.prU()}</b></div>
        <div><small>Chance</small><b>${ok(d.precipitation_probability_max[i]) ? Math.round(d.precipitation_probability_max[i]) : '--'}%</b></div>
        <div><small>UV max</small><b>${ok(d.uv_index_max[i]) ? Math.round(d.uv_index_max[i]) : '--'}</b></div>
        <div><small>Wind</small><b>${fW(d.wind_speed_10m_max[i])} ${U.windU()}</b></div>
        <div><small>Gusts</small><b>${fW(d.wind_gusts_10m_max[i])} ${U.windU()}</b></div>
        <div><small>Daylight</small><b>${ok(dl) ? `${Math.floor(dl / 3600)}h ${Math.round(dl % 3600 / 60)}m` : '--'}</b></div>
      </div>`;
  }
  $('#daily').addEventListener('click', e => {
    const b = e.target.closest('.day');
    if (!b) return;
    S.daySel = +b.dataset.i;
    document.querySelectorAll('.day').forEach(x => x.classList.toggle('sel', x === b));
    renderDayDetail();
  });

  function renderNotes() {
    const p = S.local?.periods || [];
    $('#p-notes').hidden = !p.length;
    $('#notes-src').textContent = S.local?.src === 'eccc' ? `Env. Canada${S.local.city ? ' · ' + S.local.city : ''}` : 'NWS';
    $('#notes').innerHTML = p.slice(0, 3).map(x => `<div class="note-p"><b>${esc(x.name)}</b><p>${esc(x.text)}</p></div>`).join('');
  }

  /* ---- Detail tiles ---- */
  let tileN = 5;
  const tile = (title, body, cls = '') => `<section class="panel ${cls}"><header class="ph"><span class="ph-n mono">${String(++tileN).padStart(2, '0')}</span><span class="ph-t">${title}</span></header>${body}</section>`;
  function ring(frac, color, text) {
    const r = 34, C = 2 * Math.PI * r, f = clamp(frac, 0, 1);
    return `<svg class="ring" viewBox="0 0 84 84"><circle cx="42" cy="42" r="${r}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="8"/>
      <circle cx="42" cy="42" r="${r}" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${(C * f).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 42 42)"/>
      <text x="42" y="49" text-anchor="middle" fill="#fff" font-size="21" font-weight="600" font-family="Grotesk">${text}</text></svg>`;
  }

  function renderTiles() {
    if (!S.wx) return;
    tileN = S.local?.periods?.length ? 5 : 4;
    const c = S.wx.current, h = S.wx.hourly, d = S.wx.daily, i0 = nowIdx(h.time);
    const out = [];
    const nowS = Date.now() / 1000;

    // Wind
    const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    const wd = c.wind_direction_10m ?? 0, ws = c.wind_speed_10m, wdTxt = dirs[Math.round(wd / 22.5) % 16];
    const beau = ws < 2 ? 'Calm' : ws < 12 ? 'Light breeze' : ws < 29 ? 'Moderate breeze' : ws < 50 ? 'Strong wind' : ws < 75 ? 'Gale' : 'Storm-force wind';
    let ticks = '';
    for (let a = 0; a < 360; a += 10) {
      const r = a * Math.PI / 180, major = a % 90 === 0, r1 = major ? 50 : 54;
      ticks += `<line x1="${(64 + Math.sin(r) * r1).toFixed(1)}" y1="${(64 - Math.cos(r) * r1).toFixed(1)}" x2="${(64 + Math.sin(r) * 58).toFixed(1)}" y2="${(64 - Math.cos(r) * 58).toFixed(1)}" stroke="rgba(255,255,255,${major ? 0.7 : 0.2})" stroke-width="${major ? 2 : 1}"/>`;
    }
    const dial = `<svg class="dial" viewBox="0 0 128 128">${ticks}
      ${['N', 'E', 'S', 'W'].map((l, k) => `<text x="${(64 + Math.sin(k * Math.PI / 2) * 40).toFixed(1)}" y="${(68 - Math.cos(k * Math.PI / 2) * 40).toFixed(1)}" fill="rgba(255,255,255,.55)" font-size="10" font-family="Mono" text-anchor="middle">${l}</text>`).join('')}
      <g transform="rotate(${wd + 180} 64 64)"><path d="M64 14l7 15h-14z" fill="var(--a1)"/><line x1="64" y1="26" x2="64" y2="104" stroke="var(--a1)" stroke-width="2.5"/><circle cx="64" cy="108" r="4" fill="none" stroke="var(--a1)" stroke-width="2.5"/></g>
      <circle cx="64" cy="64" r="15" fill="#0f1116"/><text x="64" y="68" fill="#fff" font-size="10" font-family="Mono" text-anchor="middle">${wdTxt}</text></svg>`;
    out.push(tile('Wind', `<div class="split"><div><div class="val">${fW(ws)}<small>${U.windU()}</small></div><div class="lbl">${beau}</div>
      <div class="desc">Gusts ${fW(c.wind_gusts_10m)} ${U.windU()}<br>From the ${wdTxt}</div></div>${dial}</div>`, 'wide'));

    // UV
    const uv = ok(c.uv_index) ? c.uv_index : h.uv_index[i0] ?? 0;
    const uvCat = uv < 3 ? 'Low' : uv < 6 ? 'Moderate' : uv < 8 ? 'High' : uv < 11 ? 'Very high' : 'Extreme';
    const uvCol = uv < 3 ? '#3ee08f' : uv < 6 ? '#f5d142' : uv < 8 ? '#ff9a3c' : uv < 11 ? '#ff4d5e' : '#b47cff';
    let uvNote = 'Low for the rest of today.';
    const todayEnd = d.time[1] ?? nowS + 86400;
    const high = h.time.map((t, k) => [t, h.uv_index[k]]).filter(([t, v]) => t >= h.time[i0] && t < todayEnd && v >= 3);
    if (high.length) uvNote = uv >= 3 ? `Protection until ${hourL(high.at(-1)[0] + 3600)}.` : `Protection ${hourL(high[0][0])}–${hourL(high.at(-1)[0] + 3600)}.`;
    out.push(tile('UV index', `${ring(uv / 11, uvCol, Math.round(uv))}<div class="lbl" style="margin-top:8px">${uvCat}</div><div class="desc">${uvNote}</div>`));

    // Air quality
    const aq = S.aq?.current;
    if (aq && ok(aq.us_aqi)) {
      const v = aq.us_aqi;
      const [cat, col] = v <= 50 ? ['Good', '#3ee08f'] : v <= 100 ? ['Moderate', '#f5d142'] : v <= 150 ? ['Sensitive groups', '#ff9a3c'] : v <= 200 ? ['Unhealthy', '#ff4d5e'] : v <= 300 ? ['Very unhealthy', '#b47cff'] : ['Hazardous', '#9b1c3a'];
      out.push(tile('Air quality', `${ring(v / 300, col, Math.round(v))}<div class="lbl" style="margin-top:8px">${cat}</div><div class="desc">PM2.5 ${ok(aq.pm2_5) ? Math.round(aq.pm2_5) : '--'} µg/m³</div>`));
    } else out.push(tile('Air quality', `<div class="val">--</div><div class="desc">${S.aq === null ? 'Loading…' : 'Unavailable here'}</div>`));

    // Feels like
    const diff = c.apparent_temperature - c.temperature_2m;
    const feelsNote = Math.abs(diff) < 1.5 ? 'Close to the actual temperature.'
      : diff < 0 ? (c.wind_speed_10m > 10 ? 'Wind chill is making it feel colder.' : 'Feels cooler than it is.')
        : (c.relative_humidity_2m > 50 ? 'Humidity is making it feel warmer.' : 'Sun is making it feel warmer.');
    out.push(tile('Feels like', `<div class="val">${fT(c.apparent_temperature)}</div><div class="subline" style="margin-top:4px">actual ${fT(c.temperature_2m)}</div><div class="desc">${feelsNote}</div>`));

    // Humidity
    const rh = c.relative_humidity_2m;
    out.push(tile('Humidity', `<div class="split"><div><div class="val">${ok(rh) ? Math.round(rh) : '--'}<small>%</small></div><div class="subline" style="margin-top:4px">dew pt ${fT(c.dew_point_2m)}</div></div><div class="vbar"><i style="height:${ok(rh) ? rh : 0}%"></i></div></div>
      <div class="desc">${c.dew_point_2m > 18 ? 'Muggy.' : c.dew_point_2m > 12 ? 'A little humid.' : c.dew_point_2m < 2 ? 'Dry air.' : 'Comfortable.'}</div>`));

    // Pressure with sparkline (past 24 h → next 48 h)
    const p0 = c.pressure_msl, p3 = h.pressure_msl[i0 - 3];
    const dp = ok(p0) && ok(p3) ? p0 - p3 : 0;
    const trend = dp > 1 ? 'Rising' : dp < -1 ? 'Falling' : 'Steady';
    const ps = h.pressure_msl.map((v, k) => [h.time[k], v]).filter(([, v]) => ok(v));
    let spark = '';
    if (ps.length > 4 && ok(p0)) {
      const pl = Math.min(...ps.map(p => p[1])), ph = Math.max(...ps.map(p => p[1])), pspan = Math.max(2, ph - pl);
      const W = 320, H = 56, tA = ps[0][0], tB = ps.at(-1)[0];
      const px = t => (t - tA) / (tB - tA) * W, py = v => 6 + (ph - v) / pspan * (H - 12);
      const nx = px(nowS);
      spark = `<svg class="spark" viewBox="0 0 ${W} ${H + 14}"><path d="${smooth(ps.map(([t, v]) => [px(t), py(v)]))}" fill="none" stroke="var(--a1)" stroke-width="2"/>
        <line x1="${nx.toFixed(1)}" x2="${nx.toFixed(1)}" y1="0" y2="${H}" stroke="rgba(255,255,255,.35)" stroke-dasharray="2 3"/><circle cx="${nx.toFixed(1)}" cy="${py(p0).toFixed(1)}" r="4" fill="#fff"/>
        <text class="axis" x="0" y="${H + 12}">-24h</text><text class="axis" x="${nx.toFixed(1)}" y="${H + 12}" text-anchor="middle">now</text><text class="axis" x="${W}" y="${H + 12}" text-anchor="end">+48h</text></svg>`;
    }
    out.push(tile('Pressure', `<div class="split"><div class="val">${fPres(p0)}<small>${U.presU()}</small></div><span class="tag">${trend === 'Rising' ? '↗' : trend === 'Falling' ? '↘' : '→'} ${trend}</span></div>${spark}`, 'wide'));

    // Visibility
    const vis = c.visibility, visV = ok(vis) ? U.vis(vis) : null;
    const visNote = !ok(vis) ? '' : vis >= 16000 ? 'Crystal clear.' : vis >= 10000 ? 'Clear.' : vis >= 4000 ? 'Light haze.' : vis >= 1000 ? 'Mist or haze.' : 'Fog — visibility is poor.';
    out.push(tile('Visibility', `<div class="val">${visV == null ? '--' : visV >= 10 ? Math.round(visV) : visV.toFixed(1)}<small>${U.visU()}</small></div><div class="desc">${visNote}</div>`));

    // Precipitation totals
    let past = 0, next = 0;
    h.time.forEach((t, k) => {
      const v = h.precipitation[k] ?? 0;
      if (t + 3600 <= nowS && t >= nowS - 86400) past += v;
      else if (t >= h.time[i0] && t < h.time[i0] + 86400) next += v;
    });
    out.push(tile('Precip', `<div class="val">${fP(past)}<small>${U.prU()}</small></div><div class="subline" style="margin-top:4px">last 24 h</div>
      <div class="desc">${next >= 0.1 ? `${fP(next)} ${U.prU()} expected next 24 h.` : 'None expected next 24 h.'}</div>`));

    // Sun
    const rise = d.sunrise[0], set = d.sunset[0];
    const f = clamp((nowS - rise) / (set - rise), 0, 1), up = nowS > rise && nowS < set;
    const arcPath = upto => {
      let p = '';
      for (let k = 0; k <= 40 * upto; k++) { const q = k / 40; p += `${k ? 'L' : 'M'}${(14 + 292 * q).toFixed(1)} ${(70 - 56 * Math.sin(Math.PI * q)).toFixed(1)}`; }
      return p;
    };
    const sx = 14 + 292 * f, sy = 70 - 56 * Math.sin(Math.PI * f);
    const dl = d.daylight_duration[0];
    out.push(tile('Sun', `<svg class="arc" viewBox="0 0 320 96"><line x1="0" x2="320" y1="70" y2="70" stroke="rgba(255,255,255,.2)"/>
      <path d="${arcPath(1)}" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="2" stroke-dasharray="3 4"/>
      ${up ? `<path d="${arcPath(f)}" fill="none" stroke="#ffc23d" stroke-width="2.5"/>` : ''}
      <circle cx="${sx.toFixed(1)}" cy="${(up ? sy : 70).toFixed(1)}" r="7" fill="${up ? '#ffc23d' : 'rgba(255,255,255,.4)'}"/>
      <text class="axis" x="14" y="90">↑ ${timeL(rise)}</text><text class="axis" x="306" y="90" text-anchor="end">↓ ${timeL(set)}</text>
      <text class="axis" x="160" y="90" text-anchor="middle">${ok(dl) ? `${Math.floor(dl / 3600)}h ${Math.round(dl % 3600 / 60)}m daylight` : ''}</text></svg>`, 'wide'));

    // Moon
    const mp = moonPhase(new Date());
    out.push(tile('Moon', `<div class="split" style="justify-content:flex-start;gap:16px">${moonSVG(mp.phase, S.loc?.lat ?? 1)}<div>
      <div class="lbl" style="font-size:18px">${mp.name}</div><div class="subline">${Math.round(mp.illum * 100)}% lit · full ${fmt('md', { month: 'short', day: 'numeric' }).format(mp.nextFull)}</div></div></div>`, 'wide'));

    // Nearest observation (ECCC city page / NWS station)
    const o = S.local?.obs;
    if (o) {
      const where = o.kmIsCity ? 'Environment Canada' : `${esc(o.id)} · ${U.dist(o.km).toFixed(1)} ${U.distU()} away`;
      out.push(tile('Observed', `<div class="lbl">${esc(o.name)}</div><div class="subline">${where}${o.at ? ' · ' + ago(o.at) : ''}</div>
        <div class="obs"><div><small>Temp</small><b>${fT(o.temp)}</b></div><div><small>Hum</small><b>${ok(o.rh) ? Math.round(o.rh) + '%' : '--'}</b></div>
        <div><small>Wind</small><b>${ok(o.wind) ? fW(o.wind) : '--'}</b></div><div><small>${ok(o.pres) ? 'Press' : 'Dew'}</small><b>${ok(o.pres) ? fPres(o.pres) : fT(o.dew)}</b></div></div>
        ${o.text ? `<div class="desc">${esc(o.text)}</div>` : ''}`, 'wide'));
    }
    $('#tiles').innerHTML = out.join('');
  }

  function moonPhase(date) {
    const syn = 29.530588853, ref = Date.UTC(2000, 0, 6, 18, 14);
    const phase = (((date - ref) / 86400000 / syn) % 1 + 1) % 1;
    const illum = (1 - Math.cos(2 * Math.PI * phase)) / 2;
    const names = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
    const toFull = ((0.5 - phase + 1) % 1) * syn;
    return { phase, illum, name: names[Math.round(phase * 8) % 8], nextFull: new Date(date.getTime() + (toFull < 0.5 ? toFull + syn : toFull) * 86400000) };
  }
  function moonSVG(p, lat) {
    const r = 30, cx = 36, cy = 36, rx = Math.abs(Math.cos(2 * Math.PI * p)) * r;
    const d = p < 0.5
      ? `M${cx} ${cy - r}A${r} ${r} 0 0 1 ${cx} ${cy + r}A${rx} ${r} 0 0 ${p < 0.25 ? 0 : 1} ${cx} ${cy - r}z`
      : `M${cx} ${cy - r}A${r} ${r} 0 0 0 ${cx} ${cy + r}A${rx} ${r} 0 0 ${p < 0.75 ? 0 : 1} ${cx} ${cy - r}z`;
    return `<svg class="moon" viewBox="0 0 72 72"><g ${lat < 0 ? 'transform="matrix(-1 0 0 1 72 0)"' : ''}><circle cx="${cx}" cy="${cy}" r="${r}" fill="rgba(255,255,255,.08)"/><path d="${d}" fill="#E8ECFA"/></g></svg>`;
  }

  function renderFooter() {
    const t = S.fetchedAt ? `Updated ${ago(S.fetchedAt)}` : '';
    $('#updated').textContent = t;
    $('#now-updated').textContent = t;
  }

  /* ---------------- Ambient effects (rain / snow / stars) ---------------- */
  const FX = (() => {
    const cv = $('#fx'), ctx = cv.getContext('2d');
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let mode = 'none', parts = [], raf = 0, W = 0, H = 0, intensity = 0;
    function size() {
      const dpr = Math.min(2, devicePixelRatio || 1);
      W = innerWidth; H = innerHeight;
      cv.width = W * dpr; cv.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    }
    function seed() {
      const n = mode === 'rain' ? Math.round(30 + 120 * intensity) : mode === 'snow' ? Math.round(30 + 70 * intensity) : mode === 'stars' ? 60 : 0;
      parts = Array.from({ length: n }, () => ({ x: Math.random() * W, y: Math.random() * H, z: 0.4 + Math.random() * 0.6, ph: Math.random() * 6.28 }));
    }
    function frame(ts) {
      ctx.clearRect(0, 0, W, H);
      if (mode === 'rain') {
        ctx.strokeStyle = 'rgba(160,200,255,.28)'; ctx.lineCap = 'round'; ctx.lineWidth = 1;
        ctx.beginPath();
        for (const p of parts) {
          p.y += 13 * p.z; p.x -= 1.2 * p.z;
          if (p.y > H) { p.y = -20; p.x = Math.random() * W; }
          ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + 1.2 * p.z, p.y - 12 * p.z);
        }
        ctx.stroke();
      } else if (mode === 'snow') {
        ctx.fillStyle = 'rgba(255,255,255,.75)';
        for (const p of parts) {
          p.y += 1.1 * p.z; p.x += Math.sin(ts / 1200 + p.ph) * 0.45;
          if (p.y > H) { p.y = -5; p.x = Math.random() * W; }
          ctx.beginPath(); ctx.arc(p.x, p.y, 2 * p.z, 0, 6.283); ctx.fill();
        }
      } else if (mode === 'stars') {
        for (const p of parts) {
          if (p.y > H * 0.55) continue;
          ctx.fillStyle = `rgba(255,255,255,${(0.2 + 0.5 * p.z * (0.6 + 0.4 * Math.sin(ts / 900 + p.ph))).toFixed(2)})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.z, 0, 6.283); ctx.fill();
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

  /* ---------------- Radar (MapLibre + OpenFreeMap) ---------------- */
  const Radar = (() => {
    const STYLE = 'https://tiles.openfreemap.org/styles/dark';
    const GEOMET = 'https://geo.weather.gc.ca/geomet';
    const SRC = {
      'eccc-rain': { label: 'ECCC · Rain', layer: 'RADAR_1KM_RRAI', legend: 'linear-gradient(90deg,#a5f3fc,#38bdf8,#2563eb,#22c55e,#facc15,#f97316,#dc2626,#a21caf)' },
      'eccc-snow': { label: 'ECCC · Snow', layer: 'RADAR_1KM_RSNO', legend: 'linear-gradient(90deg,#e0f2fe,#93c5fd,#60a5fa,#3b82f6,#8b5cf6,#c026d3)' },
      iem: { label: 'NOAA NEXRAD', legend: 'linear-gradient(90deg,#4ade80,#16a34a,#facc15,#f97316,#dc2626,#c026d3)' },
      rv: { label: 'RainViewer', legend: 'linear-gradient(90deg,#9be7ff,#3fa9f5,#1f5fd1,#f5d742,#f5732f,#e13a3a)' },
    };
    let map, ready = false, marker, frames = [], idx = 0, timer = 0, playing = false, firstSymbol, loadSeq = 0;
    let center = null, cc = null, temp = null, source = null, forced = null, loadedAt = 0, alerts = [];
    const wrap = $('#radar-wrap'), slot = $('#radar-slot'), range = $('#radar-range'), playBtn = $('#radar-play');
    const timeEl = $('#radar-time'), srcEl = $('#radar-src'), ticksEl = $('#radar-ticks'), msg = $('#map-msg');
    const HANDLERS = ['dragPan', 'scrollZoom', 'boxZoom', 'doubleClickZoom', 'touchZoomRotate', 'keyboard'];

    function showMsg(t) { msg.hidden = !t; msg.textContent = t || ''; }

    function init() {
      if (map) return true;
      if (!window.maplibregl) { showMsg('Map library failed to load'); return false; }
      try {
        map = new maplibregl.Map({
          container: 'map', style: STYLE, center: [center[1], center[0]], zoom: 7, minZoom: 2, maxZoom: 12,
          attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, touchPitch: false, fadeDuration: 0,
        });
      } catch { showMsg('The radar map needs WebGL, which isn’t available here'); return false; }
      setInteractive(false);
      map.on('load', () => { restyle(); ready = true; showMsg(''); drawAlerts(); load(); });
      map.on('error', e => { if (!ready && !e.sourceId) showMsg('Map couldn’t load — check your connection'); });
      return true;
    }

    // Tune OpenFreeMap's dark style to the app's palette
    function restyle() {
      try {
        for (const l of map.getStyle().layers) {
          if (!firstSymbol && l.type === 'symbol') firstSymbol = l.id;
          if (l.type === 'background') map.setPaintProperty(l.id, 'background-color', '#0d0f14');
          else if (l.type === 'fill' && /water/.test(l.id)) map.setPaintProperty(l.id, 'fill-color', '#121924');
          else if (l.type === 'line' && /boundary|admin/.test(l.id)) map.setPaintProperty(l.id, 'line-color', 'rgba(255,255,255,.3)');
        }
      } catch { /* style differences are cosmetic */ }
    }

    function setInteractive(on) {
      HANDLERS.forEach(k => map[k] && (on ? map[k].enable() : map[k].disable()));
      if (on) map.touchZoomRotate.disableRotation();
    }
    function expand() {
      if (!map) return;
      document.body.appendChild(wrap);
      wrap.classList.add('full');
      setInteractive(true);
      requestAnimationFrame(() => map.resize());
      history.pushState({ radar: 1 }, '');
    }
    function collapse(fromPop) {
      if (!wrap.classList.contains('full')) return;
      wrap.classList.remove('full');
      slot.appendChild(wrap);
      setInteractive(false);
      requestAnimationFrame(() => { map.resize(); center && map.jumpTo({ center: [center[1], center[0]], zoom: 7 }); });
      if (fromPop !== true && history.state?.radar) history.back();
    }
    addEventListener('popstate', () => collapse(true));

    function available() {
      const [lat, lon] = center, list = [];
      if (inNorthAmerica(lat, lon)) list.push('eccc-rain', 'eccc-snow');
      if (inConus(lat, lon)) list.push('iem');
      list.push('rv');
      return list;
    }
    function pick() {
      if (forced && available().includes(forced)) return forced;
      const [lat, lon] = center;
      const eccc = temp != null && temp <= 0.5 ? 'eccc-snow' : 'eccc-rain';
      if (cc === 'CA') return eccc;
      if (cc === 'US' && inConus(lat, lon)) return 'iem';
      if (inNorthAmerica(lat, lon)) return eccc;
      return 'rv';
    }

    function setLocation(lat, lon, country, curTemp) {
      const moved = !center || haversine(center[0], center[1], lat, lon) > 1;
      center = [lat, lon]; cc = country || null; temp = curTemp ?? null;
      if (!init()) return;
      if (moved) map.jumpTo({ center: [lon, lat], zoom: 7 });
      if (!marker) {
        const el = document.createElement('div'); el.className = 'me';
        marker = new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(map);
      } else marker.setLngLat([lon, lat]);
      if (ready && (pick() !== source || Date.now() - loadedAt > 4 * 60e3)) load();
    }

    // ECCC publishes a frame every 6 minutes; read the real timeline from GetCapabilities
    async function ecccTimes(layer, n) {
      const step = 6 * 60e3;
      try {
        const xml = await (await fetch(`${GEOMET}?service=WMS&version=1.3.0&request=GetCapabilities&layer=${layer}`)).text();
        const spec = xml.match(/<Dimension[^>]*name="time"[^>]*>([^<]+)<\/Dimension>/i)[1].trim();
        if (spec.includes(',')) return spec.split(',').map(s => Date.parse(s.split('/')[0].trim())).filter(Number.isFinite).slice(-n);
        const [s, e, p] = spec.split('/');
        const pm = /PT(\d+)M/.exec(p || ''), st = pm ? +pm[1] * 60e3 : step;
        const out = [];
        for (let t = Date.parse(e); t >= Date.parse(s) && out.length < n; t -= st) out.unshift(t);
        if (out.length) return out;
      } catch { /* fall back to a computed timeline */ }
      const end = Math.floor((Date.now() - 10 * 60e3) / step) * step;
      return Array.from({ length: n }, (_, i) => end - (n - 1 - i) * step);
    }

    async function load() {
      if (!ready || !center) return;
      const seq = ++loadSeq, key = pick();
      stop();
      let fr = [];
      try {
        if (key.startsWith('eccc')) {
          const layer = SRC[key].layer;
          fr = (await ecccTimes(layer, 16)).map(t => ({
            t, size: 512, attr: '© Environment and Climate Change Canada',
            url: `${GEOMET}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&FORMAT=image/png&TRANSPARENT=TRUE&LAYERS=${layer}&STYLES=&CRS=EPSG:3857&WIDTH=512&HEIGHT=512&BBOX={bbox-epsg-3857}&TIME=${new Date(t).toISOString().replace('.000Z', 'Z')}`,
          }));
        } else if (key === 'iem') {
          const step = 5 * 60e3, base = Math.floor((Date.now() - 2 * 60e3) / step) * step;
          for (let m = 55; m >= 0; m -= 5) {
            const name = m === 0 ? 'nexrad-n0q-900913' : `nexrad-n0q-900913-m${String(m).padStart(2, '0')}m`;
            fr.push({ t: base - m * 60e3, attr: 'NEXRAD via Iowa Environmental Mesonet', url: `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/${name}/{z}/{x}/{y}.png?_=${base}` });
          }
        } else {
          const j = await getJSON('https://api.rainviewer.com/public/weather-maps.json');
          fr = (j.radar?.past || []).map(f => ({ t: f.time * 1000, maxzoom: 7, attr: '<a href="https://www.rainviewer.com">Weather data by RainViewer</a>', url: `${j.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png` }));
        }
      } catch {
        timeEl.textContent = 'offline';
        return;
      }
      if (seq !== loadSeq || !fr.length) return; // superseded while loading
      clearFrames();
      source = key; loadedAt = Date.now(); frames = fr;
      srcEl.textContent = SRC[key].label;
      $('#radar-legend').style.setProperty('--legend', SRC[key].legend);
      $('#legend-l').textContent = key === 'eccc-snow' ? 'Light snow' : 'Light';
      const before = map.getLayer('alerts-fill') ? 'alerts-fill' : firstSymbol;
      frames.forEach((f, i) => {
        map.addSource('rf' + i, { type: 'raster', tiles: [f.url], tileSize: f.size || 256, maxzoom: f.maxzoom || 12, attribution: f.attr });
        map.addLayer({ id: 'rf' + i, type: 'raster', source: 'rf' + i, paint: { 'raster-opacity': 0, 'raster-opacity-transition': { duration: 0 }, 'raster-fade-duration': 0 } }, before);
      });
      range.max = frames.length - 1;
      ticksEl.innerHTML = frames.map(() => '<i></i>').join('');
      idx = 0;
      show(frames.length - 1);
      setTimeout(() => seq === loadSeq && play(), 1500);
    }
    function clearFrames() {
      for (let i = 0; i < 40; i++) {
        if (map.getLayer('rf' + i)) map.removeLayer('rf' + i);
        if (map.getSource('rf' + i)) map.removeSource('rf' + i);
      }
      frames = [];
    }

    function show(i) {
      if (!frames.length) return;
      if (map.getLayer('rf' + idx)) map.setPaintProperty('rf' + idx, 'raster-opacity', 0);
      idx = (i + frames.length) % frames.length;
      map.setPaintProperty('rf' + idx, 'raster-opacity', 0.85);
      range.value = idx;
      [...ticksEl.children].forEach((el, k) => { el.className = k === idx ? 'cur' : k < idx ? 'on' : ''; });
      const f = frames[idx], mins = Math.round((f.t - Date.now()) / 60000);
      timeEl.innerHTML = `${fmt('rt', { hour: 'numeric', minute: '2-digit' }).format(f.t)}<small>${idx === frames.length - 1 ? 'latest' : mins + ' min'}</small>`;
    }
    function play() {
      if (!frames.length || playing) return;
      playing = true; playBtn.classList.add('playing');
      const tick = () => {
        if (!playing) return;
        const next = (idx + 1) % frames.length;
        show(next);
        timer = setTimeout(tick, next === frames.length - 1 ? 1800 : 420);
      };
      timer = setTimeout(tick, 420);
    }
    function stop() { playing = false; clearTimeout(timer); playBtn.classList.remove('playing'); }

    function setAlerts(list) { alerts = list || []; drawAlerts(); }
    function drawAlerts() {
      if (!ready) return;
      const colours = { red: '#ff4d5e', orange: '#ff9a3c', yellow: '#f5d142' };
      const fc = { type: 'FeatureCollection', features: alerts.filter(a => a.geometry?.type).map(a => ({ type: 'Feature', geometry: a.geometry, properties: { c: colours[a.color] || '#9aa3b2' } })) };
      if (map.getSource('alerts')) map.getSource('alerts').setData(fc);
      else {
        map.addSource('alerts', { type: 'geojson', data: fc });
        map.addLayer({ id: 'alerts-fill', type: 'fill', source: 'alerts', paint: { 'fill-color': ['get', 'c'], 'fill-opacity': 0.08 } }, firstSymbol);
        map.addLayer({ id: 'alerts-line', type: 'line', source: 'alerts', paint: { 'line-color': ['get', 'c'], 'line-width': 1.6 } }, firstSymbol);
      }
    }

    range.addEventListener('input', () => { stop(); show(+range.value); });
    playBtn.addEventListener('click', e => { e.stopPropagation(); playing ? stop() : play(); });
    $('#radar-tap').addEventListener('click', expand);
    $('#radar-close').addEventListener('click', collapse);
    $('#radar-locate').addEventListener('click', () => center && map?.flyTo({ center: [center[1], center[0]], zoom: 8, duration: 600 }));
    srcEl.addEventListener('click', () => {
      if (!center) return;
      const list = available();
      forced = list[(list.indexOf(source) + 1) % list.length];
      load();
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
    return { setLocation, setAlerts, expand, reload: () => ready && load() };
  })();

  /* ---------------- Places sheet ---------------- */
  const sheet = $('#sheet'), searchEl = $('#search');
  function openSheet(msgText) {
    const m = $('#sheet-msg');
    m.hidden = !msgText; m.textContent = msgText || '';
    sheet.classList.add('open'); sheet.setAttribute('aria-hidden', 'false');
    renderPlaces();
    if (msgText) setTimeout(() => searchEl.focus(), 350);
  }
  function closeSheet() {
    sheet.classList.remove('open'); sheet.setAttribute('aria-hidden', 'true');
    searchEl.value = ''; $('#search-results').innerHTML = ''; searchEl.blur();
  }

  async function renderPlaces() {
    const g = store.get('lastGps', null);
    const rows = [{ id: 'gps', name: 'My location', sub: g?.name && g.name !== 'My location' ? g.name : 'GPS', lat: g?.lat, lon: g?.lon, gps: true }, ...S.places];
    const draw = temps => {
      $('#place-list').innerHTML = rows.map((p, k) => `<div class="place ${S.sel === p.id ? 'sel' : ''}" data-id="${esc(p.id)}" role="button">
        <div class="p-ic">${temps?.[k] ? icon(temps[k].code, temps[k].day) : ''}</div>
        <div class="p-txt"><div class="p-name">${p.gps ? '<span class="live on"></span>' : ''}${esc(p.name)}</div><div class="p-sub">${esc(p.sub || '')}</div></div>
        <div class="p-t">${temps?.[k] ? fT(temps[k].t) : ''}</div>
        ${p.gps ? '' : `<button class="p-del" data-del="${esc(p.id)}" aria-label="Remove">×</button>`}</div>`).join('');
    };
    draw(null);
    const withCoords = rows.filter(r => ok(r.lat));
    if (!withCoords.length) return;
    try {
      const j = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${withCoords.map(r => r.lat.toFixed(3))}&longitude=${withCoords.map(r => r.lon.toFixed(3))}&current=temperature_2m,weather_code,is_day&timezone=auto`);
      const arr = Array.isArray(j) ? j : [j];
      const temps = rows.map(r => { const c = arr[withCoords.indexOf(r)]?.current; return c ? { t: c.temperature_2m, code: c.weather_code, day: c.is_day } : null; });
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
    S.loading = false; // let the new refresh supersede any in-flight one
    S.local = null; S.aq = null; S.daySel = 0;
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
      S.places.push({ id, name: r.name, sub: [r.admin1, r.country_code !== 'US' && r.country_code !== 'CA' ? r.country : ''].filter(Boolean).join(', '), lat: r.latitude, lon: r.longitude, cc: r.country_code || null });
      store.set('places', S.places);
    }
    selectPlace(id);
    closeSheet();
  });
  $('#loc-btn').addEventListener('click', () => openSheet());
  $('#sheet-close').addEventListener('click', closeSheet);
  $('.sheet-backdrop').addEventListener('click', closeSheet);

  /* ---------------- Misc UI ---------------- */
  $('#btn-units').addEventListener('click', () => {
    S.units = us() ? 'metric' : 'us';
    store.set('units', S.units);
    renderAll();
  });
  document.body.dataset.units = S.units;

  $('#dock').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'top') scrollTo({ top: 0, behavior: 'smooth' });
    if (b.dataset.act === 'radar') Radar.expand();
    if (b.dataset.act === 'places') openSheet();
  });

  addEventListener('scroll', () => $('#top').classList.toggle('solid', scrollY > 8), { passive: true });

  let toastT = 0;
  function toast(m) {
    const t = $('#toast');
    t.textContent = m; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3500);
  }

  const ptr = $('#ptr');
  function setSpin(on) {
    ptr.classList.toggle('spin', on);
    ptr.classList.toggle('on', on);
    if (!on) ptr.style.transform = '';
  }

  // Pull-to-refresh (home-screen web apps have none built in)
  let startY = null, pulled = 0;
  addEventListener('touchstart', e => {
    if (scrollY <= 0 && !sheet.classList.contains('open') && !$('#radar-wrap').classList.contains('full')) startY = e.touches[0].clientY;
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

  // Keep data fresh
  const stale = ms => Date.now() - S.fetchedAt > ms;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { if (stale(5 * 60e3)) refresh(); else Radar.reload(); }
  });
  setInterval(() => {
    renderFooter();
    if (!document.hidden && stale(10 * 60e3)) refresh();
    else if (S.wx && !document.hidden) { renderNowcast(); $('#now-clock').textContent = clock(); }
  }, 60e3);
  addEventListener('online', () => stale(60e3) && refresh());

  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (!standalone && /iPhone|iPad|iPod/.test(navigator.userAgent)) $('#install-hint').hidden = false;

  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});

  /* ---------------- Boot ---------------- */
  const snap = store.get('snap2', null);
  if (snap?.wx && snap.loc && (snap.loc.id === S.sel || (S.sel === 'gps' && snap.loc.gps))) {
    Object.assign(S, { loc: snap.loc, wx: snap.wx, aq: snap.aq, local: snap.local, fetchedAt: snap.at });
    renderAll();
    Radar.setLocation(snap.loc.lat, snap.loc.lon, snap.loc.cc, snap.wx.current?.temperature_2m);
    Radar.setAlerts(snap.local?.alerts);
  } else {
    document.body.classList.add('loading');
  }
  refresh();
})();
