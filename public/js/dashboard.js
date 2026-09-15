/* ═══════════════════════════════════════════════════════════
   Asana Dash — on-demand time analytics + AI custom reports
   Data is fetched live per selected scope (no full pre-scan).
   Talks only to our own /api/* proxy (keys stay server-side).
   ═══════════════════════════════════════════════════════════ */

'use strict';

const state = {
  me: null, config: {}, workspaces: [], workspaceGid: null,
  projects: [], users: [],
  selectedProjects: new Set(),
  selectedEmployees: new Set(), // empty = everyone
  cache: { projectTasks: {}, taskEntries: {} },
  net: { tasks: 0, entries: 0 },
  report: null,     // { tasks, entries, method, projectGids, scopeLabel, precise, tookMs }
  runId: 0,         // increments per report run so a stale run can't overwrite a newer one
  filters: { basis: 'tracked', range: 'all', from: null, to: null, metric: 'time', search: '', person: 'all', tab: 'summary', sort: { col: 'minutes', dir: 'desc' } },
  selectedPortfolio: 'all', portfolios: [], portfolioItems: {}, projectIndex: new Map(),
  charts: {}, ai: { model: null },
  snapshot: { ready: false }, // server-side pre-loaded data for the current workspace
  panel: null, // memoised { sig, entries, rendered:Set } so tab-toggling is instant
};

const settings = (() => { try { return { theme: 'dark', accent: '#6d5efc', fieldMap: {}, ...JSON.parse(localStorage.getItem('asanaDash.v4') || '{}') }; } catch { return { theme: 'dark', accent: '#6d5efc', fieldMap: {} }; } })();
if (!settings.fieldMap) settings.fieldMap = {};
const saveSettings = () => localStorage.setItem('asanaDash.v4', JSON.stringify(settings));

