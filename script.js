const CONFIG = {
  usgsSite: '07032000',            // Mississippi River at Memphis, TN
  startDate: '2019-01-01',
  threshold: -5,                   // low-water threshold (ft)
  streakDays: 7,                   // days in a row below threshold → alert
  segments: ['memphis', 'stlouis'],// USDA river segment, tried in this order
  demoDate: '2022-10-15',          // date the page opens on ('' = latest)
  analogYears: [2022, 2023],
  cacheKey: 'riverrate-data-v1',
  cacheHours: 24,
};

const COLORS = { river: '#1F5F8B', rate: '#D07A2E', warn: '#9A4512', grid: '#EFEBE2' };

// Page state
const state = {
  daily: [],        // [{date, level, iso: {year, week}}]
  weekly: [],       // [{key, start, level, rate}]
  date: null,       // 'YYYY-MM-DD'
  threshold: CONFIG.threshold,
  source: '',
};

let heroChart = null;
let mainChart = null;

//data helpers
const toDate = (s) => new Date(s + 'T00:00:00Z');
const toStr = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return toStr(d); };
const today = () => toStr(new Date());

function isoWeek(s) {
  const d = toDate(s);
  const day = (d.getUTCDay() + 6) % 7;           // Monday = 0
  d.setUTCDate(d.getUTCDate() - day + 3);        // Thursday of this week
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return { year, week, key: year + '-' + String(week).padStart(2, '0') };
}

function weekStart(s) {
  const day = (toDate(s).getUTCDay() + 6) % 7;
  return addDays(s, -day);
}

const fmtDate = (s, opts = { month: 'long', day: 'numeric', year: 'numeric' }) =>
  toDate(s).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });

const fmtFt = (v, sign = false) =>
  v === null || v === undefined ? '—' : (sign && v > 0 ? '+' : '') + v.toFixed(1).replace('-', '−') + ' ft';

// Load data API
async function fetchUsgs() {
  const params = new URLSearchParams({
    format: 'json',
    sites: CONFIG.usgsSite,
    parameterCd: '00065',          // gauge height, feet
    startDT: CONFIG.startDate,
    endDT: today(),
  });

  for (const service of ['dv', 'iv']) {
    const res = await fetch(`https://waterservices.usgs.gov/nwis/${service}/?${params}`);
    if (!res.ok) continue;
    const json = await res.json();
    const values = json?.value?.timeSeries?.[0]?.values?.[0]?.value ?? [];
    if (values.length) return averageByDay(values);
  }
  throw new Error('USGS returned no water level data');
}

function averageByDay(values) {
  const byDay = {};
  for (const v of values) {
    const val = parseFloat(v.value);
    if (isNaN(val) || val <= -999990) continue;  // USGS "no data" marker
    const day = v.dateTime.slice(0, 10);
    (byDay[day] ??= []).push(val);
  }
  return Object.keys(byDay).sort().map((date) => ({
    date,
    level: +(byDay[date].reduce((a, b) => a + b, 0) / byDay[date].length).toFixed(2),
  }));
}

async function fetchUsda() {
  const res = await fetch('https://agtransport.usda.gov/resource/deqi-uken.json?$limit=50000');
  if (!res.ok) throw new Error('USDA request failed (' + res.status + ')');
  const rows = await res.json();
  if (!rows.length) throw new Error('USDA returned no rows');

  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const keys = [...new Set(rows.slice(0, 200).flatMap(Object.keys))];
  console.log('USDA columns:', keys);

  const dateKey = keys.find((k) => norm(k).includes('date'));
  const locKey = keys.find((k) => ['location', 'segment', 'river', 'region', 'locationname'].includes(norm(k)));
  const rateKey = keys.find((k) => k !== dateKey && /rate|value/.test(norm(k)));
  if (!dateKey) throw new Error('USDA: no date column');

  for (const seg of CONFIG.segments) {
    const wideKey = keys.find((k) => norm(k).includes(seg));
    const rates = {};

    for (const r of rows) {
      let rate;
      if (wideKey) {
        rate = r[wideKey];                                   // one column per segment
      } else if (locKey && rateKey && norm(r[locKey] ?? '').includes(seg)) {
        rate = r[rateKey];                                   // location + rate columns
      }
      const n = parseFloat(rate);
      if (!isNaN(n) && r[dateKey]) rates[isoWeek(r[dateKey].slice(0, 10)).key] = n;
    }

    if (Object.keys(rates).length > 20) return { rates, segment: seg };
  }
  throw new Error('USDA: no Memphis or St. Louis rates found (see console for columns)');
}

