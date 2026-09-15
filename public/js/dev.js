/* Developer data-preloader page.
 * Only reachable when logged in as the developer account. Kicks off a full
 * server-side fetch (POST /api/prefetch) and polls /api/cache-status to show
 * how many projects have been fetched + saved, so the dev can watch it finish.
 * Once done, ordinary users open reports instantly (data is served from the
 * server cache with zero Asana round-trips). */

'use strict';

const $ = (s) => document.querySelector(s);

async function apiJson(url, opts) {
  const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...opts });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) { const e = new Error(json.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
  return json;
}

const wsSel = $('#ws');
const btn = $('#fetch-btn');
const purgeBtn = $('#purge-btn');
const bar = $('#bar');
const barFill = bar.querySelector('span');
const statusEl = $('#status');
const noteEl = $('#note');
let poll = null;

function setStatus(msg, isErr) {
  statusEl.textContent = msg || '';
  statusEl.classList.toggle('err', !!isErr);
}

async function boot() {
  applyTheme();
  let me;
  try { me = await apiJson('/api/me'); } catch { location.href = '/login.html'; return; }
  if (!me.authenticated) { location.href = '/login.html'; return; }
  if (me.role !== 'dev') { location.href = '/'; return; } // non-dev users → dashboard
  $('#dev-user').textContent = me.user || '';

  if (!me.config.asana) {
    setStatus('Asana token is not configured on the server (.env → ASANA_TOKEN). Add it and restart.', true);
    btn.disabled = true;
    return;
  }

  // Populate the workspace picker.
  try {
    const ws = await apiJson('/api/asana/workspaces?opt_fields=name&limit=100');
    const list = ws.data || [];
    wsSel.innerHTML = list.map((w) => `<option value="${w.gid}">${escapeHtml(w.name)}</option>`).join('');
  } catch (e) {
    setStatus('Could not load workspaces: ' + e.message, true);
  }

  wsSel.addEventListener('change', () => refreshStatus());
  btn.addEventListener('click', startFetch);
  purgeBtn.addEventListener('click', startPurge);
  $('#logout').addEventListener('click', async () => { await fetch('/api/logout', { method: 'POST' }); location.href = '/login.html'; });

  await refreshStatus();
  startPolling(); // reflect any run already in progress (e.g. startup warm-up)
}

async function startFetch() {
  btn.disabled = true;
  setStatus('Starting…');
  try {
    const r = await apiJson('/api/prefetch', { method: 'POST' });
    setStatus(r.started ? 'Fetching and saving all projects…' : 'A fetch is already running…');
  } catch (e) {
    setStatus('Could not start: ' + e.message, true);
    btn.disabled = false;
    return;
  }
  startPolling();
}

async function startPurge() {
  if (!confirm('Stop any current fetch, delete ALL cached data on the server, and re-download it fresh (only Jan 2026 → now)?\n\nReports may be slower until the rebuild finishes.')) return;
  btn.disabled = true; purgeBtn.disabled = true;
  setStatus('Stopping current fetch, deleting old data, starting a fresh download…');
  try {
    await apiJson('/api/purge-cache', { method: 'POST' });
  } catch (e) {
    setStatus('Could not purge: ' + e.message, true);
    btn.disabled = false; purgeBtn.disabled = false;
    return;
  }
  startPolling();
}

function startPolling() {
  if (poll) clearInterval(poll);
  refreshStatus();
  poll = setInterval(refreshStatus, 2500);
}

async function refreshStatus() {
  const ws = wsSel.value;
  let s;
  try { s = await apiJson('/api/cache-status' + (ws ? '?workspace=' + encodeURIComponent(ws) : '')); }
  catch (e) { setStatus(e.message, true); return; }

  const cached = s.cachedProjects || 0;
  const known = s.knownProjects;
  $('#s-cached').textContent = cached.toLocaleString();
  $('#s-known').textContent = known == null ? '—' : known.toLocaleString();

  const active = s.building || s.warming;
  bar.hidden = false;
  if (known && known > 0) {
    bar.classList.remove('indet');
    barFill.style.width = Math.min(100, Math.round((cached / known) * 100)) + '%';
  } else if (active) {
    bar.classList.add('indet');
  } else {
    bar.classList.remove('indet');
    barFill.style.width = cached > 0 ? '100%' : '0';
  }

  btn.disabled = active;
  // Purge stays clickable WHILE fetching — it stops the current run, deletes the
  // cache, and re-downloads fresh. (This is the escape hatch when a long prefetch
  // is stuck.) It's only disabled for the moment its own request is in flight.
  purgeBtn.disabled = false;
  btn.textContent = active ? '⏳  Fetching…' : (cached > 0 ? '↻  Fetch again / update' : '⬇  Fetch & save all data now');
  purgeBtn.textContent = active ? '⏹  Stop, delete & re-download fresh' : '🗑  Delete old data & re-download fresh';
  if (s.since) { const el = $('#since-note'); if (el) el.textContent = `Only data from ${fmtSince(s.since)} onward is fetched.`; }

  if (s.lastError) { setStatus('Last error: ' + s.lastError, true); }
  else if (s.building) { setStatus(`Fetching from Asana… ${cached}${known ? ' / ' + known : ''} projects saved so far.`); }
  else if (s.warming) { setStatus(`Warming ${s.queued || 0} more project(s) in the background…`); }
  else if (cached > 0) { setStatus(`✅ All set — ${cached} project(s) saved. Users will see data instantly.` + (s.lastRunAt ? ' Last run ' + fmtWhen(s.lastRunAt) + '.' : '')); }
  else { setStatus('Nothing saved yet. Click the button to fetch and save all data.'); }

  const notes = [];
  if (s.gapMs) notes.push(`request pacing ${s.gapMs}ms`);
  if (s.diskOk === false) notes.push('disk cache unavailable — using memory (data is lost on restart)');
  if (s.day) notes.push(`cache day ${s.day} (auto-refreshes 12:00 AM IST)`);
  noteEl.textContent = notes.join(' · ');

  // Stop polling once idle, to save requests.
  if (!active && poll) { clearInterval(poll); poll = null; }
}

/* ── tiny utils ── */
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmtWhen(iso) { try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return iso; } }
function fmtSince(iso) { try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch { return iso; } }
function applyTheme() {
  try {
    const s = JSON.parse(localStorage.getItem('asanaDash.v4') || '{}');
    if (s.theme) document.documentElement.setAttribute('data-theme', s.theme);
    if (s.accent) document.documentElement.style.setProperty('--accent', s.accent);
  } catch { /* ignore */ }
}

boot();