/* ─── Helpers ──────────────────────────────────────────────── */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const initials = (n) => !n ? '?' : n.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86400000;
// Only live-fetch tasks touched on/after this floor (mirrors the server's
// FETCH_SINCE, so the browser fallback stays in sync). Overwritten in boot()
// from /api/me config. Default: Jan 2026 → now.
let FETCH_SINCE_ISO = '2026-01-01T00:00:00.000Z';
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
function fmtDuration(min) { min = Math.round(min || 0); if (!min) return '0m'; const h = Math.floor(min / 60), m = min % 60; return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`; }
function fmtDate(d) { return d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'; }
function fmtDateTime(d) { return d ? new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'; }
function parseDate(s) { return s ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00' : s) : null; }

async function mapPool(items, size, fn, onProgress) {
  const out = new Array(items.length); let i = 0, done = 0;
  const worker = async () => { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); if (onProgress) onProgress(++done, items.length); } };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

/* ─── API ──────────────────────────────────────────────────── */
async function apiJson(url, opts) {
  const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...opts });
  if (res.status === 401 && res.headers.get('X-Auth-Required')) { window.location.href = '/login.html'; throw new Error('auth'); }
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) { const msg = (json.errors && json.errors[0] && json.errors[0].message) || json.error || `HTTP ${res.status}`; const e = new Error(msg); e.status = res.status; throw e; }
  return json;
}
const asana = (pq) => apiJson('/api/asana/' + pq);
async function asanaRetry(pq, tries = 5) {
  for (let a = 0; ; a++) {
    try { return await asana(pq); }
    catch (e) { if (e.status === 429 && a < tries) { await sleep(1200 * (a + 1)); continue; } if (e.status >= 500 && a < 2) { await sleep(700); continue; } throw e; }
  }
}
async function asanaAll(path, query) {
  let out = [], offset = null;
  do { const q = query + (offset ? `&offset=${encodeURIComponent(offset)}` : ''); const res = await asanaRetry(`${path}?${q}`); out = out.concat(res.data || []); offset = res.next_page ? res.next_page.offset : null; } while (offset);
  return out;
}
function banner(msg, kind) { const b = $('#banner'); if (!msg) { b.hidden = true; return; } b.hidden = false; b.className = 'banner ' + (kind || 'info'); b.textContent = msg; }

/* ─── Persistent cache (IndexedDB) ─────────────────────────────
 * Once a project's tasks / a task's time entries are scraped, they're
 * stored so reloads and re-runs don't re-hit the Asana API. Keys:
 *   t:{workspace}:{projectGid}  → processed task array
 *   e:{workspace}:{taskGid}     → raw time-entry array
 * The ⟳ Refresh button clears the current workspace's cache.
 */
const DB_NAME = 'asanaDash', STORE = 'cache';
let _dbPromise = null;
function idb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((res, rej) => {
    if (!('indexedDB' in window)) return rej(new Error('no-idb'));
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return _dbPromise;
}
async function idbSet(key, val) { try { const db = await idb(); await new Promise((res, rej) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(val, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); } catch { /* memory-only fallback */ } }
// Write many key/value pairs in ONE transaction. Persisting a big pre-loaded
// scope with a separate idbSet() per task would open tens of thousands of
// transactions and freeze weak laptops; this does it in a single tx instead.
async function idbSetMany(pairs) { if (!pairs || !pairs.length) return; try { const db = await idb(); await new Promise((res, rej) => { const tx = db.transaction(STORE, 'readwrite'); const st = tx.objectStore(STORE); for (const [k, v] of pairs) st.put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); } catch { /* memory-only fallback */ } }
async function idbGetPrefix(prefix) { try { const db = await idb(); return await new Promise((res, rej) => { const out = {}; const cur = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor(); cur.onsuccess = (e) => { const c = e.target.result; if (c) { if (String(c.key).startsWith(prefix)) out[c.key] = c.value; c.continue(); } else res(out); }; cur.onerror = () => rej(cur.error); }); } catch { return {}; } }
async function idbDeletePrefix(prefix) { try { const db = await idb(); await new Promise((res, rej) => { const tx = db.transaction(STORE, 'readwrite'); const st = tx.objectStore(STORE); const cur = st.openCursor(); cur.onsuccess = (e) => { const c = e.target.result; if (c) { if (String(c.key).startsWith(prefix)) st.delete(c.key); c.continue(); } }; tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); } catch { /* ignore */ } }
async function idbClearAll() { try { const db = await idb(); await new Promise((res, rej) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).clear(); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); } catch { /* ignore */ } }

/* Daily freshness: the server rebuilds its pre-loaded snapshot at 12:00 AM IST
 * and exposes the current day via /api/cache-day. The snapshot is now the source
 * of truth for freshness — selectWorkspace overlays it on top of whatever is in
 * IndexedDB — so we no longer wipe the local cache on a new day (that only made
 * mornings slow). We just record the day for reference. */
const CACHE_DAY_KEY = 'asanaDash.cacheDay';

/* One-time local-cache migration: when the data policy changes (e.g. the Jan
 * 2026 fetch floor), old IndexedDB entries can still hold pre-floor tasks. Wipe
 * the local cache once per policy version so it repopulates with floored data. */
const CACHE_VER_KEY = 'asanaDash.cacheVer';
const CACHE_VER = 'since-2026-01';
async function migrateCache() {
  let v = null;
  try { v = localStorage.getItem(CACHE_VER_KEY); } catch { /* ignore */ }
  if (v === CACHE_VER) return;
  await idbClearAll();
  try { localStorage.setItem(CACHE_VER_KEY, CACHE_VER); } catch { /* ignore */ }
}

async function enforceCacheDay() {
  let day;
  try { day = (await apiJson('/api/cache-day')).day; } catch { return; }
  if (!day) return;
  try { localStorage.setItem(CACHE_DAY_KEY, day); } catch { /* ignore */ }
}

// Warm the in-memory cache from IndexedDB for a workspace.
async function loadCache(ws) {
  const t = await idbGetPrefix(`t3:${ws}:`);
  Object.entries(t).forEach(([k, v]) => { state.cache.projectTasks[k.slice(k.lastIndexOf(':') + 1)] = v; });
  const e = await idbGetPrefix(`e:${ws}:`);
  Object.entries(e).forEach(([k, v]) => { state.cache.taskEntries[k.slice(k.lastIndexOf(':') + 1)] = v; });
}

/* ─── Boot ─────────────────────────────────────────────────── */
async function boot() {
  applyTheme(); wireChrome();
  let me; try { me = await apiJson('/api/me'); } catch { window.location.href = '/login.html'; return; }
  if (!me.authenticated) { window.location.href = '/login.html'; return; }
  state.config = me.config;
  if (me.config && me.config.fetchSince) { const d = new Date(me.config.fetchSince); if (!isNaN(d)) FETCH_SINCE_ISO = d.toISOString(); }
  $('#user-label').textContent = me.user || ''; $('#user-avatar').textContent = initials(me.user);
  // Developer accounts get a shortcut back to the data preloader.
  if (me.role === 'dev' && !$('#dev-link')) {
    const a = document.createElement('a'); a.id = 'dev-link'; a.href = '/dev.html'; a.className = 'link-btn'; a.textContent = 'Preloader'; a.title = 'Fetch & save all data';
    const pill = $('#logout-btn'); if (pill && pill.parentNode) pill.parentNode.insertBefore(a, pill);
  }
  $('#gate').hidden = true; $('#app').hidden = false;
  if (!me.config.asana) { banner('Asana token not configured (.env → ASANA_TOKEN). Add it and restart.', 'error'); return; }

  await migrateCache();    // drop pre-2026 local cache once, so it repopulates floored
  await enforceCacheDay(); // drop stale cache once the IST day has rolled over

  try {
    const [who, workspaces] = await Promise.all([
      asana('users/me?opt_fields=name,email').then((r) => r.data).catch(() => null),
      asanaAll('workspaces', 'opt_fields=name&limit=100'),
    ]);
    state.me = who; state.workspaces = workspaces;
    $('#workspace-select').innerHTML = workspaces.map((w) => `<option value="${w.gid}">${esc(w.name)}</option>`).join('');
    if (workspaces[0]) await selectWorkspace(workspaces[0].gid);
  } catch (e) {
    const authish = /not auth|unauthor|401|invalid.*token/i.test(e.message);
    banner(authish ? `Asana rejected the token (${e.message}). Put a valid ASANA_TOKEN in .env and restart.` : `Could not reach Asana: ${e.message}`, 'error');
  }
  if (state.config.groq) loadModels();
}

async function selectWorkspace(gid) {
  state.workspaceGid = gid; state.report = null; state.selectedProjects = new Set(); state.selectedEmployees = new Set();
  state.selectedPortfolio = 'all'; state.portfolioItems = {}; state.projectIndex = new Map();
  state.cache = { projectTasks: {}, taskEntries: {} };
  banner('');
  const [projects, users, portfolios] = await Promise.all([
    asanaAll(`workspaces/${gid}/projects`, 'opt_fields=name,archived,color&limit=100').catch(() => []),
    loadUsers(gid),
    loadPortfolios(gid),
  ]);
  state.projects = projects.filter((p) => !p.archived);
  state.users = users;
  state.portfolios = portfolios;
  state.projects.forEach((p) => state.projectIndex.set(p.gid, p.name));
  // Populate the Department (portfolio) dropdown.
  $('#portfolio-select').innerHTML = `<option value="all">All departments</option>` + portfolios.map((p) => `<option value="${p.gid}">${esc(p.name)}</option>`).join('');
  await loadCache(gid).catch(() => {}); // warm in-memory cache from IndexedDB
  buildProjectMenu();
  buildEmployeeMenu();
  $('#dash-body').innerHTML = `<div class="placeholder"><div class="placeholder-icon">⏱️</div><h3>Pick a project or a person to start</h3><p class="muted">Optionally choose a department first, then a project (to see its people) or a person (to see their projects) — then click “Show me the report”.</p></div>`;
}

/* Pull the selected projects' tasks + time entries from the SERVER cache (warmed
 * nightly + on demand) into our in-memory cache, so fetchScope then finds them
 * locally and the report opens instantly with no Asana round-trips. Projects the
 * server couldn't serve are returned in `missing` and fall through to the normal
 * live fetch. Safe no-op on any error. Returns the set of gids served instantly. */
async function loadCachedScope(gids, onProgress) {
  const ws = state.workspaceGid;
  const need = gids.filter((g) => !state.cache.projectTasks[g]); // skip what we already have locally
  if (!need.length) return new Set(gids);
  const served = new Set();
  // Fetch the pre-loaded data in SMALL BATCHES rather than one giant request.
  // One big response can be tens of MB, and parsing it in a single shot freezes
  // weak laptops ("page unresponsive"). Chunking keeps each JSON.parse small and
  // we yield to the browser between batches so the tab stays responsive.
  const CHUNK = 15;
  for (let i = 0; i < need.length; i += CHUNK) {
    const batch = need.slice(i, i + CHUNK);
    if (onProgress) onProgress(`Loading pre-saved data… ${Math.min(i + CHUNK, need.length)}/${need.length} projects`);
    let snap;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.max(30000, batch.length * 4000));
      try {
        snap = await apiJson('/api/cached-scope', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace: ws, projects: batch }), signal: ctrl.signal });
      } finally { clearTimeout(timer); }
    } catch { continue; } // this batch falls through to the live fetch
    if (!snap || !snap.have) { await sleep(0); continue; }
    const byProj = {};
    (snap.tasks || []).forEach((t) => { (byProj[t._projectGid] || (byProj[t._projectGid] = [])).push(t); });
    const taskPairs = [];
    snap.have.forEach((pg) => { const arr = byProj[pg] || []; state.cache.projectTasks[pg] = arr; taskPairs.push([`t3:${ws}:${pg}`, arr]); served.add(pg); });
    const entryPairs = [];
    Object.entries(snap.entries || {}).forEach(([tg, v]) => { if (!state.cache.taskEntries[tg]) state.cache.taskEntries[tg] = v; entryPairs.push([`e:${ws}:${tg}`, v]); });
    // Persist batched (one transaction each), off the render path.
    setTimeout(() => { idbSetMany(taskPairs); idbSetMany(entryPairs); }, 0);
    await sleep(0); // let the browser paint / stay responsive between batches
  }
  return served;
}

// Portfolios (departments) — org workspaces only; Asana lists those you own.
async function loadPortfolios(gid) {
  const owner = state.me && state.me.gid;
  if (!owner) return [];
  try { return await asanaAll('portfolios', `workspace=${gid}&owner=${owner}&opt_fields=name&limit=100`); } catch { return []; }
}
async function getPortfolioProjects(pfGid) {
  if (state.portfolioItems[pfGid]) return state.portfolioItems[pfGid];
  let items = [];
  try { items = await asanaAll(`portfolios/${pfGid}/items`, 'opt_fields=name,resource_type,archived&limit=100'); } catch { items = []; }
  const projects = items.filter((i) => i.name && i.resource_type !== 'portfolio' && !i.archived);
  projects.forEach((p) => state.projectIndex.set(p.gid, p.name));
  state.portfolioItems[pfGid] = projects;
  return projects;
}
// Projects to show in the picker, based on the selected department.
function visibleProjects() {
  const pf = state.selectedPortfolio;
  if (!pf || pf === 'all') return state.projects;
  return state.portfolioItems[pf] || [];
}

/* ─── Project multi-select ─────────────────────────────────── */
function buildProjectMenu() {
  const menu = $('#proj-menu');
  menu.innerHTML = `<input class="pm-search input" placeholder="🔍 Search projects…" />
    <div class="pm-actions"><button id="pm-all">Select all</button><button id="pm-none">Clear</button></div>
    <div class="pm-list">${visibleProjects().map((p) => `<label><input type="checkbox" value="${p.gid}" ${state.selectedProjects.has(p.gid) ? 'checked' : ''}/> ${esc(p.name)}</label>`).join('') || '<div class="pm-empty">No projects in this department.</div>'}</div>`;
  wireMenuSearch(menu);
  const boxes = () => $$('#proj-menu .pm-list input');
  const sync = () => {
    state.selectedProjects = new Set(boxes().filter((b) => b.checked).map((b) => b.value));
    const n = state.selectedProjects.size;
    $('#proj-btn').textContent = (n === 0 ? 'Select projects' : n === 1 ? projName([...state.selectedProjects][0]) : `${n} projects`) + ' ▾';
    $('#proj-count').textContent = n ? `· ${n} selected` : '';
  };
  boxes().forEach((b) => b.addEventListener('change', sync));
  // Select all / Clear act on the currently visible (searched) items.
  $('#pm-all').addEventListener('click', () => { boxes().forEach((b) => { if (b.closest('label').style.display !== 'none') b.checked = true; }); sync(); });
  $('#pm-none').addEventListener('click', () => { boxes().forEach((b) => (b.checked = false)); sync(); });
  sync();
}
const projName = (gid) => state.projectIndex.get(gid) || (state.projects.find((x) => x.gid === gid) || {}).name || gid;

// Filter the checkbox labels inside a dropdown as the user types.
function wireMenuSearch(menu) {
  const inp = menu.querySelector('.pm-search');
  if (!inp) return;
  inp.addEventListener('input', () => {
    const q = inp.value.trim().toLowerCase();
    menu.querySelectorAll('.pm-list label').forEach((l) => { l.style.display = l.textContent.toLowerCase().includes(q) ? '' : 'none'; });
  });
  inp.addEventListener('click', (e) => e.stopPropagation());
}
const userName = (gid) => { const u = state.users.find((x) => x.gid === gid); return u ? u.name : gid; };

// Load workspace members, trying both documented endpoints.
async function loadUsers(gid) {
  try { const u = await asanaAll(`workspaces/${gid}/users`, 'opt_fields=name&limit=100'); if (u.length) return u; } catch { /* try next */ }
  try { const u = await asanaAll('users', `workspace=${gid}&opt_fields=name&limit=100`); if (u.length) return u; } catch { /* give up */ }
  return [];
}

// Add anyone who appears in a report (created_by / assignee) to the people list.
function mergeUsersFromReport() {
  if (!state.report) return;
  const known = new Set(state.users.map((u) => u.gid));
  state.report.entries.forEach((e) => { if (e.userGid && !known.has(e.userGid) && e.userName) { state.users.push({ gid: e.userGid, name: e.userName }); known.add(e.userGid); } });
  state.users.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

function reportScopeLabel(gids, mode) {
  const n = state.selectedEmployees.size;
  const who = n === 0 ? '' : n === 1 ? userName([...state.selectedEmployees][0]) : `${n} people`;
  if (mode === 'employee') return `${who} · across all projects`;
  const proj = gids.length === 1 ? projName(gids[0]) : `${gids.length} projects`;
  return proj + (who ? ` · ${who}` : '');
}

function buildEmployeeMenu() {
  const menu = $('#emp-menu');
  const emptyNote = state.users.length ? '' : `<div class="pm-empty">No members loaded yet from Asana. Leave this on <b>Everyone</b> and click “Show me the report” — the people who logged time will then appear here to pick from.</div>`;
  menu.innerHTML = `${state.users.length ? '<input class="pm-search input" placeholder="🔍 Search people…" />' : ''}
    <div class="pm-actions"><button id="em-all">Select all</button><button id="em-none">Everyone</button></div>` + emptyNote +
    `<div class="pm-list">${state.users.map((u) => `<label><input type="checkbox" value="${u.gid}" ${state.selectedEmployees.has(u.gid) ? 'checked' : ''}/> ${esc(u.name)}</label>`).join('')}</div>`;
  wireMenuSearch(menu);
  $('#emp-count').textContent = state.selectedEmployees.size ? `· ${state.selectedEmployees.size} selected` : (state.users.length ? '· everyone' : '· (loads after first report)');
  const boxes = () => $$('#emp-menu .pm-list input');
  const sync = () => {
    state.selectedEmployees = new Set(boxes().filter((b) => b.checked).map((b) => b.value));
    const n = state.selectedEmployees.size;
    $('#emp-btn').textContent = (n === 0 ? 'Everyone' : n === 1 ? userName([...state.selectedEmployees][0]) : `${n} people`) + ' ▾';
    $('#emp-count').textContent = n ? `· ${n} selected` : '· everyone';
  };
  boxes().forEach((b) => b.addEventListener('change', sync));
  $('#em-all').addEventListener('click', () => { boxes().forEach((b) => { if (b.closest('label').style.display !== 'none') b.checked = true; }); sync(); });
  $('#em-none').addEventListener('click', () => { boxes().forEach((b) => (b.checked = false)); sync(); });
  sync();
}

/* ─── Fetch scope (on demand) ──────────────────────────────── */
const TASK_FIELDS = ['name', 'completed', 'completed_at', 'created_at', 'due_on', 'due_at', 'assignee.name', 'assignee.gid', 'num_subtasks', 'permalink_url', 'actual_time_minutes', 'memberships.section.name', 'memberships.project.gid', 'custom_fields.name', 'custom_fields.gid', 'custom_fields.display_value', 'custom_fields.number_value', 'custom_fields.text_value', 'custom_fields.people_value.name', 'custom_fields.type'].join(',');

async function getProjectTasks(projectGid, name) {
  if (state.cache.projectTasks[projectGid]) return state.cache.projectTasks[projectGid];
  const tasks = await asanaAll(`projects/${projectGid}/tasks`, `opt_fields=${TASK_FIELDS}&limit=100&modified_since=${encodeURIComponent(FETCH_SINCE_ISO)}`);
  tasks.forEach((t) => { const m = (t.memberships || []).find((mm) => mm.project && mm.project.gid === projectGid) || (t.memberships || [])[0]; t._section = (m && m.section && m.section.name) || 'No section'; t._projectGid = projectGid; t._projectName = name; });
  state.cache.projectTasks[projectGid] = tasks;
  state.net.tasks++;                                              // network fetch (not cache)
  idbSet(`t3:${state.workspaceGid}:${projectGid}`, tasks);        // persist
  return tasks;
}

async function fetchScope(projectGids, precise, onProgress, onPartial) {
  state.net = { tasks: 0, entries: 0 };                           // count network fetches this run
  const tasks = [];
  await mapPool(projectGids, 8, async (gid) => { try { tasks.push(...await getProjectTasks(gid, projName(gid))); } catch { /* skip */ } }, (d, t) => onProgress(`Loading tasks… ${d}/${t} projects`));
  const timed = tasks.filter((t) => (t.actual_time_minutes || 0) > 0);

  // Fast estimate: credit each task's logged time to its assignee. Needs zero
  // per-task requests, so it's ready the moment tasks are in.
  const estimate = () => timed.length
    ? { method: 'assignee', entries: timed.map((t) => mkEntry(t, t.assignee && t.assignee.gid, (t.assignee && t.assignee.name) || 'Unassigned', t.actual_time_minutes || 0, null)) }
    : { method: 'none', entries: tasks.map((t) => mkEntry(t, t.assignee && t.assignee.gid, (t.assignee && t.assignee.name) || 'Unassigned', 0, null)) };

  // The slow part is one time_tracking_entries request per timed task. If any of
  // those still need the network, paint the estimate NOW and refine in the
  // background — otherwise (all cached / not precise) we already have it fast.
  const needFetch = precise ? timed.filter((t) => !state.cache.taskEntries[t.gid]).length : 0;
  if (onPartial && needFetch > 0) { const est = estimate(); onPartial({ tasks, entries: est.entries, method: est.method, timed: timed.length }); }

  let entries = [], method;
  const sinceDate = FETCH_SINCE_ISO.slice(0, 10); // YYYY-MM-DD floor for entered_on
  if (precise && timed.length) {
    let used = false;
    await mapPool(timed, 12, async (t) => {
      let data = state.cache.taskEntries[t.gid];
      if (!data) { try { const res = await asanaRetry(`tasks/${t.gid}/time_tracking_entries?opt_fields=duration_minutes,entered_on,created_by.name`); data = res.data || []; state.cache.taskEntries[t.gid] = data; state.net.entries++; idbSet(`e:${state.workspaceGid}:${t.gid}`, data); } catch { data = []; } }
      // Credit each logged entry to whoever LOGGED it (created_by), keeping only
      // time logged on/after the floor date.
      data.forEach((e) => { if (e.entered_on && e.entered_on < sinceDate) return; used = true; const u = e.created_by || {}; entries.push(mkEntry(t, u.gid, u.name || 'Unknown', e.duration_minutes || 0, e.entered_on)); });
    }, (d, t) => onProgress(`Refining exact time… ${d}/${t} tasks`, true));
    if (used && entries.length) method = 'entries';
  }
  if (!method) { const est = estimate(); method = est.method; entries = est.entries; }
  return { tasks, entries, method, timed: timed.length };
}

function mkEntry(t, userGid, userName, minutes, enteredOn) {
  const today = startOfToday(); const due = parseDate(t.due_at || t.due_on);
  return {
    taskGid: t.gid, taskName: t.name, permalink: t.permalink_url,
    projectGid: t._projectGid, projectName: t._projectName, section: t._section,
    userGid: userGid || ('name:' + userName), userName,
    minutes, enteredOn: enteredOn ? parseDate(enteredOn) : (t.created_at ? parseDate(t.created_at) : null),
    taskCreated: parseDate(t.created_at), taskCompleted: parseDate(t.completed_at),
    completed: !!t.completed, overdue: !t.completed && due && due < today, due,
  };
}

/* ─── Date range ───────────────────────────────────────────── */
function rangeBounds(range, from, to) {
  const now = new Date(); const t = startOfToday();
  const sow = (d) => { const x = new Date(d); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); x.setHours(0, 0, 0, 0); return x; };
  switch (range) {
    case 'week': { const s = sow(t); return [s, new Date(+s + 7 * DAY)]; }
    case 'last_week': { const s = sow(t); return [new Date(+s - 7 * DAY), s]; }
    case 'month': return [new Date(now.getFullYear(), now.getMonth(), 1), new Date(now.getFullYear(), now.getMonth() + 1, 1)];
    case 'last_month': return [new Date(now.getFullYear(), now.getMonth() - 1, 1), new Date(now.getFullYear(), now.getMonth(), 1)];
    case 'quarter': { const q = Math.floor(now.getMonth() / 3); return [new Date(now.getFullYear(), q * 3, 1), new Date(now.getFullYear(), q * 3 + 3, 1)]; }
    case 'year': return [new Date(now.getFullYear(), 0, 1), new Date(now.getFullYear() + 1, 0, 1)];
    case 'custom': return [from ? parseDate(from) : null, to ? new Date(+parseDate(to) + DAY) : null];
    default: return [null, null];
  }
}
const dateFor = (e, basis) => basis === 'created' ? e.taskCreated : basis === 'completed' ? e.taskCompleted : basis === 'due' ? e.due : e.enteredOn; // 'tracked' → enteredOn
function inBounds(d, [a, b]) { if (!a && !b) return true; if (!d) return false; if (a && d < a) return false; if (b && d >= b) return false; return true; }

function applyFilters(entries, f = state.filters) {
  const bounds = rangeBounds(f.range, f.from, f.to);
  const dateFilter = !(bounds[0] === null && bounds[1] === null);
  const q = f.search.trim().toLowerCase();
  return entries.filter((e) => {
    if (f.people && f.people.size && !f.people.has(e.userGid)) return false;
    if (f.person !== 'all' && e.userGid !== f.person) return false;
    if (dateFilter && !inBounds(dateFor(e, f.basis), bounds)) return false;
    if (q && !((e.taskName || '').toLowerCase().includes(q) || (e.projectName || '').toLowerCase().includes(q) || (e.userName || '').toLowerCase().includes(q))) return false;
    return true;
  });
}

/* ─── Aggregation ──────────────────────────────────────────── */
function aggBy(entries, keyFn, nameFn) {
  const m = new Map();
  entries.forEach((e) => { const k = keyFn(e); if (k == null) return; let r = m.get(k); if (!r) { r = { key: k, name: nameFn(e), minutes: 0, tasks: new Set(), projects: new Set(), users: new Set(), count: 0 }; m.set(k, r); } r.minutes += e.minutes; r.tasks.add(e.taskGid); r.projects.add(e.projectGid); r.users.add(e.userGid); r.count++; });
  return [...m.values()].map((r) => ({ key: r.key, name: r.name, minutes: r.minutes, tasks: r.tasks.size, projects: r.projects.size, users: r.users.size, count: r.count }));
}
const metricVal = (r, m) => m === 'time' ? r.minutes : m === 'tasks' ? r.tasks : m === 'contributors' ? r.users : r.count;
const metricText = (r, m) => m === 'time' ? fmtDuration(r.minutes) : String(metricVal(r, m));
const groupKey = {
  employee: [(e) => e.userGid, (e) => e.userName],
  project: [(e) => e.projectGid, (e) => e.projectName],
  section: [(e) => e.projectGid + '::' + e.section, (e) => e.section],
  status: [(e) => statusOf(e), (e) => statusOf(e)],
  month: [(e) => +monthStart(e.enteredOn), (e) => monthLabel(e.enteredOn)],
};
function statusOf(e) { return e.completed ? 'Completed' : e.overdue ? 'Incomplete task' : 'Open'; }
function monthStart(d) { if (!d) return 0; const x = new Date(d); x.setDate(1); x.setHours(0, 0, 0, 0); return x; }
function monthLabel(d) { return d ? new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short' }) : 'Undated'; }

/* ═══ Run report (Time Report tab) ═════════════════════════ */
async function runReport() {
  const body = $('#dash-body');
  const emps = [...state.selectedEmployees];
  let gids = [...state.selectedProjects];
  let mode = 'projects';
  // Employee-first: picked people but no project → look across every project in
  // scope (the chosen department, or all) to show all their projects.
  if (!gids.length && emps.length) { gids = visibleProjects().map((p) => p.gid); mode = 'employee'; }
  if (!gids.length && !emps.length) { body.innerHTML = `<div class="banner warn" style="margin:0">Pick at least one project <b>or</b> one person, then click “Show me the report”.</div>`; return; }

  const precise = true; // always exact (per-person time entries)
  const t0 = Date.now();
  const myRun = ++state.runId;               // guard: a newer run must win
  $('#run-btn').disabled = true;

  // Reset result-view filters once for this new report.
  state.filters.search = ''; state.filters.person = 'all';
  state.filters.people = new Set(state.selectedEmployees); // apply the picked people

  let painted = false; // has the report shell been drawn (vs. the loading spinner)?
  const draw = (scope, refining) => {
    if (myRun !== state.runId) return;       // superseded by a newer run — drop it
    state.report = { ...scope, net: state.net, projectGids: gids, precise, mode, scopeLabel: reportScopeLabel(gids, mode), tookMs: Date.now() - t0 };
    mergeUsersFromReport(); buildEmployeeMenu();
    buildReportShell(body);
    if (refining) showRefineNote(); else hideRefineNote();
    painted = true;
  };
  const onProgress = (msg, refine) => {
    if (myRun !== state.runId) return;
    if (painted && refine) { updateRefineNote(msg); return; } // keep the shown report, just update the chip
    const cur = body.querySelector('.progress-note > span'); // reuse the spinner, only swap text
    if (cur) cur.textContent = msg;
    else body.innerHTML = `<div class="card"><div class="progress-note"><div class="spinner"></div><span>${esc(msg)}</span></div></div>`;
  };
  try {
    if (mode === 'employee' && gids.length > 20) body.innerHTML = `<div class="card"><div class="progress-note"><div class="spinner"></div><span>Looking through all ${gids.length} projects for the selected people… (cached after the first time)</span></div></div>`;
    await loadCachedScope(gids, (m) => onProgress(m)).catch(() => {}); // warm from server cache first (instant when pre-loaded)
    if (myRun !== state.runId) return;
    const scope = await fetchScope(gids, precise, onProgress, (partial) => draw(partial, true));
    draw(scope, false);
  } catch (e) { if (myRun === state.runId && e.message !== 'auth') body.innerHTML = `<div class="banner error" style="margin:0">Fetch failed: ${esc(e.message)}</div>`; }
  finally { if (myRun === state.runId) $('#run-btn').disabled = false; }
}

// Small non-blocking chip shown while precise time is still loading in the
// background over an already-visible (estimated) report.
function showRefineNote() {
  hideRefineNote();
  const el = document.createElement('div');
  el.id = 'refine-note'; el.className = 'refine-note';
  el.innerHTML = `<span class="spinner sm"></span><span class="refine-text">Showing a quick estimate — refining exact tracked time…</span>`;
  $('#dash-body').prepend(el);
}
function updateRefineNote(msg) { const t = document.querySelector('#refine-note .refine-text'); if (t) t.textContent = msg + ' — numbers update automatically'; }
function hideRefineNote() { const el = $('#refine-note'); if (el) el.remove(); }

function methodTag(m) { return m === 'entries' ? 'Precise' : m === 'assignee' ? 'Estimated' : 'No time data'; }
function methodSub(r) {
  const bits = [`${r.tasks.length} tasks`];
  if (r.timed) bits.push(`${r.timed} with time`);
  if (r.method === 'assignee') bits.push('estimated by assignee');
  if (r.method === 'none') bits.push('no logged time');
  return bits.join(' · ');
}

function buildReportShell(container) {
  const r = state.report, f = state.filters;
  destroyAllCharts();   // the shell's canvases are about to be replaced
  state.panel = null;   // fresh shell → all panels must re-render once
  const contentReady = scopeHasContent();
  if (f.tab === 'content' && !contentReady) f.tab = 'summary';
  const methodBanner = r.method === 'assignee' ? `<div class="banner warn" style="margin:0 0 16px">Estimated: per-person time entries weren’t available, so each task’s Actual time is credited to its assignee.</div>` : r.method === 'none' ? `<div class="banner warn" style="margin:0 0 16px">No logged time in this scope — showing task counts (time totals are 0).</div>` : '';
  container.innerHTML = methodBanner +
    reportHead(r.scopeLabel, methodSub(r), methodTag(r.method)) +
    `<div id="kpi-row" class="stat-grid"></div>
     <div class="result-toolbar">
       <div class="tabs" id="tabs">
         <button data-tab="summary" class="${f.tab === 'summary' ? 'active' : ''}">📋 Overview</button>
         ${contentReady ? `<button data-tab="content" class="${f.tab === 'content' ? 'active' : ''}">✍️ Content</button>` : ''}
         <button data-tab="charts" class="${f.tab === 'charts' ? 'active' : ''}">📊 Summary report 1</button>
         <button data-tab="matrix" class="${f.tab === 'matrix' ? 'active' : ''}">🧑‍🤝‍🧑 Summary report 2</button>
         <button data-tab="sheet" class="${f.tab === 'sheet' ? 'active' : ''}">🔢 Table view</button>
       </div>
     </div>
     <div id="panel-summary" data-panel></div>
     ${contentReady ? '<div id="panel-content" data-panel hidden></div>' : ''}
     <div id="panel-charts" data-panel hidden></div>
     <div id="panel-matrix" data-panel hidden></div>
     <div id="panel-sheet" data-panel hidden></div>`;

  $$('#tabs button').forEach((b) => b.addEventListener('click', () => { f.tab = b.dataset.tab; $$('#tabs button').forEach((x) => x.classList.toggle('active', x === b)); updatePanels(); }));
  updatePanels();
}

function syncQueryToFilters() {
  const f = state.filters;
  f.basis = $('#date-basis').value; f.range = $('#date-range').value;
  f.from = $('#range-from').value || null; f.to = $('#range-to').value || null;
}

// Signature of everything that affects a panel's CONTENT (not which tab is
// shown). While this is unchanged, switching tabs is just show/hide — no
// re-filtering, no re-aggregating, no chart rebuild — so toggling is instant.
function panelSig(f) {
  return [state.runId, state.report && state.report.method, f.basis, f.range, f.from, f.to, f.person, f.metric, [...(f.people || [])].sort().join('|')].join('~');
}
function updatePanels() {
  if (!state.report) return;
  syncQueryToFilters();
  const f = state.filters;

  // Recompute (filter + KPIs) ONLY when the underlying data/filters change.
  const sig = panelSig(f);
  if (!state.panel || state.panel.sig !== sig) {
    destroyAllCharts();
    state.panel = { sig, entries: applyFilters(state.report.entries), rendered: new Set() };
    updateKpis(state.panel.entries);
  }
  const P = state.panel;

  const contentPanel = $('#panel-content');
  const tab = (f.tab === 'content' && !contentPanel) ? 'summary' : f.tab;
  $('#panel-summary').hidden = tab !== 'summary';
  if (contentPanel) contentPanel.hidden = tab !== 'content';
  $('#panel-charts').hidden = tab !== 'charts';
  $('#panel-sheet').hidden = tab !== 'sheet';
  $('#panel-matrix').hidden = tab !== 'matrix';

  // Render the visible panel at most once per signature; a repeat visit while
  // the signature is unchanged is a no-op (the panel is already in the DOM).
  if (P.rendered.has(tab)) return;
  if (tab === 'summary') renderOverview($('#panel-summary'), P.entries);
  else if (tab === 'content') renderContent(contentPanel);
  else if (tab === 'charts') renderCharts($('#panel-charts'), P.entries);
  else if (tab === 'sheet') renderSheet($('#panel-sheet'), P.entries);
  else if (tab === 'matrix') renderMatrix($('#panel-matrix'), P.entries, f.metric);
  else renderOverview($('#panel-summary'), P.entries);
  P.rendered.add(tab);
}

function updateKpis(entries) {
  const noTime = state.report.method === 'none';
  const totalMin = entries.reduce((s, e) => s + e.minutes, 0);
  const people = new Set(entries.filter((e) => e.minutes > 0 || noTime).map((e) => e.userGid)).size;
  const projects = new Set(entries.map((e) => e.projectGid)).size;
  const tasksWorked = new Set(entries.filter((e) => e.minutes > 0 || noTime).map((e) => e.taskGid)).size;
  $('#kpi-row').innerHTML =
    kpiCard(noTime ? '—' : fmtDuration(totalMin), 'Actual time', 'accent', 'sum-people') +
    kpiCard(people, people === 1 ? 'Person' : 'People', '', 'sum-people') +
    kpiCard(projects, projects === 1 ? 'Project' : 'Projects', '', 'sum-projects') +
    kpiCard(tasksWorked, 'Tasks', '', 'sum-projects');
  $$('#kpi-row .stat[data-jump]').forEach((c) => c.addEventListener('click', () => {
    state.filters.tab = 'summary';
    $$('#tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'summary'));
    updatePanels();
    setTimeout(() => { const el = $('#' + c.dataset.jump); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 60);
  }));
}
function kpiCard(val, label, cls, jump, desc) {
  return `<div class="stat ${cls || ''} ${jump ? 'clickable' : ''}" ${jump ? `data-jump="${esc(jump)}"` : ''}><div class="s-val">${val}</div><div class="s-label">${esc(label)}</div>${desc ? `<div class="s-sub muted">${esc(desc)}</div>` : ''}</div>`;
}

/* ─── Overview: project-wise & employee-wise rich tables ───── */
// Word-count / quality columns come from Asana custom fields. Different
// projects often use DIFFERENT custom fields (different names AND different
// gids) for the same idea, so we match by the field NAME on each task rather
// than locking onto one field — "Editor Word Count" in one project and
// "Editorial WC" in another both feed the Editor column. A field only counts
// when it actually has a number, so text fields never inflate a total.
const QUALITY_RE = /qualit|rating|\brate\b|grade|score|\bqc\b|star/i;
const EDITOR_RE = /\bedit/i;            // editor / editorial / edited
const WRITER_RE = /\bwrit|\bauthor/i;   // writer / written / author
const WORDS_RE = /\bwords?\b|\bwc\b|word\s*count/i; // generic "Word Count" / "Words"

function cfVal(f) {
  if (!f) return null;
  if (typeof f.number_value === 'number') return f.number_value;
  const v = parseFloat(String(f.display_value == null ? '' : f.display_value).replace(/[^0-9.\-]/g, ''));
  return isNaN(v) ? null : v;
}
function cfNum(t, gid) {
  if (!gid) return null;
  return cfVal((t.custom_fields || []).find((x) => x.gid === gid));
}
// Every custom field present across the tasks: gid → name.
function allCustomFields(tasks) {
  const m = new Map();
  tasks.forEach((t) => (t.custom_fields || []).forEach((f) => { if (f && f.gid) m.set(f.gid, f.name || '(unnamed field)'); }));
  return m;
}
// Build a matcher per column: a manual gid override if the user picked one,
// otherwise a name pattern that matches across every project.
function resolveFieldSpecs(tasks) {
  const all = allCustomFields(tasks);
  const saved = settings.fieldMap[state.workspaceGid] || {};
  const spec = (key, re) => {
    const v = saved[key];
    if (v === 'none') return null;
    if (v && v !== 'auto' && all.has(v)) return { gid: v, name: all.get(v) };
    return { re };
  };
  return {
    quality: spec('quality', QUALITY_RE),
    editor: spec('editor', EDITOR_RE),
    writer: spec('writer', WRITER_RE),
    words: spec('words', WORDS_RE), // generic word-count catch-all
    all,
  };
}
// "Writer" / "editor" as an explicit ROLE word (not just any name containing
// the substring "edit", which would swallow "Editorial Writer" into editor).
const STRONG_WRITER_RE = /\bwriter\b|\bauthor\b|\bwritten\b|\bwrote\b/i;
const STRONG_EDITOR_RE = /\beditor\b|\bedited\b|\bedits\b/i;
// Which column (if any) a task's custom field feeds. Priority prevents double-
// counting: quality → editor → writer → generic words. When a field name
// matches BOTH editor and writer patterns (e.g. "Editorial Writer" matches
// editor via "edit" and writer via "writer"), the blind editor-first order
// mislabels it — so we disambiguate by the explicit role word first. A manual
// gid override (spec.gid) is unambiguous and skips this entirely.
function classifyField(f, specs) {
  const name = f.name || '';
  const hit = (spec) => spec && (spec.gid ? spec.gid === f.gid : spec.re.test(name));
  if (hit(specs.quality)) return 'quality';
  const isE = hit(specs.editor), isW = hit(specs.writer);
  if (isE && isW) {
    const strongW = STRONG_WRITER_RE.test(name), strongE = STRONG_EDITOR_RE.test(name);
    if (strongW && !strongE) return 'writer';
    if (strongE && !strongW) return 'editor';
    return 'editor'; // truly ambiguous → prior behavior (editor wins)
  }
  if (isE) return 'editor';
  if (isW) return 'writer';
  if (hit(specs.words)) return 'words';
  return null;
}
// Overview aggregation — the same simple columns for every project: task
// counts + logged (Actual) time. No word-count / writer / editor / quality
// here; those belong to the Content tab only.
function richAgg(tasks, keyFn, nameFn, timeFn) {
  const m = new Map();
  tasks.forEach((t) => {
    const k = keyFn(t); if (k == null) return;
    let r = m.get(k); if (!r) { r = { key: k, name: nameFn(t), minutes: 0, assigned: 0, done: 0, overdue: 0 }; m.set(k, r); }
    r.minutes += timeFn(t); r.assigned++; if (t.completed) r.done++; if (t._overdue) r.overdue++;
  });
  return [...m.values()].sort((a, b) => b.minutes - a.minutes || b.assigned - a.assigned);
}
// Aggregate TIME-TRACKING ENTRIES by a key (person = who logged the time, or
// project). This is the actual tracked time: each entry's minutes are credited
// to whoever LOGGED it (created_by), never to the task's current assignee — so
// if A logs time then the task is reassigned to B, the time stays with A.
// Task counts are distinct tasks the key appears on within the current filter.
function entryAgg(entries, keyFn, nameFn) {
  const m = new Map();
  entries.forEach((e) => {
    const k = keyFn(e); if (k == null) return;
    let r = m.get(k);
    if (!r) { r = { key: k, name: nameFn(e), minutes: 0, tasks: new Set(), done: new Set(), over: new Set() }; m.set(k, r); }
    r.minutes += e.minutes; r.tasks.add(e.taskGid);
    if (e.completed) r.done.add(e.taskGid);
    if (e.overdue) r.over.add(e.taskGid);
  });
  return [...m.values()]
    .map((r) => ({ key: r.key, name: r.name, minutes: r.minutes, assigned: r.tasks.size, done: r.done.size, overdue: r.over.size }))
    .sort((a, b) => b.minutes - a.minutes || b.assigned - a.assigned);
}
function richTable(rows, label, showTime) {
  if (!rows.length) return '<p class="empty">No data for this selection.</p>';
  const th = `<th>${esc(label)}</th><th class="num">Tasks</th><th class="num">Completed</th><th class="num">Incomplete task</th>` +
    (showTime ? '<th class="num">Actual time</th>' : '');
  return `<div class="table-wrap card-scroll"><table class="data">
    <thead><tr>${th}</tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${label === 'Project' ? '📁 ' : `<span class="avatar">${esc(initials(r.name))}</span>`}${esc(r.name)}</td>
      <td class="num">${r.assigned}</td>
      <td class="num">${r.done}</td>
      <td class="num">${r.overdue ? `<span style="color:var(--danger)">${r.overdue}</span>` : 0}</td>
      ${showTime ? `<td class="num">${fmtDuration(r.minutes)}</td>` : ''}
    </tr>`).join('')}</tbody></table></div>`;
}
function exportRich(rows, label, showTime) {
  const header = [label, 'Tasks', 'Completed', 'Incomplete task'];
  if (showTime) header.push('Actual time (minutes)', 'Actual time');
  downloadCsv(`asana-${label.toLowerCase()}-${Date.now()}.csv`, header, rows.map((r) => {
    const row = [r.name, r.assigned, r.done, r.overdue];
    if (showTime) row.push(Math.round(r.minutes), fmtDuration(r.minutes));
    return row;
  }));
}