async function loadData(force = false) {
  setStatus('Loading data from USGS and USDA…');

  if (!force) {
    try {
      const cached = JSON.parse(localStorage.getItem(CONFIG.cacheKey) || 'null');
      if (cached && Date.now() - cached.savedAt < CONFIG.cacheHours * 3600e3) {
        return { ...cached, fromCache: true };
      }
    } catch (e) { /* ignore */ }
  }

  const [daily, usda] = await Promise.all([fetchUsgs(), fetchUsda()]);
  const data = { daily, rates: usda.rates, segment: usda.segment, savedAt: Date.now() };
  try { localStorage.setItem(CONFIG.cacheKey, JSON.stringify(data)); } catch (e) { /* ignore */ }
  return data;
}

function sampleData() {
  let seed = 7;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const daily = [];
  for (let s = CONFIG.startDate; s <= today(); s = addDays(s, 1)) {
    const d = toDate(s);
    const doy = (d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000;
    let level = 12 * Math.cos(((doy - 100) / 365) * 2 * Math.PI) + 8 + (rnd() - 0.5) * 2;
    const y = d.getUTCFullYear();
    if ((y === 2022 || y === 2023) && doy > 250 && doy < 320) level -= 9 * Math.sin(((doy - 250) / 70) * Math.PI);
    daily.push({ date: s, level: +level.toFixed(2) });
  }
  const rates = {};
  daily.forEach((d, i) => {
    if (toDate(d.date).getUTCDay() !== 2) return;
    const lag = daily[Math.max(0, i - 14)].level;
    rates[isoWeek(d.date).key] = Math.round(450 + Math.max(0, -lag) * 180 + rnd() * 60);
  });
  return { daily, rates, segment: 'sample', sample: true };
}

function prepare({ daily, rates }) {
  state.daily = daily.map((d) => ({ ...d, iso: isoWeek(d.date) }));

  const weeks = {};
  for (const d of state.daily) {
    const w = (weeks[d.iso.key] ??= { key: d.iso.key, start: weekStart(d.date), levels: [] });
    w.levels.push(d.level);
  }
  state.weekly = Object.values(weeks)
    .map((w) => ({
      key: w.key,
      start: w.start,
      level: +(w.levels.reduce((a, b) => a + b, 0) / w.levels.length).toFixed(2),
      rate: rates[w.key] ?? null,
    }))
    .sort((a, b) => a.start.localeCompare(b.start));
}

const firstDate = () => state.daily[0].date;
const lastDate = () => state.daily[state.daily.length - 1].date;

function levelOn(date) {
  let found = null;
  for (const d of state.daily) { if (d.date > date) break; found = d.level; }
  return found;
}

function status(date) {
  const level = levelOn(date);
  const { year, week } = isoWeek(date);
  const past = state.daily
    .filter((d) => d.iso.week === week && d.iso.year >= year - 5 && d.iso.year < year)
    .map((d) => d.level);
  const avg = past.length ? past.reduce((a, b) => a + b, 0) / past.length : null;
  const diff = avg !== null && level !== null ? +(level - avg).toFixed(1) : null;
  const risk = diff === null ? 'unknown' : diff <= -2 ? 'high' : diff <= -1 ? 'medium' : 'low';
  return { level, avg, diff, risk };
}

function streak(date, threshold) {
  let n = 0;
  for (let i = state.daily.length - 1; i >= 0; i--) {
    const d = state.daily[i];
    if (d.date > date) continue;
    if (d.level >= threshold) break;
    n++;
  }
  return n;
}

function analogs(threshold) {
  return CONFIG.analogYears.map((year) => {
    let run = 0;
    let fired = null;
    for (const d of state.daily) {
      if (+d.date.slice(0, 4) !== year) continue;
      run = d.level < threshold ? run + 1 : 0;
      if (run === CONFIG.streakDays) { fired = d.date; break; }
    }
    if (!fired) return { year, fired: null };

    const start = weekStart(fired);
    const end = addDays(fired, 28);
    let before = null;
    let peak = null;
    for (const w of state.weekly) {
      if (w.rate === null) continue;
      if (w.start <= start) before = w.rate;
      if (w.start > start && w.start <= end) peak = Math.max(peak ?? 0, w.rate);
    }
    const change = before && peak ? Math.round(((peak - before) / before) * 100) : null;
    return { year, fired, before, peak, change };
  });
}

function correlation() {
  const out = [];
  for (let lag = 0; lag <= 4; lag++) {
    const x = [], y = [];
    for (let i = 0; i + lag < state.weekly.length; i++) {
      const rate = state.weekly[i + lag].rate;
      if (rate === null) continue;
      x.push(state.weekly[i].level);
      y.push(rate);
    }
    out.push({ lag, r: pearson(x, y) });
  }
  return out.filter((c) => c.r !== null).sort((a, b) => a.r - b.r)[0] ?? null;
}

function pearson(x, y) {
  const n = x.length;
  if (n < 3) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    dx += (x[i] - mx) ** 2;
    dy += (y[i] - my) ** 2;
  }
  return dx && dy ? +(num / Math.sqrt(dx * dy)).toFixed(2) : null;
}

