// Analytics dashboard: segments coloured by time lost, from data/derived/<day>/.
// Per-segment hourly sums: h[hour] = [n, duration, dwell, stopped, running, lost, delayGrowth] (seconds).
const N = 0, DUR = 1, DWELL = 2, STOPPED = 3, RUNNING = 4, LOST = 5, GROWTH = 6;
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const SEQ = [1, 2, 3, 4, 5].map((i) => css(`--seq-${i}`));
const MIN_N_PER_VEHICLE = 3;

const $ = (id) => document.getElementById(id);
const map = L.map('map').setView([45.8, 15.98], 12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    className: 'muted-tiles',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
const segLayer = L.layerGroup().addTo(map);
const legend = L.control({ position: 'bottomright' });
legend.onAdd = () => L.DomUtil.create('div', 'legend');
legend.addTo(map);

let summary = null;
let features = [];
let lines = new Map();

const fmtMin = (s) => (s >= 3600 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 60)} min`);
const fmtS = (s) => `${Math.round(s)} s`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

for (let h = 0; h < 24; h++) $('from').add(new Option(`${String(h).padStart(2, '0')}:00`, h));
for (let h = 1; h <= 24; h++) $('to').add(new Option(`${String(h).padStart(2, '0')}:00`, h));
$('from').value = 0;
$('to').value = 24;

function inHours(h) {
    const from = +$('from').value, to = +$('to').value;
    return from < to ? h >= from && h < to : h >= from || h < to;
}

// Sum the selected hours of one segment.
function sumHours(f) {
    const acc = [0, 0, 0, 0, 0, 0, 0];
    for (const [h, row] of Object.entries(f.properties.h)) {
        if (!inHours(+h)) continue;
        for (let i = 0; i < acc.length; i++) acc[i] += row[i];
    }
    return acc;
}

function modeMatches(f) {
    const mode = $('mode').value;
    return mode === 'all' || (mode === 'tram') === f.properties.tram;
}

function metricValue(s) {
    if ($('metric').value === 'total') return s[LOST];
    return s[N] >= MIN_N_PER_VEHICLE ? s[LOST] / s[N] : null;
}

// Quantile breaks so the colour scale adapts to whatever is selected.
function breaks(values) {
    const v = values.filter((x) => x > 0).sort((a, b) => a - b);
    if (!v.length) return [];
    const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
    return [q(0.5), q(0.75), q(0.9), q(0.97)];
}

function colourFor(value, b) {
    let i = 0;
    while (i < b.length && value > b[i]) i++;
    return SEQ[i];
}

const SPLIT = [['running', RUNNING], ['stopped', STOPPED], ['dwell', DWELL]];

function splitSpans(s) {
    return SPLIT.filter(([, i]) => s[i] > 0)
        .map(([k, i]) => `<span style="flex:${s[i]};background:var(--${k})" title="${k}"></span>`)
        .join('');
}

function popupHtml(f, s) {
    const p = f.properties;
    const total = s[DWELL] + s[STOPPED] + s[RUNNING] || 1;
    const pct = (v) => `${Math.round((100 * v) / total)}%`;
    return `<div class="popup">
        <h3>${esc(p.from)} → ${esc(p.to)}</h3>
        <div style="font-size:12px;color:var(--ink-2)">Lines ${esc(p.routes.join(', '))} · ${p.length_m} m${p.suspect_stops ? ' · ⚠ stop position suspect' : ''}</div>
        <div class="split" style="height:8px">${splitSpans(s)}</div>
        <div class="split-legend">
            <span><i class="swatch" style="background:var(--running)"></i>running ${pct(s[RUNNING])}</span>
            <span><i class="swatch" style="background:var(--stopped)"></i>stopped ${pct(s[STOPPED])}</span>
            <span><i class="swatch" style="background:var(--dwell)"></i>dwell ${pct(s[DWELL])}</span>
        </div>
        <div class="kv">
            <span>Traversals</span><span>${s[N]}</span>
            <span>Mean time</span><span>${fmtS(s[DUR] / s[N])}</span>
            <span>Free-flow running</span><span>${p.free_flow_s == null ? 'not enough data' : fmtS(p.free_flow_s)}</span>
            <span>Lost per vehicle</span><span>${fmtS(s[LOST] / s[N])}</span>
            <span>Total lost</span><span>${fmtMin(s[LOST])}</span>
            <span>Mean delay growth</span><span>${fmtS(s[GROWTH] / s[N])}</span>
        </div>
    </div>`;
}

function renderMap(rows, b) {
    segLayer.clearLayers();
    lines = new Map();
    const maxN = Math.max(1, ...rows.map((r) => r.s[N]));
    // Draw low values first so the worst segments sit on top.
    for (const r of [...rows].sort((a, b2) => (a.value ?? -1) - (b2.value ?? -1))) {
        const latlngs = r.f.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
        const line = L.polyline(latlngs, {
            color: r.value == null ? css('--axis') : colourFor(r.value, b),
            weight: 2 + 4 * Math.sqrt(r.s[N] / maxN),
            opacity: 0.9,
            lineCap: 'round',
        });
        line.bindPopup(() => popupHtml(r.f, r.s), { maxWidth: 300 });
        line.on('mouseover', () => line.setStyle({ weight: line.options.weight + 3 }));
        line.on('mouseout', () => line.setStyle({ weight: line.options.weight - 3 }));
        line.addTo(segLayer);
        lines.set(r.f.properties.id, line);
    }

    const unit = (s) => (s < 120 ? fmtS(s) : fmtMin(s));
    const title = $('metric').value === 'total' ? 'Time lost (sum)' : 'Lost per vehicle';
    const labels = b.length
        ? [`≤ ${unit(b[0])}`, `${unit(b[0])}–${unit(b[1])}`, `${unit(b[1])}–${unit(b[2])}`, `${unit(b[2])}–${unit(b[3])}`, `> ${unit(b[3])}`]
        : [];
    legend.getContainer().innerHTML = `<strong>${title}</strong>${labels
        .map((l, i) => `<div class="row"><span class="line" style="background:${SEQ[i]}"></span>${l}</div>`)
        .join('')}<div class="row" style="color:var(--muted)">width = traffic</div>`;
}

function renderTop(rows) {
    const top = rows.filter((r) => r.s[LOST] > 0).sort((a, b) => b.s[LOST] - a.s[LOST]).slice(0, 20);
    const max = top[0]?.s[LOST] || 1;
    $('top').innerHTML = top.length
        ? top.map((r, i) => `<li data-id="${esc(r.f.properties.id)}">
            <span class="rank">${i + 1}</span>
            <span class="name">${esc(r.f.properties.from)} → ${esc(r.f.properties.to)} <span class="routes">${esc(r.f.properties.routes.join(', '))}</span></span>
            <span class="val">${fmtMin(r.s[LOST])}</span>
            <span></span><span class="bar" style="width:${(100 * r.s[LOST]) / max}%"></span>
        </li>`).join('')
        : '<li class="empty">No data for this selection.</li>';
    for (const li of $('top').querySelectorAll('li[data-id]')) {
        li.onclick = () => {
            const line = lines.get(li.dataset.id);
            map.fitBounds(line.getBounds(), { maxZoom: 16, padding: [40, 40] });
            line.openPopup();
        };
    }
}

function renderTotals(rows) {
    const t = [0, 0, 0, 0, 0, 0, 0];
    for (const r of rows) for (let i = 0; i < t.length; i++) t[i] += r.s[i];
    $('t-lost').textContent = (t[LOST] / 3600).toFixed(1);
    $('t-trav').textContent = t[N].toLocaleString('en');
    $('t-km').textContent = Math.round(summary.km_driven).toLocaleString('en');
    const total = t[DWELL] + t[STOPPED] + t[RUNNING] || 1;
    $('split').innerHTML = splitSpans(t);
    const labels = { running: 'running', stopped: 'stopped away from stops', dwell: 'dwell at stops' };
    $('split-legend').innerHTML = SPLIT.map(([k, i]) =>
        `<span><i class="swatch" style="background:var(--${k})"></i>${labels[k]} ${(t[i] / 3600).toFixed(1)} h (${Math.round((100 * t[i]) / total)}%)</span>`).join('');
}

function renderVehicles() {
    // t is minutes since the service date's midnight, so service after midnight continues past 24:00.
    const data = summary.vehicles_per_minute.map((d) => ({ t: d.t, label: d.minute, v: d.vehicles }));
    const el = $('vpm');
    if (data.length < 2) {
        el.innerHTML = '<p class="empty">Not enough data yet.</p>';
        return;
    }
    const W = el.clientWidth || 360, H = 110, padL = 30, padB = 18, padT = 8;
    const t0 = data[0].t, t1 = data[data.length - 1].t;
    const vMax = Math.max(...data.map((d) => d.v));
    const yMax = Math.ceil(vMax / 50) * 50 || 50;
    const x = (t) => padL + ((t - t0) / Math.max(1, t1 - t0)) * (W - padL - 4);
    const y = (v) => padT + (1 - v / yMax) * (H - padT - padB);
    // Break the line where minutes are missing (no service or no data) instead of bridging the gap.
    const path = data.map((d, i) => `${i && d.t - data[i - 1].t <= 5 ? 'L' : 'M'}${x(d.t).toFixed(1)},${y(d.v).toFixed(1)}`).join('');
    const ticks = [0, yMax / 2, yMax];
    const hourTicks = [];
    for (let h = Math.ceil(t0 / 60); h * 60 <= t1; h += Math.max(1, Math.ceil((t1 - t0) / 60 / 6))) hourTicks.push(h);
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Vehicles in service per minute">
        ${ticks.map((v) => `<line x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)" stroke-width="1"/>
            <text x="${padL - 6}" y="${y(v) + 4}" font-size="10" text-anchor="end" fill="var(--muted)">${v}</text>`).join('')}
        ${hourTicks.map((h) => `<text x="${x(h * 60)}" y="${H - 4}" font-size="10" text-anchor="middle" fill="var(--muted)">${String(h % 24).padStart(2, '0')}:00</text>`).join('')}
        <path d="${path}" fill="none" stroke="var(--running)" stroke-width="2" stroke-linejoin="round"/>
        <line id="vpm-x" y1="${padT}" y2="${H - padB}" stroke="var(--axis)" visibility="hidden"/>
        <circle id="vpm-dot" r="4" fill="var(--running)" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>
    </svg><div class="tip" id="vpm-tip" hidden></div>`;
    const svg = el.querySelector('svg');
    svg.onmousemove = (e) => {
        const rect = svg.getBoundingClientRect();
        const px = ((e.clientX - rect.left) / rect.width) * W;
        const t = t0 + ((px - padL) / (W - padL - 4)) * (t1 - t0);
        let best = data[0];
        for (const d of data) if (Math.abs(d.t - t) < Math.abs(best.t - t)) best = d;
        const cx = x(best.t), cy = y(best.v);
        el.querySelector('#vpm-x').setAttribute('x1', cx);
        el.querySelector('#vpm-x').setAttribute('x2', cx);
        el.querySelector('#vpm-x').setAttribute('visibility', 'visible');
        const dot = el.querySelector('#vpm-dot');
        dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('visibility', 'visible');
        const tip = $('vpm-tip');
        tip.hidden = false;
        tip.textContent = `${best.label} · ${best.v} vehicles`;
        tip.style.left = `${(cx / W) * rect.width}px`;
        tip.style.top = `${(cy / H) * rect.height - 8}px`;
    };
    svg.onmouseleave = () => {
        $('vpm-tip').hidden = true;
        el.querySelector('#vpm-x').setAttribute('visibility', 'hidden');
        el.querySelector('#vpm-dot').setAttribute('visibility', 'hidden');
    };
}