function renderOverview(panel, entries) {
  const r = state.report, f = state.filters;
  const showTime = r.method !== 'none';
  // Single source of truth = the filtered time-tracking entries (already scoped
  // by people / person / date-basis in applyFilters). Time is credited to the
  // person who LOGGED it (created_by → e.userGid), not the task's assignee.
  const fe = entries || applyFilters(r.entries);

  const byProject = entryAgg(fe, (e) => e.projectGid, (e) => e.projectName);
  const byPerson = entryAgg(fe, (e) => e.userGid, (e) => e.userName);

  const totalMin = fe.reduce((s, e) => s + e.minutes, 0);
  const taskCount = new Set(fe.map((e) => e.taskGid)).size;
  const sentence = `<b>${byPerson.length}</b> ${byPerson.length === 1 ? 'person' : 'people'} · <b>${byProject.length}</b> project${byProject.length !== 1 ? 's' : ''} · <b>${taskCount}</b> task${taskCount !== 1 ? 's' : ''}${showTime ? ` · <b>${fmtDuration(totalMin)}</b> tracked` : ''}.`;

  panel.innerHTML =
    `<div class="summary-hero">${sentence}</div>
     <div class="card" id="sum-projects" style="margin-bottom:18px"><div class="ov-head"><h3>📁 By project</h3><div class="ov-tools"><input class="input ov-search" placeholder="🔍 Find a project…"><button class="export-btn" id="ov-proj-csv">⬇ Excel/CSV</button></div></div>${richTable(byProject, 'Project', showTime)}</div>
     <div class="card" id="sum-people"><div class="ov-head"><h3>👥 By person <span class="muted">· time credited to who logged it</span></h3><div class="ov-tools"><input class="input ov-search" placeholder="🔍 Find a person…"><button class="export-btn" id="ov-emp-csv">⬇ Excel/CSV</button></div></div>${richTable(byPerson, 'Person', showTime)}</div>`;
  $('#ov-proj-csv').addEventListener('click', () => exportRich(byProject, 'Project', showTime));
  $('#ov-emp-csv').addEventListener('click', () => exportRich(byPerson, 'Person', showTime));
  // Live row filter — hide non-matching rows without re-rendering (keeps focus).
  panel.querySelectorAll('.ov-search').forEach((inp) => inp.addEventListener('input', () => {
    const card = inp.closest('.card'), q = inp.value.trim().toLowerCase();
    card.querySelectorAll('tbody tr').forEach((tr) => { const c = tr.querySelector('td'); tr.hidden = !!q && !((c && c.textContent) || '').toLowerCase().includes(q); });
  }));
}