function series(date, weeks) {
  const rows = state.weekly.filter((w) => w.start <= date).slice(-weeks);
  return {
    labels: rows.map((w) => w.start),
    level: rows.map((w) => w.level),
    rate: rows.map((w) => w.rate),
  };
}

const $ = (id) => document.getElementById(id);

const ICON_WARN = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4"/><path d="M12 17h.01"/></svg>';
const ICON_OK = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></svg>';

function analogChips(list) {
  return list.map((a) => {
    if (!a.fired) return `<span class="chip">${a.year}: threshold not reached</span>`;
    const change = a.change !== null ? `, rate ${a.change >= 0 ? '+' : ''}${a.change}% in 4 weeks` : '';
    return `<span class="chip">${a.year}: alert on ${fmtDate(a.fired, { month: 'short', day: 'numeric' })}${change}</span>`;
  }).join('');
}

function alertHtml(al, th, list, withChips) {
  const thTxt = fmtFt(th);
  if (al.active) {
    const chips = withChips ? `<div class="chips"><span>Last time this happened:</span>${analogChips(list)}</div>` : '';
    return `${ICON_WARN}<div><strong>Low-water alert.</strong> Below ${thTxt} for ${al.days} days in a row. Barge rates may rise over the next 2 weeks.${chips}</div>`;
  }
  const msg = al.days > 0
    ? `Below ${thTxt} for ${al.days} day${al.days === 1 ? '' : 's'}; the alert starts at ${CONFIG.streakDays}.`
    : `The river is above the ${thTxt} threshold.`;
  return `${ICON_OK}<div><strong>No alert.</strong> ${msg}</div>`;
}

function setRisk(el, risk) {
  el.className = 'risk risk-' + risk;
  el.lastElementChild.textContent = risk.charAt(0).toUpperCase() + risk.slice(1);
}

function render() {
  const date = state.date;
  const th = state.threshold;
  const st = status(date);
  const days = streak(date, th);
  const al = { days, active: days >= CONFIG.streakDays };
  const an = analogs(th);

  // Hero preview
  $('heroDate').textContent = 'Memphis gauge, ' + fmtDate(date, { month: 'short', day: 'numeric', year: 'numeric' });
  $('heroAlert').className = 'alert ' + (al.active ? 'on' : 'off');
  $('heroAlert').innerHTML = alertHtml(al, th, an, false);
  $('heroDiff').textContent = fmtFt(st.diff, true);
  setRisk($('heroRisk'), st.risk);
  $('heroAnalogs').innerHTML = '<span class="muted">Last time this happened:</span>' + analogChips(an);

  // Dashboard
  $('dashDate').textContent = fmtDate(date);
  $('date').value = date;
  $('dashAlert').className = 'alert ' + (al.active ? 'on' : 'off');
  $('dashAlert').innerHTML = alertHtml(al, th, an, true);
  $('dashLevel').textContent = fmtFt(st.level);
  $('dashDiff').textContent = fmtFt(st.diff, true);
  setRisk($('dashRisk'), st.risk);

  drawCharts();
}