let routeSort = { key: 'lost_h', dir: -1 };
function renderRoutes() {
    const mode = $('mode').value;
    const cols = [
        ['name', 'Line'], ['trips', 'Trips'], ['km', 'km'], ['lost_h', 'Lost h'], ['dwell_h', 'Dwell h'],
        ['median_delay_s', 'Delay p50'], ['p90_delay_s', 'p90'], ['headway_cv', 'Headway CV'],
    ];
    const rows = summary.routes
        .filter((r) => mode === 'all' || r.type === mode)
        .sort((a, b) => {
            const av = a[routeSort.key], bv = b[routeSort.key];
            if (routeSort.key === 'name') return routeSort.dir * String(av).localeCompare(String(bv), 'en', { numeric: true });
            return routeSort.dir * ((av ?? -Infinity) - (bv ?? -Infinity));
        });
    const fmt = (k, v) => (v == null ? '–' : k.endsWith('_s') ? `${Math.round(v / 60 * 10) / 10} min` : v);
    $('routes').innerHTML = `<thead><tr>${cols.map(([k, l]) => `<th data-k="${k}">${l}${routeSort.key === k ? (routeSort.dir < 0 ? ' ↓' : ' ↑') : ''}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r) => `<tr title="${esc(r.long_name)}">${cols.map(([k]) => `<td>${k === 'name' ? `${r.type === 'tram' ? '🚃' : '🚌'} ${esc(r.name)}` : fmt(k, r[k])}</td>`).join('')}</tr>`).join('')}</tbody>`;
    for (const th of $('routes').querySelectorAll('th')) {
        th.onclick = () => {
            routeSort = { key: th.dataset.k, dir: routeSort.key === th.dataset.k ? -routeSort.dir : -1 };
            renderRoutes();
        };
    }
}

function renderQuality() {
    const c = summary.coverage;
    const pct = (a, b) => `${((100 * a) / Math.max(1, b)).toFixed(1)}%`;
    $('quality').innerHTML = `
        ${c.snapshots.toLocaleString('en')} snapshots, ${c.pings_unique.toLocaleString('en')} unique pings.
        Without trip: ${pct(c.pings_no_trip, c.pings_unique)} · cancelled trips: ${pct(c.pings_canceled_trip, c.pings_unique)} ·
        off-route (&gt; 40 m): ${pct(c.off_route, c.pings_service_day)} · backwards: ${pct(c.backwards, c.pings_service_day)}.<br>
        ${summary.traversals_good.toLocaleString('en')} of ${summary.traversals.toLocaleString('en')} traversals have no ping gap over 60 s and are shown.
        Free-flow baseline for ${summary.free_flow.segments} segments (≥ ${summary.free_flow.min_samples} samples, ${summary.free_flow.window_days_found} day(s) of data);
        segments without one count only stopped time as lost.<br>
        Observed / scheduled time: ${summary.observed_vs_scheduled}. Static feed ${esc(summary.static_feed_version)}, method ${esc(summary.method_version)}.`;
}

function render() {
    const rows = features.filter(modeMatches).map((f) => {
        const s = sumHours(f);
        return { f, s, value: s[N] ? metricValue(s) : null };
    }).filter((r) => r.s[N] > 0);
    const b = breaks(rows.map((r) => r.value).filter((v) => v != null));
    renderMap(rows, b);
    renderTop(rows);
    renderTotals(rows);
    renderRoutes();
}

async function loadDay(day) {
    const [s, g] = await Promise.all([
        fetch(`/api/analytics/${day}/summary.json`).then((r) => r.json()),
        fetch(`/api/analytics/${day}/segments.geojson`).then((r) => r.json()),
    ]);
    summary = s;
    features = g.features;
    renderVehicles();
    renderQuality();
    render();
}

async function init() {
    const days = await fetch('/api/analytics/days').then((r) => r.json());
    if (!days.length) {
        $('top').innerHTML = '<li class="empty">No processed days yet. Run <code>npm run analytics:process</code>.</li>';
        return;
    }
    for (const d of days) $('day').add(new Option(d, d));
    $('day').onchange = () => loadDay($('day').value);
    for (const id of ['from', 'to', 'mode', 'metric']) $(id).onchange = render;
    await loadDay(days[0]);
}

init();