/* ─── Content report (editorial teams only) ─────────────────
   A dedicated per-piece view for content projects: one row per task with the
   writer, editor, word count, time logged and quality score. It only surfaces
   when the current scope actually carries content custom fields — other
   projects never see this tab. Writer/editor come from custom fields whose
   VALUE is a name (a people/enum/text field); word count comes from the numeric
   editor/writer/word-count fields; quality from the quality field. */
// The textual value of a custom field. "Writer's Name" / "Editor's Name" are
// PEOPLE fields — their value is in people_value (an array of users), NOT
// display_value — so read that first, then fall back to enum/text.
function cfName(f) {
  if (f.people_value && f.people_value.length) return f.people_value.map((p) => p && p.name).filter(Boolean).join(', ');
  if (f.display_value != null && f.display_value !== '') return String(f.display_value);
  if (f.text_value != null && f.text_value !== '') return String(f.text_value);
  return '';
}
// Real-world editorial schemas annotate MANY field names with "Editor"/"Writer"
// (e.g. "Status(One select Field-Editor)", "…(Date Field- Pallavi / Lead
// Editor)"). Those are statuses/dates, not identities — so we take the WRITER
// and EDITOR names ONLY from Asana People fields, and skip factchecker/reviewer.
const FACTCHECK_RE = /factcheck|review/i;
const WC_RE = /word\s*count|\bwc\b|\bwords?\b/i;
function contentFields(t, specs) {
  let writer = '', editor = '', writerWords = 0, editorWords = 0, otherWords = 0;
  let wQ = null, wQL = '', eQ = null, eQL = '', gQ = null, gQL = '';
  (t.custom_fields || []).forEach((f) => {
    if (!f || !f.gid) return;
    const name = f.name || '';
    const isPeople = f.type === 'people' || (f.people_value && f.people_value.length > 0);
    const num = cfVal(f);
    const isWriter = /\bwriter/i.test(name), isEditor = /\beditor/i.test(name);
    // Names — People fields only, ignoring factchecker/reviewer.
    if (isPeople && !FACTCHECK_RE.test(name)) {
      const nm = cfName(f);
      if (nm) { if (isWriter) { if (!writer) writer = nm; } else if (isEditor) { if (!editor) editor = nm; } }
    }
    // Word count — number fields whose name says "word count / words / wc".
    if (num != null && WC_RE.test(name)) {
      if (isEditor) editorWords = editorWords || num;
      else if (isWriter) writerWords = writerWords || num;
      else otherWords = otherWords || num;
    }
    // Quality — split writer-rating vs editor-rating vs a generic quality field.
    if (classifyField(f, specs) === 'quality') {
      const lbl = cfName(f), isTextLbl = lbl && isNaN(parseFloat(lbl));
      if (isWriter) { if (num != null && wQ == null) wQ = num; else if (!wQL && isTextLbl) wQL = lbl; }
      else if (isEditor) { if (num != null && eQ == null) eQ = num; else if (!eQL && isTextLbl) eQL = lbl; }
      else { if (num != null && gQ == null) gQ = num; else if (!gQL && isTextLbl) gQL = lbl; }
    }
  });
  return {
    writer, editor,
    writerWords, editorWords, words: editorWords || writerWords || otherWords,
    writerQ: wQ != null ? wQ : gQ, writerQLbl: wQL || gQL,
    editorQ: eQ != null ? eQ : gQ, editorQLbl: eQL || gQL,
  };
}
// True for a content project: some task carries a Writer / Editor name value.
function scopeHasContent() {
  const r = state.report;
  if (!r || !r.tasks || !r.tasks.length) return false;
  if (r._hasContent !== undefined) return r._hasContent; // computed once per report
  const specs = resolveFieldSpecs(r.tasks);
  r._hasContent = r.tasks.some((t) => { const c = contentFields(t, specs); return !!(c.writer || c.editor); });
  return r._hasContent;
}
// Tasks in the current selection (people / person / date filters), plus a
// per-task time function — mirrors the Overview's scoping so numbers agree.
function buildTaskScope() {
  const r = state.report, f = state.filters;
  const today = startOfToday();
  const bounds = rangeBounds(f.range, f.from, f.to);
  const dateFilter = !(bounds[0] === null && bounds[1] === null);
  const basis = f.basis;
  const ebt = new Map();
  r.entries.forEach((e) => { let a = ebt.get(e.taskGid); if (!a) { a = []; ebt.set(e.taskGid, a); } a.push(e); });
  const taskDate = (t) => basis === 'created' ? parseDate(t.created_at) : basis === 'completed' ? parseDate(t.completed_at) : basis === 'due' ? parseDate(t.due_at || t.due_on) : null;
  const inScope = (t) => {
    if (f.people && f.people.size && (!t.assignee || !f.people.has(t.assignee.gid))) return false;
    if (f.person !== 'all' && (!t.assignee || t.assignee.gid !== f.person)) return false;
    if (!dateFilter) return true;
    if (basis === 'tracked') return (ebt.get(t.gid) || []).some((e) => inBounds(e.enteredOn, bounds));
    return inBounds(taskDate(t), bounds);
  };
  const timeFn = (t) => {
    if (basis === 'tracked' && dateFilter) return (ebt.get(t.gid) || []).filter((e) => inBounds(e.enteredOn, bounds)).reduce((s, e) => s + e.minutes, 0);
    return t.actual_time_minutes || 0;
  };
  const tasks = r.tasks.filter(inScope);
  tasks.forEach((t) => { const due = parseDate(t.due_at || t.due_on); t._overdue = !t.completed && due && due < today; });
  return { tasks, timeFn, showTime: r.method !== 'none' };
}
function contentQualityCell(row) {
  if (row.qNum != null) return String(Math.round(row.qNum * 10) / 10);
  return row.qLbl ? esc(row.qLbl) : '—';
}
// One role report (Writer or Editor) — a per-task table with that role's name,
// word count, time and quality, plus a hero summary, live search and CSV.
function roleReport(role, roleLabel, rows, showTime, idPrefix) {
  rows.sort((a, b) => b.minutes - a.minutes || b.words - a.words);
  const totalWords = rows.reduce((s, r) => s + (r.words || 0), 0);
  const totalMin = rows.reduce((s, r) => s + (r.minutes || 0), 0);
  const qVals = rows.filter((r) => r.qNum != null).map((r) => r.qNum);
  const avgQ = qVals.length ? Math.round((qVals.reduce((s, v) => s + v, 0) / qVals.length) * 10) / 10 : null;
  const showWords = totalWords > 0;
  const showQuality = rows.some((r) => r.qNum != null || r.qLbl);
  const num = (n) => n ? Math.round(n).toLocaleString() : '—';
  const hero = `<b>${rows.length}</b> task${rows.length !== 1 ? 's' : ''}` +
    (showWords ? ` · <b>${totalWords.toLocaleString()}</b> words` : '') +
    (showTime ? ` · <b>${fmtDuration(totalMin)}</b>` : '') +
    (avgQ != null ? ` · <b>${avgQ}</b> avg quality` : '') + '.';
  const th = `<th>Task</th><th>Project</th><th>${esc(roleLabel)}</th>` +
    (showWords ? '<th class="num">Word count</th>' : '') +
    (showTime ? '<th class="num">Actual time</th>' : '') +
    (showQuality ? '<th class="num">Quality</th>' : '');
  const body = rows.length ? rows.map((r) => `<tr>
      <td class="wrap">${esc(r.task)}</td>
      <td>${esc(r.project) || '—'}</td>
      <td>${r.name ? esc(r.name) : '—'}</td>
      ${showWords ? `<td class="num">${num(r.words)}</td>` : ''}
      ${showTime ? `<td class="num">${r.minutes ? fmtDuration(r.minutes) : '—'}</td>` : ''}
      ${showQuality ? `<td class="num">${contentQualityCell(r)}</td>` : ''}
    </tr>`).join('') : `<tr><td colspan="6" class="empty">No ${roleLabel.toLowerCase()} data in this selection.</td></tr>`;
  const icon = role === 'writer' ? '✍️' : '📝';
  return `<div class="card" style="margin-bottom:22px">
     <div class="ov-head"><h3>${icon} ${esc(roleLabel)} report <span class="muted" style="font-weight:400">· ${hero}</span></h3>
       <div class="ov-tools"><input class="input ov-search" placeholder="🔍 Find…"><button class="export-btn" id="${idPrefix}-csv">⬇ Excel/CSV</button></div></div>
     <div class="table-wrap card-scroll"><table class="data"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>
   </div>`;
}
function renderContent(panel) {
  const { tasks, timeFn, showTime } = buildTaskScope();
  const specs = resolveFieldSpecs(state.report.tasks);
  const writerRows = [], editorRows = [];
  tasks.forEach((t) => {
    const c = contentFields(t, specs);
    const base = { task: t.name || '(untitled)', project: t._projectName || '', minutes: timeFn(t) };
    if (c.writer || c.writerWords > 0 || c.writerQ != null || c.writerQLbl)
      writerRows.push({ ...base, name: c.writer, words: c.writerWords, qNum: c.writerQ, qLbl: c.writerQLbl });
    if (c.editor || c.editorWords > 0 || c.editorQ != null || c.editorQLbl)
      editorRows.push({ ...base, name: c.editor, words: c.editorWords, qNum: c.editorQ, qLbl: c.editorQLbl });
  });

  panel.innerHTML =
    roleReport('writer', 'Writer', writerRows, showTime, 'writer') +
    roleReport('editor', 'Editor', editorRows, showTime, 'editor');
  $('#writer-csv').addEventListener('click', () => exportContent(writerRows, 'Writer', showTime));
  $('#editor-csv').addEventListener('click', () => exportContent(editorRows, 'Editor', showTime));
  // Each card's search filters only its own rows.
  panel.querySelectorAll('.ov-search').forEach((inp) => inp.addEventListener('input', () => {
    const card = inp.closest('.card'), q = inp.value.trim().toLowerCase();
    card.querySelectorAll('tbody tr').forEach((tr) => { tr.hidden = !!q && !(tr.textContent || '').toLowerCase().includes(q); });
  }));
}
function exportContent(rows, roleLabel, showTime) {
  const showWords = rows.some((r) => r.words > 0);
  const showQuality = rows.some((r) => r.qNum != null || r.qLbl);
  const header = ['Task', 'Project', roleLabel];
  if (showWords) header.push('Word count');
  if (showTime) header.push('Time (minutes)', 'Time');
  if (showQuality) header.push('Quality');
  downloadCsv(`asana-${roleLabel.toLowerCase()}-report-${Date.now()}.csv`, header, rows.map((r) => {
    const row = [r.task, r.project, r.name || ''];
    if (showWords) row.push(Math.round(r.words) || 0);
    if (showTime) row.push(Math.round(r.minutes) || 0, r.minutes ? fmtDuration(r.minutes) : '');
    if (showQuality) row.push(r.qNum != null ? Math.round(r.qNum * 10) / 10 : (r.qLbl || ''));
    return row;
  }));
}