function chartConfig(s, small) {
  const last = s.labels.length - 1;
  const points = s.labels.map((_, i) => (i === last && !small ? 6 : 0));
  return {
    type: 'line',
    data: {
      labels: s.labels,
      datasets: [
        { label: 'Water level (ft)', data: s.level, yAxisID: 'yLevel', borderColor: COLORS.river, backgroundColor: COLORS.river, borderWidth: 2.5, tension: 0.25, pointRadius: points },
        { label: 'Barge rate (% of tariff)', data: s.rate, yAxisID: 'yRate', borderColor: COLORS.rate, backgroundColor: COLORS.rate, borderWidth: 2.5, tension: 0.25, pointRadius: points, spanGaps: true },
        { label: 'Threshold', data: s.labels.map(() => state.threshold), yAxisID: 'yLevel', borderColor: COLORS.warn, borderDash: [6, 5], borderWidth: 1.5, pointRadius: 0 },
      ],
    },
    options: {
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 14, boxHeight: 3, font: { family: 'IBM Plex Sans', size: small ? 11 : 13 } } },
        tooltip: { callbacks: { title: (items) => 'Week of ' + fmtDate(items[0].label, { month: 'short', day: 'numeric', year: 'numeric' }) } },
      },
      scales: {
        x: small ? { display: false } : { ticks: { maxTicksLimit: 10, font: { family: 'IBM Plex Mono', size: 11 } }, grid: { display: false } },
        yLevel: { position: 'left', title: { display: !small, text: 'Water level (ft)' }, grid: { color: COLORS.grid }, ticks: { font: { size: 11 } } },
        yRate: { position: 'right', title: { display: !small, text: 'Rate (% of tariff)' }, grid: { display: false }, ticks: { font: { size: 11 } } },
      },
      onClick: small ? undefined : (evt, _els, chart) => {
        const pts = chart.getElementsAtEventForMode(evt, 'index', { intersect: false }, false);
        if (pts.length) setDate(s.labels[pts[0].index]);
      },
    },
  };
}

function drawCharts() {
  heroChart?.destroy();
  mainChart?.destroy();
  heroChart = new Chart($('heroChart'), chartConfig(series(state.date, 12), true));
  mainChart = new Chart($('mainChart'), chartConfig(series(state.date, 104), false));

  const best = correlation();
  $('correlation').textContent = best
    ? `Strongest link: rate ${best.lag} week${best.lag === 1 ? '' : 's'} after level, r = ${best.r}`
    : '';
}

function setStatus(text, isSample = false) {
  $('dataStatus').textContent = text;
  $('dataStatus').parentElement.classList.toggle('sample', isSample);
}

function setDate(s) {
  if (s < firstDate()) s = firstDate();
  if (s > lastDate()) s = lastDate();
  state.date = s;
  render();
}

function bindControls() {
  $('prevWeek').addEventListener('click', () => setDate(addDays(state.date, -7)));
  $('nextWeek').addEventListener('click', () => setDate(addDays(state.date, 7)));
  $('date').addEventListener('change', (e) => e.target.value && setDate(e.target.value));

  $('threshold').addEventListener('input', (e) => {
    state.threshold = parseFloat(e.target.value);
    $('thresholdValue').textContent = fmtFt(state.threshold);
    render();
  });

  document.querySelectorAll('[data-jump]').forEach((btn) =>
    btn.addEventListener('click', () => setDate(btn.dataset.jump === 'latest' ? lastDate() : btn.dataset.jump))
  );

  $('refresh').addEventListener('click', () => start(true));

  $('signup').addEventListener('click', () => {
    const email = $('email');
    if (!email.value.includes('@')) { email.focus(); return; }
    $('thanks').hidden = false;
    email.value = '';
  });
}

async function start(force = false) {
  let data;
  try {
    data = await loadData(force);
    const segName = data.segment === 'stlouis' ? 'St. Louis' : 'Memphis';
    setStatus(
      `Live data: USGS site ${CONFIG.usgsSite}, ${data.daily.length} days · USDA barge rates, ${segName} segment` +
      (data.fromCache ? ` · saved ${new Date(data.savedAt).toLocaleString('en-US')}` : '')
    );
  } catch (err) {
    console.error(err);
    data = sampleData();
    setStatus(`Could not reach the APIs (${err.message}). Showing sample data.`, true);
    $('heroSource').textContent = 'Sample data';
  }

  prepare(data);
  $('date').min = firstDate();
  $('date').max = lastDate();
  $('threshold').value = state.threshold;
  $('thresholdValue').textContent = fmtFt(state.threshold);
  setDate(CONFIG.demoDate || lastDate());
}

bindControls();
start();