/* ─── (legacy drill-down helpers, kept for reference) ──────── */
function taskAgg(entries) {
  const m = new Map();
  entries.forEach((e) => { let r = m.get(e.taskGid); if (!r) { r = { name: e.taskName, project: e.projectName, url: e.permalink, minutes: 0, completed: e.completed, overdue: e.overdue }; m.set(e.taskGid, r); } r.minutes += e.minutes; });
  return [...m.values()].sort((a, b) => b.minutes - a.minutes);
}
function statusWord(t) { return t.completed ? '<span class="status-word done">Done</span>' : t.overdue ? '<span class="status-word late">Late</span>' : '<span class="status-word open">Open</span>'; }

function personRow(p, noTime) {
  const meta = noTime ? `${p.tasks} task${p.tasks !== 1 ? 's' : ''}` : `${fmtDuration(p.minutes)} · ${p.tasks} task${p.tasks !== 1 ? 's' : ''} · ${p.projects} project${p.projects !== 1 ? 's' : ''}`;
  return `<div class="detail-row" data-key="${esc(p.key)}"><div class="detail-head"><span class="mini-avatar">${esc(initials(p.name))}</span><span class="detail-name">${esc(p.name)}</span><span class="detail-meta">${meta}</span><span class="chev">▾</span></div><div class="detail-body" data-kind="person"></div></div>`;
}
function projectRow(p, noTime) {
  const meta = noTime ? `${p.tasks} task${p.tasks !== 1 ? 's' : ''} · ${p.users} ${p.users !== 1 ? 'people' : 'person'}` : `${fmtDuration(p.minutes)} · ${p.users} ${p.users !== 1 ? 'people' : 'person'} · ${p.tasks} task${p.tasks !== 1 ? 's' : ''}`;
  return `<div class="detail-row" data-key="${esc(p.key)}"><div class="detail-head"><span class="proj-dot">📁</span><span class="detail-name">${esc(p.name)}</span><span class="detail-meta">${meta}</span><span class="chev">▾</span></div><div class="detail-body" data-kind="project"></div></div>`;
}
function personBody(entries, userGid, noTime) {
  const mine = entries.filter((e) => e.userGid === userGid);
  const byProject = aggBy(mine, (e) => e.projectGid, (e) => e.projectName).sort((a, b) => b.minutes - a.minutes);
  const tasks = taskAgg(mine);
  const projLines = byProject.map((p) => `<div class="db-line"><span>📁 ${esc(p.name)}</span><span class="db-val">${noTime ? p.tasks + ' tasks' : fmtDuration(p.minutes)}</span></div>`).join('');
  const taskLines = taskAggLines(tasks, noTime);
  return `<div class="db-section"><div class="db-label">Projects they worked on</div>${projLines || '<div class="muted">None</div>'}</div>
          <div class="db-section"><div class="db-label">Their tasks (${tasks.length})</div>${taskLines}</div>`;
}
function projectBody(entries, projectGid, noTime) {
  const mine = entries.filter((e) => e.projectGid === projectGid);
  const byPerson = aggBy(mine, (e) => e.userGid, (e) => e.userName).sort((a, b) => b.minutes - a.minutes);
  const tasks = taskAgg(mine);
  const peopleLines = byPerson.map((p) => `<div class="db-line"><span><span class="mini-avatar">${esc(initials(p.name))}</span>${esc(p.name)}</span><span class="db-val">${noTime ? p.tasks + ' tasks' : fmtDuration(p.minutes)}</span></div>`).join('');
  const taskLines = taskAggLines(tasks, noTime);
  return `<div class="db-section"><div class="db-label">People who worked on it</div>${peopleLines || '<div class="muted">Nobody logged time.</div>'}</div>
          <div class="db-section"><div class="db-label">Tasks (${tasks.length})</div>${taskLines}</div>`;
}
function personProjectRows(entries) {
  const m = new Map();
  entries.forEach((e) => { const k = e.userGid + '|' + e.projectGid; let r = m.get(k); if (!r) { r = { person: e.userName, project: e.projectName, minutes: 0, tasks: new Set(), done: new Set() }; m.set(k, r); } r.minutes += e.minutes; r.tasks.add(e.taskGid); if (e.completed) r.done.add(e.taskGid); });
  return [...m.values()].map((r) => ({ person: r.person, project: r.project, minutes: r.minutes, tasks: r.tasks.size, done: r.done.size }))
    .sort((a, b) => a.person.localeCompare(b.person) || b.minutes - a.minutes);
}
function personProjectTable(entries, noTime) {
  const rows = personProjectRows(entries);
  if (!rows.length) return '<p class="empty">No data for this selection.</p>';
  return `<div class="table-wrap"><table class="data">
    <thead><tr><th>Person</th><th>Project</th>${noTime ? '' : '<th class="num">Time spent</th>'}<th class="num">Tasks</th><th class="num">Done</th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td><span class="avatar">${esc(initials(r.person))}</span>${esc(r.person)}</td><td>${esc(r.project)}</td>${noTime ? '' : `<td class="num">${fmtDuration(r.minutes)}</td>`}<td class="num">${r.tasks}</td><td class="num">${r.done}</td></tr>`).join('')}</tbody>
  </table></div>`;
}
function exportPersonProject(entries) {
  const rows = personProjectRows(entries);
  downloadCsv(`asana-person-project-${Date.now()}.csv`, ['Person', 'Project', 'Minutes', 'Hours', 'Tasks', 'Tasks done'], rows.map((r) => [r.person, r.project, Math.round(r.minutes), round1(r.minutes / 60), r.tasks, r.done]));
}

function taskAggLines(tasks, noTime) {
  if (!tasks.length) return '<div class="muted">No tasks.</div>';
  const shown = tasks.slice(0, 40);
  const lines = shown.map((t) => `<div class="db-line"><span class="link-plain">${esc(t.name)}</span><span class="db-val">${noTime ? statusWord(t) : fmtDuration(t.minutes) + ' ' + statusWord(t)}</span></div>`).join('');
  return lines + (tasks.length > 40 ? `<div class="muted" style="padding:6px 10px">…and ${tasks.length - 40} more</div>` : '');
}

/* ─── Charts panel ─────────────────────────────────────────── */
function renderCharts(panel, entries) {
  const f = state.filters, metric = f.metric;
  const people = aggBy(entries.filter((e) => e.minutes > 0 || state.report.method === 'none'), (e) => e.userGid, (e) => e.userName).sort((a, b) => metricVal(b, metric) - metricVal(a, metric));
  const projects = aggBy(entries.filter((e) => e.minutes > 0 || state.report.method === 'none'), (e) => e.projectGid, (e) => e.projectName).sort((a, b) => metricVal(b, metric) - metricVal(a, metric));
  const pMax = people[0] ? metricVal(people[0], metric) : 1;

  panel.innerHTML = `<div class="chart-grid">
      <div class="card"><h3>By employee <span class="muted">· click to filter</span></h3>${barList(people.slice(0, 14).map((r) => ({ key: r.key, label: r.name, value: metricVal(r, metric), max: pMax, text: metricText(r, metric), sub: `${r.tasks}t`, avatar: true, click: true, active: f.person === r.key })))}</div>
      <div class="card"><h3>By project</h3><canvas id="c-proj" height="230"></canvas></div>
      <div class="card wide"><h3>Trend — time logged over time</h3><canvas id="c-trend" height="150"></canvas></div>
      <div class="card"><h3>Task status</h3><canvas id="c-status" height="220"></canvas></div>
      <div class="card"><h3>Top tasks by time</h3>${topTasks(entries)}</div>
    </div>`;

  // Click-to-filter on employee bars
  $$('#panel-charts .bar-row.click').forEach((el) => el.addEventListener('click', () => { f.person = (f.person === el.dataset.key) ? 'all' : el.dataset.key; updatePanels(); }));

  // Project donut
  const pr = projects.slice(0, 8);
  drawDoughnut('c-proj', pr.map((r) => r.name), pr.map((r) => metric === 'time' ? round1(r.minutes / 60) : metricVal(r, metric)), null, metric === 'time' ? 'h' : '');

  // Trend line
  const tr = trendData(entries, f.basis);
  if (tr) drawLine('c-trend', tr.labels, tr.data);
  else { const c = $('#c-trend'); if (c) c.replaceWith(Object.assign(document.createElement('p'), { className: 'empty', textContent: 'No dated time to trend.' })); }

  // Status donut (distinct tasks in scope)
  const seen = new Set(); let done = 0, over = 0, open = 0;
  entries.forEach((e) => { if (seen.has(e.taskGid)) return; seen.add(e.taskGid); if (e.completed) done++; else if (e.overdue) over++; else open++; });
  drawDoughnut('c-status', ['Completed', 'Incomplete task', 'Open'], [done, over, open], [cssv('--ok'), cssv('--danger'), cssv('--accent')]);
}
function topTasks(entries) {
  const m = new Map();
  entries.forEach((e) => { let r = m.get(e.taskGid); if (!r) { r = { name: e.taskName, project: e.projectName, minutes: 0, url: e.permalink }; m.set(e.taskGid, r); } r.minutes += e.minutes; });
  const rows = [...m.values()].filter((r) => r.minutes > 0).sort((a, b) => b.minutes - a.minutes).slice(0, 8);
  if (!rows.length) return '<p class="empty">No time on tasks.</p>';
  const max = rows[0].minutes;
  return barList(rows.map((r) => ({ label: r.name, value: r.minutes, max, text: fmtDuration(r.minutes) })));
}
function trendData(entries, basis) {
  const dated = entries.filter((e) => e.minutes > 0 && dateFor(e, basis));
  if (!dated.length) return null;
  let mn = Infinity, mx = -Infinity;
  for (const e of dated) { const t = +dateFor(e, basis); if (t < mn) mn = t; if (t > mx) mx = t; }
  const span = (mx - mn) / DAY;
  const unit = span <= 45 ? 'day' : span <= 220 ? 'week' : 'month';
  const bucket = new Map();
  dated.forEach((e) => { const k = +bucketStart(dateFor(e, basis), unit); bucket.set(k, (bucket.get(k) || 0) + e.minutes); });
  const keys = [...bucket.keys()].sort((a, b) => a - b);
  const fmt = unit === 'month' ? { month: 'short', year: '2-digit' } : { month: 'short', day: 'numeric' };
  return { labels: keys.map((k) => new Date(k).toLocaleDateString(undefined, fmt)), data: keys.map((k) => round1(bucket.get(k) / 60)) };
}
function bucketStart(d, unit) { const x = new Date(d); if (unit === 'day') x.setHours(0, 0, 0, 0); else if (unit === 'week') { const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); x.setHours(0, 0, 0, 0); } else { x.setDate(1); x.setHours(0, 0, 0, 0); } return x; }
const round1 = (n) => Math.round(n * 10) / 10;

/* ─── Spreadsheet panel ────────────────────────────────────── */
const SHEET_COLS = [
  { key: 'taskName', label: 'Task', type: 'str', cls: 'wrap' },
  { key: 'projectName', label: 'Project', type: 'str' },
  { key: 'section', label: 'Section', type: 'str' },
  { key: 'userName', label: 'Assignee', type: 'str' },
  { key: 'minutes', label: 'Actual time', type: 'num' },
  { key: 'enteredOn', label: 'Logged on', type: 'date' },
  { key: 'status', label: 'Status', type: 'str' },
  { key: 'due', label: 'Due date', type: 'date' },
];
function sheetRows(entries) {
  const s = state.filters.sort;
  const col = SHEET_COLS.find((c) => c.key === s.col) || SHEET_COLS[4];
  const val = (e) => col.key === 'status' ? statusOf(e) : e[col.key];
  const rows = entries.slice().sort((a, b) => {
    let va = val(a), vb = val(b);
    if (col.type === 'num') { va = +va || 0; vb = +vb || 0; }
    else if (col.type === 'date') { va = va ? +va : 0; vb = vb ? +vb : 0; }
    else { va = String(va || '').toLowerCase(); vb = String(vb || '').toLowerCase(); }
    return va < vb ? -1 : va > vb ? 1 : 0;
  });
  return s.dir === 'desc' ? rows.reverse() : rows;
}
function renderSheet(panel, entries) {
  const s = state.filters.sort;
  const rows = sheetRows(entries);
  const cap = 800;
  const head = '<tr>' + SHEET_COLS.map((c) => `<th data-col="${c.key}"${c.type === 'num' ? ' class="num"' : ''}>${esc(c.label)} ${s.col === c.key ? `<span class="arrow">${s.dir === 'desc' ? '▼' : '▲'}</span>` : ''}</th>`).join('') + '</tr>';
  const cell = (e, c) => {
    if (c.key === 'taskName') return `<td class="wrap">${esc(e.taskName)}</td>`;
    if (c.key === 'minutes') return `<td class="num">${fmtDuration(e.minutes)}</td>`;
    if (c.key === 'status') return `<td>${statusOf(e)}</td>`;
    if (c.type === 'date') return `<td>${e[c.key] ? fmtDate(e[c.key]) : '—'}</td>`;
    return `<td>${esc(e[c.key] || '—')}</td>`;
  };
  const bodyRows = rows.slice(0, cap).map((e) => '<tr>' + SHEET_COLS.map((c) => cell(e, c)).join('') + '</tr>').join('');
  panel.innerHTML = `<div class="sheet-wrap"><table class="sheet"><thead>${head}</thead><tbody>${bodyRows || `<tr><td colspan="${SHEET_COLS.length}" class="empty">No rows.</td></tr>`}</tbody></table></div>
    <div class="sheet-foot"><span>${rows.length} row${rows.length !== 1 ? 's' : ''}${rows.length > cap ? ` (showing first ${cap})` : ''}</span><button class="export-btn" id="sheet-csv">⬇ Export all as CSV</button></div>`;
  $$('#panel-sheet thead th').forEach((th) => th.addEventListener('click', () => { const c = th.dataset.col; if (s.col === c) s.dir = s.dir === 'desc' ? 'asc' : 'desc'; else { s.col = c; s.dir = SHEET_COLS.find((x) => x.key === c).type === 'str' ? 'asc' : 'desc'; } renderSheet(panel, entries); }));
  $('#sheet-csv').addEventListener('click', () => exportRowsCsv(rows));
}

/* ─── Matrix panel ─────────────────────────────────────────── */
function renderMatrix(panel, entries, metric) {
  panel.innerHTML = `<div class="card"><h3>Actual time by assignee × project</h3><p class="muted" style="margin:-8px 0 14px">Rows = assignees, columns = projects. Darker = more.</p>${matrixTable(entries, metric)}</div>`;
}
function matrixTable(entries, metric) {
  const people = aggBy(entries, (e) => e.userGid, (e) => e.userName).sort((a, b) => b.minutes - a.minutes).slice(0, 25);
  const projects = aggBy(entries, (e) => e.projectGid, (e) => e.projectName).sort((a, b) => b.minutes - a.minutes).slice(0, 14);
  if (!people.length || !projects.length) return '<p class="empty">No data.</p>';
  const cell = new Map();
  entries.forEach((e) => { const k = e.userGid + '|' + e.projectGid; let r = cell.get(k); if (!r) { r = { minutes: 0, tasks: new Set() }; cell.set(k, r); } r.minutes += e.minutes; r.tasks.add(e.taskGid); });
  const valOf = (u, p) => { const r = cell.get(u + '|' + p); if (!r) return 0; return metric === 'time' ? r.minutes : r.tasks.size; };
  const disp = (v) => v === 0 ? '·' : (metric === 'time' ? fmtDuration(v) : v);
  let max = 0; people.forEach((u) => projects.forEach((p) => { max = Math.max(max, valOf(u.key, p.key)); }));
  const head = `<thead><tr><th class="corner">Person \\ Project</th>${projects.map((p) => `<th title="${esc(p.name)}">${esc(trunc(p.name, 15))}</th>`).join('')}<th class="total-col">Total</th></tr></thead>`;
  const body = '<tbody>' + people.map((u) => {
    const cells = projects.map((p) => { const v = valOf(u.key, p.key); const a = max ? v / max : 0; const bg = v ? ` style="background:color-mix(in srgb, var(--accent) ${Math.round(a * 55)}%, transparent)"` : ''; return `<td class="${v ? '' : 'cell-0'}"${bg}>${disp(v)}</td>`; }).join('');
    return `<tr><th>${esc(u.name)}</th>${cells}<td class="total-col">${metric === 'time' ? fmtDuration(u.minutes) : metricVal(u, metric)}</td></tr>`;
  }).join('') + '</tbody>';
  const foot = `<tfoot><tr><th>Total</th>${projects.map((p) => { let m = 0; people.forEach((u) => (m += valOf(u.key, p.key))); return `<td>${disp(m)}</td>`; }).join('')}<td class="total-col"></td></tr></tfoot>`;
  return `<div class="matrix-wrap"><table class="matrix">${head}${body}${foot}</table></div>`;
}
const trunc = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

/* ─── CSV export ───────────────────────────────────────────── */
function downloadCsv(name, header, rows) {
  const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const csv = [header.map(q).join(','), ...rows.map((r) => r.map(q).join(','))].join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
}
function exportRowsCsv(rows) {
  const header = ['Task', 'Project', 'Section', 'Person', 'Minutes', 'Hours', 'Logged on', 'Status', 'Due'];
  const data = rows.map((e) => [e.taskName, e.projectName, e.section, e.userName, Math.round(e.minutes), round1(e.minutes / 60), e.enteredOn ? fmtDate(e.enteredOn) : '', statusOf(e), e.due ? fmtDate(e.due) : '']);
  downloadCsv(`asana-time-${Date.now()}.csv`, header, data);
}

/* ─── Shared render bits ───────────────────────────────────── */
function reportHead(title, sub, tag) { return `<div class="report-head"><div><h2>${esc(title)}</h2><div class="rh-sub">${esc(sub)}</div></div><span class="report-tag">${esc(tag)}</span></div>`; }
function stat(val, label, cls, sub) { return `<div class="stat ${cls || ''}"><div class="s-val">${val}</div><div class="s-label">${esc(label)}</div>${sub ? `<div class="s-sub muted">${sub}</div>` : ''}</div>`; }
function barList(items) {
  if (!items.length) return '<p class="empty">No data.</p>';
  const max = Math.max(1, ...items.map((i) => i.max || i.value || 0));
  return `<div class="bar-list">${items.map((it) => {
    const m = it.max || max; const w = m ? Math.max(2, Math.round((it.value / m) * 100)) : 0;
    return `<div class="bar-row ${it.click ? 'click' : ''} ${it.active ? 'active' : ''}" ${it.key != null ? `data-key="${esc(it.key)}"` : ''}><span class="bar-name">${it.avatar ? `<span class="mini-avatar">${esc(initials(it.label))}</span>` : ''}${esc(it.label)}</span><span class="bar-track"><span class="bar-fill" style="width:${w}%"></span></span><span class="bar-val">${esc(String(it.text))}${it.sub ? ` <small>${esc(it.sub)}</small>` : ''}</span></div>`;
  }).join('')}</div>`;
}

/* ═══ Charts (Chart.js) ════════════════════════════════════ */
function cssv(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
function destroy(id) { if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; } }
function destroyAllCharts() { Object.keys(state.charts).forEach(destroy); }
// Turn OFF chart animations and cap the canvas pixel ratio. Animated canvas
// redraws (which also re-run on every tab switch / filter change) are a big
// jank/"page unresponsive" source on weak laptops; static charts are instant.
let _chartCfg = false;
function chartDefaults() {
  if (_chartCfg || typeof Chart === 'undefined') return;
  _chartCfg = true;
  Chart.defaults.animation = false;
  Chart.defaults.animations = { colors: false, x: false, y: false };
  Chart.defaults.devicePixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);
}
function drawDoughnut(id, labels, data, colors, unit) {
  if (typeof Chart === 'undefined' || !$('#' + id)) return; chartDefaults(); destroy(id);
  const palette = colors || [cssv('--accent'), cssv('--accent-2'), cssv('--ok'), cssv('--warn'), cssv('--danger'), cssv('--info'), '#ec4899', '#14b8a6', '#f97316'];
  state.charts[id] = new Chart($('#' + id), { type: 'doughnut', data: { labels, datasets: [{ data, backgroundColor: palette, borderWidth: 0 }] }, options: { cutout: '60%', plugins: { legend: { position: 'right', labels: { color: cssv('--text-dim'), boxWidth: 11, padding: 9, font: { size: 11 } } }, tooltip: { callbacks: unit === 'h' ? { label: (c) => `${c.label}: ${c.parsed}h` } : {} } } } });
}
function drawLine(id, labels, data) {
  if (typeof Chart === 'undefined' || !$('#' + id)) return; chartDefaults(); destroy(id);
  state.charts[id] = new Chart($('#' + id), { type: 'line', data: { labels, datasets: [{ data, borderColor: cssv('--accent'), backgroundColor: cssv('--accent') + '22', fill: true, tension: 0.32, pointRadius: 2, borderWidth: 2 }] }, options: { plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.parsed.y}h` } } }, scales: { x: { ticks: { color: cssv('--text-dim'), maxRotation: 0, autoSkip: true }, grid: { display: false } }, y: { beginAtZero: true, ticks: { color: cssv('--text-dim'), callback: (v) => v + 'h' }, grid: { color: cssv('--border') } } } } });
}

/* ═══════════════════════════════════════════════════════════
   CUSTOM REPORT (AI planner → scoped fetch → deterministic render)
   ═══════════════════════════════════════════════════════════ */
async function loadModels() {
  try {
    const res = await apiJson('/api/groq/models');
    const models = (res.data || []).map((m) => m.id).filter((id) => !/whisper|tts|guard|embedding|prompt-guard/i.test(id)).sort();
    if (!models.length) return;
    state.ai.model = models.find((m) => /gpt-oss-120b/.test(m)) || models.find((m) => /llama-3\.3-70b/.test(m)) || models.find((m) => /gpt-oss-20b/.test(m)) || models[0];
    $('#ai-model-tag').textContent = state.ai.model;
  } catch { $('#ai-model-tag').textContent = 'AI unavailable'; }
}

const SPEC_SCHEMA = `Return ONLY a JSON object:
{
 "understood": boolean,
 "title": string,
 "interpretation": string,
 "group_by": [string],   // 1-2 of: "employee","project","section","status","month"
 "metric": string,       // "time" | "tasks" | "contributors"
 "date_basis": string,   // "logged" | "created" | "completed"
 "range": string,        // "all","week","last_week","month","last_month","quarter","year"
 "filter_status": string,// "all","incomplete","complete","overdue"
 "employee_contains": string|null,
 "project_contains": string|null,
 "chart": string,        // "bar","doughnut","table","matrix"
 "sort": string,         // "desc"|"asc"
 "limit": number
}
"done by"/"worked on" = anyone who LOGGED TIME (created_by), not who completed. Use 2 group_by + "matrix" for cross-tabs like employee-by-project.`;

function aiExamples() {
  const ex = ['Time each person spent this month', 'Time per project this quarter', 'Employee vs project time matrix', 'Who worked the most on marketing', 'Tasks done by each person last week'];
  $('#chat-examples').innerHTML = ex.map((e) => `<button class="example-chip">${esc(e)}</button>`).join('');
  $$('#chat-examples .example-chip').forEach((b) => b.addEventListener('click', () => { $('#chat-text').value = b.textContent; runCustom(); }));
}

// 🥚 Easter eggs — playful replies for non-report chatter.
function funnyResponse(qRaw) {
  const q = qRaw.trim().toLowerCase();
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const eggs = [
    { t: /meow|kitty|kitten|🐱|🐈/, r: () => pick(['🐱 Meow! I logged 3 hours chasing a laser pointer. Sadly Asana can’t track that.', '🐈 Meow meow. Translation: “feed me, then generate a report.”', '😼 A cat’s timesheet: 18h napping · 2h judging you · 0h on tasks.']) },
    { t: /woof|bark|puppy|doggo|🐶|🐕/, r: () => pick(['🐶 Woof! Good hooman. Here’s a treat: try “time per project this week”.', '🐕 Bark bark! I fetched… nothing, because you typed woof.', '🦴 Dogs log 10h/day of pure loyalty. Untracked, tragically.']) },
    { t: /^(hi|hii+|hello+|hey+|yo|hola|namaste|sup|howdy)\b/, r: () => pick(['👋 Hello! I’m your time-report genie. Ask me for a report!', '😊 Hey there! Try “who worked the most this month”.']) },
    { t: /how are you|how r u|how are u|how's it going/, r: 'I’m 100% caffeine-free and still buzzing. ☕ Ask me for a report!' },
    { t: /who are you|what are you|your name|are you (a )?(bot|ai|robot)/, r: '🤖 I’m the Asana Dash assistant. I turn plain words into real reports. Small talk is a bonus feature.' },
    { t: /i love you|marry me|love u|will you be mine/, r: '❤️ Aww. I love a clean, well-filtered dataset too. Let’s take it slow — start with “time per project”.' },
    { t: /joke|make me laugh|funny|lol|haha/, r: () => pick(['Why did the task cross the road? To reach the “Done” column. 🚦', 'I promised my manager I’d finish “on time.” Now I’m just a time-tracking entry. ⏱️', 'There are 10 kinds of people: those who log time, and those who guess. 😅']) },
    { t: /\b42\b|meaning of life/, r: '42 — the meaning of life, the universe, and roughly how many hours are missing from everyone’s timesheet. 🌌' },
    { t: /coffee|chai|\btea\b|espresso/, r: '☕ Best I can brew is a fresh report. Try “time per person this week”.' },
    { t: /raise|promotion|fire me|salary|bonus/, r: '💸 I can show who logged the most hours — build your case with “who worked the most this month”. 😉' },
    { t: /^ping\b/, r: '🏓 Pong!' },
    { t: /knock knock/, r: '🚪 Knock knock. Who’s there? A report you haven’t generated yet. Try “time per project”.' },
    { t: /sing|song|music/, r: '🎵 “Nine to five, what a way to make a livin’…” 🎶 Okay, I’ll stop. Ask me for a report!' },
    { t: /\bboss\b|manager/, r: '🧑‍💼 Tell the boss the data’s ready. Try “time by person and project”.' },
    { t: /weather|raining|sunny/, r: '🌤️ Forecast: 100% chance of insightful reports. Try “overdue tasks this month”.' },
    { t: /help|what can you do|how (do i|to) use|examples/, r: '💡 Ask in plain words! Examples: “time per project this month” · “who worked most on marketing” · “employee vs project matrix”.' },
    { t: /thank|thanks|thx|ty\b/, r: '🙏 Anytime! Now go make a chart look important in a meeting.' },
    { t: /boo|👻/, r: '👻 Boo! Did I scare up any overtime? Try “time this week”.' },
    { t: /\bfire\b|🔥|lit|awesome|cool/, r: '🔥 This report’s about to be fire. Give me something to work with!' },
    { t: /good (morning|night|evening|afternoon)/, r: '😌 And a lovely one to you! Shall we peek at “time this week”?' },
    { t: /bored|boring/, r: '🥱 Bored? Let’s spice it up — “employee vs project time matrix” is basically a fireworks show.' },
    { t: /moo|🐮|cow/, r: '🐮 Moo! I herd you like reports. Try “time per project”.' },
  ];
  for (const e of eggs) if (e.t.test(q)) return typeof e.r === 'function' ? e.r() : e.r;
  if (q.length <= 3 && !/\d/.test(q) && !/^(all|me)$/.test(q)) return '🤔 That’s short and mysterious. Try something like “time per project this month”.';
  return null;
}

async function runCustom() {
  const query = $('#chat-text').value.trim();
  const out = $('#custom-output');
  if (!query) return;
  const egg = funnyResponse(query);   // 🥚 fun replies before we bother the AI
  if (egg) { out.innerHTML = `<div class="egg-card"><div class="egg-text">${egg}</div><div class="egg-hint">…but I do real reports too — tap an example below or ask me anything. 👇</div></div>`; return; }
  if (!state.config.groq) { out.innerHTML = `<div class="banner error" style="margin:0">Groq key not configured (.env → GROQ_API_KEY).</div>`; return; }
  if (!state.ai.model) { out.innerHTML = `<div class="banner warn" style="margin:0">No Groq model available.</div>`; return; }
  const btn = $('#chat-send'); btn.disabled = true; btn.textContent = 'Thinking…';
  out.innerHTML = `<div class="card"><div class="progress-note"><div class="spinner"></div><span>Understanding your request…</span></div></div>`;
  try {
    const spec = await planReport(query);
    if (!spec.understood) { out.innerHTML = `<div class="ai-interpret"><b>I couldn’t map that to the data.</b> ${esc(spec.interpretation || 'Try e.g. “time per project this month”.')}</div>`; return; }
    // Resolve scope + fetch just that.
    let gids;
    if (spec.project_contains) { const q = spec.project_contains.toLowerCase(); gids = state.projects.filter((p) => p.name.toLowerCase().includes(q)).map((p) => p.gid); }
    if (!gids || !gids.length) gids = state.projects.map((p) => p.gid);
    const precise = gids.length <= 8;
    await loadCachedScope(gids, (m) => { const s = out.querySelector('span'); if (s) s.textContent = m; }).catch(() => {});
    const scope = await fetchScope(gids, precise, (msg) => { const s = out.querySelector('span'); if (s) s.textContent = msg; });
    renderCustomResult(out, spec, scope, query);
  } catch (e) { out.innerHTML = `<div class="banner error" style="margin:0">AI request failed: ${esc(e.message)}</div>`; }
  finally { btn.disabled = false; btn.textContent = 'Ask ✦'; }
}

async function planReport(query) {
  const sys = `You translate a plain-language request into a strict report spec for an Asana time-analytics tool. ${SPEC_SCHEMA}
Available projects: ${JSON.stringify(state.projects.slice(0, 80).map((p) => p.name))}
Available people: ${JSON.stringify(state.users.slice(0, 100).map((u) => u.name))}
Map loose names to project_contains/employee_contains substrings. JSON only.`;
  const body = { model: state.ai.model, temperature: 0.1, max_tokens: 500, messages: [{ role: 'system', content: sys }, { role: 'user', content: query }], response_format: { type: 'json_object' } };
  let content;
  try { const res = await apiJson('/api/groq/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); content = res.choices && res.choices[0] && res.choices[0].message.content; }
  catch { delete body.response_format; const res = await apiJson('/api/groq/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); content = res.choices && res.choices[0] && res.choices[0].message.content; }
  return normalizeSpec(extractJson(content));
}
function extractJson(text) { if (!text) return {}; try { return JSON.parse(text); } catch {} const a = text.indexOf('{'), b = text.lastIndexOf('}'); if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch {} } return {}; }
function normalizeSpec(s) {
  const oneOf = (v, arr, d) => arr.includes(v) ? v : d;
  const gb = (Array.isArray(s.group_by) ? s.group_by : [s.group_by]).filter(Boolean).map((x) => oneOf(x, ['employee', 'project', 'section', 'status', 'month'], null)).filter(Boolean);
  return {
    understood: s.understood !== false && gb.length > 0,
    title: s.title || 'Custom report', interpretation: s.interpretation || '',
    group_by: gb.length ? gb.slice(0, 2) : ['employee'],
    metric: oneOf(s.metric, ['time', 'tasks', 'contributors'], 'time'),
    date_basis: oneOf(s.date_basis, ['logged', 'created', 'completed'], 'logged'),
    range: oneOf(s.range, ['all', 'week', 'last_week', 'month', 'last_month', 'quarter', 'year'], 'all'),
    filter_status: oneOf(s.filter_status, ['all', 'incomplete', 'complete', 'overdue'], 'all'),
    employee_contains: s.employee_contains || null, project_contains: s.project_contains || null,
    chart: oneOf(s.chart, ['bar', 'doughnut', 'table', 'matrix'], gb.length > 1 ? 'matrix' : 'bar'),
    sort: oneOf(s.sort, ['desc', 'asc'], 'desc'), limit: Math.min(50, Math.max(3, +s.limit || 15)),
  };
}

function renderCustomResult(out, spec, scope, query) {
  const f = { basis: spec.date_basis, range: spec.range, from: null, to: null, metric: spec.metric, search: '', person: 'all' };
  let entries = applyFilters(scope.entries, f);
  if (spec.employee_contains) { const q = spec.employee_contains.toLowerCase(); entries = entries.filter((e) => (e.userName || '').toLowerCase().includes(q)); }
  if (spec.filter_status !== 'all') entries = entries.filter((e) => spec.filter_status === 'complete' ? e.completed : spec.filter_status === 'incomplete' ? !e.completed : spec.filter_status === 'overdue' ? e.overdue : true);

  const header = `<div class="ai-interpret"><b>Understood as:</b> ${esc(spec.interpretation || query)} <span class="muted">· metric: ${spec.metric} · basis: ${spec.date_basis} · range: ${spec.range}${scope.method !== 'entries' ? ' · ' + methodTag(scope.method).toLowerCase() : ''}</span></div>`;
  if (!entries.length) { out.innerHTML = header + '<p class="empty">No matching data for that request.</p>'; return; }

  let viz;
  if (spec.group_by.length >= 2 && spec.chart === 'matrix') {
    viz = `<div class="card"><h3>${esc(spec.title)}</h3>${matrixByDims(entries, spec)}</div>`;
  } else {
    const [kf, nf] = groupKey[spec.group_by[0]];
    let rows = aggBy(entries, kf, nf).sort((a, b) => (spec.sort === 'asc' ? 1 : -1) * (metricVal(a, spec.metric) - metricVal(b, spec.metric))).slice(0, spec.limit);
    if (spec.chart === 'doughnut') viz = `<div class="card"><h3>${esc(spec.title)}</h3><canvas id="c-cust" height="240"></canvas></div>`;
    else { const max = rows[0] ? metricVal(rows[0], spec.metric) : 1; viz = `<div class="card"><h3>${esc(spec.title)}</h3>${barList(rows.map((r) => ({ label: r.name, value: metricVal(r, spec.metric), max, text: metricText(r, spec.metric), avatar: spec.group_by[0] === 'employee' })))}</div>`; }
    setTimeout(() => { if (spec.chart === 'doughnut') drawDoughnut('c-cust', rows.map((r) => r.name), rows.map((r) => spec.metric === 'time' ? round1(r.minutes / 60) : metricVal(r, spec.metric)), null, spec.metric === 'time' ? 'h' : ''); }, 0);
  }

  // Spreadsheet of the underlying entries + CSV
  const sorted = entries.slice().sort((a, b) => b.minutes - a.minutes);
  const sheet = `<div class="card" style="margin-top:18px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><h3 style="margin:0">Underlying data <span class="muted">· ${sorted.length} rows</span></h3><button class="export-btn" id="cust-csv">⬇ CSV</button></div><div class="sheet-wrap" style="max-height:360px"><table class="sheet"><thead><tr><th>Task</th><th>Project</th><th>Assignee</th><th>Actual time</th><th>Logged on</th><th>Status</th></tr></thead><tbody>${sorted.slice(0, 400).map((e) => `<tr><td class="wrap">${esc(e.taskName)}</td><td>${esc(e.projectName)}</td><td>${esc(e.userName)}</td><td class="num">${fmtDuration(e.minutes)}</td><td>${e.enteredOn ? fmtDate(e.enteredOn) : '—'}</td><td>${statusOf(e)}</td></tr>`).join('')}</tbody></table></div></div>`;

  out.innerHTML = header + reportHead(spec.title, spec.group_by.join(' × ') + ' · ' + spec.metric, 'AI report') + viz + sheet;
  $('#cust-csv').addEventListener('click', () => exportRowsCsv(sorted));
}

function matrixByDims(entries, spec) {
  const dims = spec.group_by;
  const rowDim = dims.includes('employee') ? 'employee' : dims[0];
  const colDim = dims.find((d) => d !== rowDim) || (rowDim === 'employee' ? 'project' : 'employee');
  const [rk, rn] = groupKey[rowDim], [ck, cn] = groupKey[colDim];
  const rowAgg = aggBy(entries, rk, rn).sort((a, b) => b.minutes - a.minutes).slice(0, 22);
  const colAgg = aggBy(entries, ck, cn).sort((a, b) => b.minutes - a.minutes).slice(0, 13);
  const cell = new Map();
  entries.forEach((e) => { const k = rk(e) + '|' + ck(e); let r = cell.get(k); if (!r) { r = { minutes: 0, tasks: new Set() }; cell.set(k, r); } r.minutes += e.minutes; r.tasks.add(e.taskGid); });
  const valOf = (r, c) => { const x = cell.get(r + '|' + c); if (!x) return 0; return spec.metric === 'time' ? x.minutes : x.tasks.size; };
  const disp = (v) => v === 0 ? '·' : (spec.metric === 'time' ? fmtDuration(v) : v);
  let max = 0; rowAgg.forEach((r) => colAgg.forEach((c) => { max = Math.max(max, valOf(r.key, c.key)); }));
  const head = `<thead><tr><th class="corner">${esc(cap(rowDim))} \\ ${esc(cap(colDim))}</th>${colAgg.map((c) => `<th title="${esc(c.name)}">${esc(trunc(c.name, 15))}</th>`).join('')}</tr></thead>`;
  const body = '<tbody>' + rowAgg.map((r) => `<tr><th>${esc(r.name)}</th>${colAgg.map((c) => { const v = valOf(r.key, c.key); const a = max ? v / max : 0; const bg = v ? ` style="background:color-mix(in srgb, var(--accent) ${Math.round(a * 55)}%, transparent)"` : ''; return `<td class="${v ? '' : 'cell-0'}"${bg}>${disp(v)}</td>`; }).join('')}</tr>`).join('') + '</tbody>';
  return `<div class="matrix-wrap"><table class="matrix">${head}${body}</table></div>`;
}
const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;

/* ─── Views / theme / chrome ───────────────────────────────── */
function switchView(name) { $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === name)); $('#view-dashboard').hidden = name !== 'dashboard'; $('#view-custom').hidden = name !== 'custom'; }
function applyTheme() { document.documentElement.setAttribute('data-theme', settings.theme); document.documentElement.style.setProperty('--accent', settings.accent); const p = $('#accent-picker'); if (p) p.value = settings.accent; }

function wireChrome() {
  $$('.nav-item').forEach((n) => n.addEventListener('click', () => switchView(n.dataset.view)));
  $('#workspace-select').addEventListener('change', (e) => selectWorkspace(e.target.value).catch((err) => banner(err.message, 'error')));
  $('#refresh-btn').addEventListener('click', async () => {
    const ws = state.workspaceGid;
    state.cache = { projectTasks: {}, taskEntries: {} };
    await idbDeletePrefix(`t3:${ws}:`); await idbDeletePrefix(`t2:${ws}:`); await idbDeletePrefix(`e:${ws}:`);
    if (state.report) runReport();
    else { banner('Cache cleared for this workspace — next Generate will re-scrape.', 'info'); setTimeout(() => banner(''), 2200); }
  });
  $('#logout-btn').addEventListener('click', async () => { await fetch('/api/logout', { method: 'POST' }); window.location.href = '/login.html'; });
  // Theme/accent change the chart colors, which are read at draw time — so
  // invalidate the panel cache to force a redraw (not just a show/hide).
  $('#theme-btn').addEventListener('click', () => { settings.theme = settings.theme === 'dark' ? 'light' : 'dark'; applyTheme(); saveSettings(); if (state.report) { state.panel = null; updatePanels(); } });
  $('#accent-picker').addEventListener('input', (e) => { settings.accent = e.target.value; applyTheme(); saveSettings(); if (state.report) { state.panel = null; updatePanels(); } });
  $('#accent-btn').addEventListener('click', (e) => { if (e.target.tagName !== 'INPUT') $('#accent-picker').click(); });

  const toggleMenu = (sel) => { ['#proj-menu', '#emp-menu'].forEach((s) => { if (s !== sel) $(s).hidden = true; }); const m = $(sel); m.hidden = !m.hidden; };
  $('#proj-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu('#proj-menu'); });
  $('#emp-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu('#emp-menu'); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.proj-filter')) { $('#proj-menu').hidden = true; $('#emp-menu').hidden = true; } });
  $('#run-btn').addEventListener('click', runReport);

  // Department (portfolio) → limits the projects shown in the picker.
  $('#portfolio-select').addEventListener('change', async (e) => {
    state.selectedPortfolio = e.target.value;
    state.selectedProjects = new Set(); // reset project picks when the department changes
    if (e.target.value !== 'all' && !state.portfolioItems[e.target.value]) {
      $('#proj-btn').textContent = 'Loading department…';
      await getPortfolioProjects(e.target.value).catch(() => {});
    }
    buildProjectMenu();
  });

  // Date controls act as live filters once a report exists.
  $('#date-basis').addEventListener('change', () => { if (state.report) updatePanels(); });
  $('#date-range').addEventListener('change', (e) => { $('#custom-range').hidden = e.target.value !== 'custom'; if (state.report && e.target.value !== 'custom') updatePanels(); });
  $('#range-from').addEventListener('change', () => { if (state.report) updatePanels(); });
  $('#range-to').addEventListener('change', () => { if (state.report) updatePanels(); });

  $('#chat-send').addEventListener('click', runCustom);
  $('#chat-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runCustom(); });
  aiExamples();
}

boot();
