/**
 * Asana Dash — server-side cache engine.
 *
 * Why this exists: the browser used to scrape Asana live on every report, so
 * the first open of any scope waited through dozens–hundreds of Asana calls.
 * This workspace is large (hundreds of projects, 100k+ tasks, 50k+ timed
 * tasks), so two things are true:
 *   1. We cannot hand the whole workspace to the browser — it would be 100+ MB.
 *   2. A full precise scrape is tens of thousands of calls and WILL get rate-
 *      limited unless every request is throttled.
 *
 * So the server keeps the heavy data and serves it PER SCOPE:
 *   • `ensureScope(ws, gids)` makes sure the requested projects' tasks + time
 *     entries are cached (fetching any that aren't, rate-limited), and returns
 *     just those — small and instant for the browser.
 *   • `refreshAll()` runs on a schedule (12:00 AM IST): it re-pulls only what
 *     CHANGED since the last run (Asana `modified_since`) for every project
 *     already in the cache, and back-fills a few not-yet-cached projects each
 *     run so coverage grows toward "everything" over time — all behind a global
 *     rate limiter so Asana never throttles us.
 *   • Projects nobody has opened in a while are pruned so memory stays bounded.
 *
 * Everything degrades gracefully: if a scope isn't cached yet, the caller is
 * told, and the browser falls back to its normal live fetch for that scope.
 */

'use strict';

const ASANA_BASE = 'https://app.asana.com/api/1.0';
const DAY = 86400000;

// Fields the browser needs per task. Kept in sync with TASK_FIELDS in
// public/js/dashboard.js. `memberships` is requested to resolve the section /
// project, then stripped from the stored task to save memory.
const TASK_FIELDS = [
  'name', 'completed', 'completed_at', 'created_at', 'due_on', 'due_at',
  'assignee.name', 'assignee.gid', 'permalink_url', 'actual_time_minutes',
  'memberships.section.name', 'memberships.project.gid',
  'custom_fields.name', 'custom_fields.gid', 'custom_fields.display_value',
  'custom_fields.number_value', 'custom_fields.text_value',
  'custom_fields.people_value.name', 'custom_fields.type',
].join(',');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// YYYY-MM-DD in India Standard Time — the "cache day" the nightly job aligns to.
function istCacheDay() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

function createSnapshot(opts = {}) {
  const token = opts.token || '';
  // Tunables (env-overridable) — conservative defaults that stay well under
  // Asana's rate limits and keep memory bounded.
  const CONCURRENCY = +opts.concurrency || 6;
  const PRUNE_DAYS = +opts.pruneDays || 60;        // drop projects nobody opened in this long
  const BACKFILL_PER_RUN = +opts.backfillPerRun || 25; // projects to back-fill each nightly run

  // ── Per-project cache ───────────────────────────────────────
  // key `${ws}:${projectGid}` → { ws, gid, name, tasks:[...], entries:{taskGid:[...]},
  //                               builtAt, lastAccess }
  const projCache = new Map();
  // Per-workspace lists (cheap) + the set of project gids we know exist.
  const wsMeta = new Map(); // ws → { projects:[{gid,name}], allGids:[...], scanned:bool }
  let meGid = null;
  let building = false;
  let lastError = null;
  let lastRunAt = null;
  const key = (ws, gid) => `${ws}:${gid}`;

  /* ── Global adaptive rate limiter ──────────────────────────────
   * Serializes request START times to at least `gap` ms apart, so no matter
   * how many workers run, the overall request rate stays controlled. On a 429
   * we widen the gap (slow down); on sustained success we narrow it (speed up).
   * This self-tunes to whatever Asana tier the token is on. */
  let gap = 80;                 // ms between request starts (~12.5 req/s)
  const MIN_GAP = 60, MAX_GAP = 2000;
  let nextAt = 0;
  async function gate() {
    const now = Date.now();
    const wait = Math.max(0, nextAt - now);
    nextAt = Math.max(now, nextAt) + gap;
    if (wait) await sleep(wait);
  }
  function sawRateLimit() { gap = Math.min(MAX_GAP, Math.round(gap * 1.5)); }
  function sawSuccess() { if (gap > MIN_GAP) gap = Math.max(MIN_GAP, gap - 2); }

  /* ── Asana access (throttled, retry on 429 / 5xx) ──────────── */
  async function asanaGet(pathQ) {
    const url = `${ASANA_BASE}/${pathQ}`;
    for (let attempt = 0; ; attempt++) {
      await gate();
      let res;
      try {
        res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      } catch (e) {
        if (attempt < 3) { await sleep(700); continue; }
        throw e;
      }
      if (res.status === 429) {
        sawRateLimit();
        const retryAfter = +res.headers.get('retry-after') || 0;
        if (attempt < 8) { await sleep(retryAfter ? retryAfter * 1000 : 1200 * (attempt + 1)); continue; }
      }
      if (res.status >= 500 && attempt < 3) { await sleep(700); continue; }
      const text = await res.text();
      let json; try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
      if (!res.ok) {
        const msg = (json.errors && json.errors[0] && json.errors[0].message) || `HTTP ${res.status}`;
        const err = new Error(msg); err.status = res.status; throw err;
      }
      sawSuccess();
      return json;
    }
  }
  async function asanaAll(path, query) {
    let out = [], offset = null;
    do {
      const q = query + (offset ? `&offset=${encodeURIComponent(offset)}` : '');
      const res = await asanaGet(`${path}?${q}`);
      out = out.concat(res.data || []);
      offset = res.next_page ? res.next_page.offset : null;
    } while (offset);
    return out;
  }
  async function mapPool(items, size, fn) {
    let i = 0;
    const worker = async () => { while (i < items.length) { const idx = i++; await fn(items[idx], idx); } };
    await Promise.all(Array.from({ length: Math.min(size, items.length || 1) }, worker));
  }

  /* ── Workspace project list (cheap; refreshed lazily) ──────── */
  async function ensureWsMeta(ws, force) {
    let m = wsMeta.get(ws);
    if (m && m.scanned && !force) return m;
    const projects = (await asanaAll(`workspaces/${ws}/projects`, 'opt_fields=name,archived&limit=100').catch(() => []))
      .filter((p) => !p.archived).map((p) => ({ gid: p.gid, name: p.name }));
    m = { projects, allGids: projects.map((p) => p.gid), scanned: true };
    wsMeta.set(ws, m);
    return m;
  }
  function projNameOf(ws, gid) {
    const m = wsMeta.get(ws);
    const p = m && m.projects.find((x) => x.gid === gid);
    return p ? p.name : gid;
  }

  /* ── Fetch one project's tasks (+ entries for timed tasks) ─── */
  // `since` (ISO) → incremental merge; null → full (within nothing; all tasks).
  async function buildProject(ws, gid, since) {
    const name = projNameOf(ws, gid);
    const q = `opt_fields=${TASK_FIELDS}&limit=100` + (since ? `&modified_since=${encodeURIComponent(since)}` : '');
    let tasks;
    try { tasks = await asanaAll(`projects/${gid}/tasks`, q); } catch { tasks = []; }
    tasks.forEach((t) => {
      const m = (t.memberships || []).find((mm) => mm.project && mm.project.gid === gid) || (t.memberships || [])[0];
      t._section = (m && m.section && m.section.name) || 'No section';
      t._projectGid = gid;
      t._projectName = name;
      delete t.memberships;
    });

    const rec = projCache.get(key(ws, gid)) || { ws, gid, name, tasks: [], entries: {}, builtAt: null, lastAccess: Date.now() };
    rec.name = name;
    if (since) {
      const map = new Map(rec.tasks.map((t) => [t.gid, t]));
      tasks.forEach((t) => map.set(t.gid, t));
      rec.tasks = [...map.values()];
    } else {
      rec.tasks = tasks;
    }

    // Time entries only for the tasks we just pulled that have logged time.
    const timed = tasks.filter((t) => (t.actual_time_minutes || 0) > 0);
    await mapPool(timed, CONCURRENCY, async (t) => {
      try {
        const res = await asanaGet(`tasks/${t.gid}/time_tracking_entries?opt_fields=duration_minutes,entered_on,created_by.name`);
        rec.entries[t.gid] = res.data || [];
      } catch { /* keep any prior entries */ }
    });
    // Drop entries for tasks no longer present (keeps memory tidy / no dupes).
    const live = new Set(rec.tasks.map((t) => t.gid));
    for (const tg of Object.keys(rec.entries)) if (!live.has(tg)) delete rec.entries[tg];

    rec.builtAt = new Date().toISOString();
    projCache.set(key(ws, gid), rec);
    return rec;
  }

  /* ── Public: return the ALREADY-cached part of a scope immediately ──
   * Returns { ready, building, builtAt, tasks:[...], entries:{...}, have:[gids],
   * missing:[gids] } right away — it NEVER blocks fetching from Asana. Projects
   * not cached yet come back in `missing` (the browser live-fetches those, with
   * its own progress + instant estimate) and are warmed in the BACKGROUND so the
   * next open is instant. This keeps the request fast no matter how many
   * projects (or a whole person's worth) were selected. */
  function ensureScope(ws, gids) {
    if (!token) return { ready: false, tasks: [], entries: {}, have: [], missing: gids };
    const tasks = [], entries = {}, have = [], missing = [];
    gids.forEach((g) => {
      const rec = projCache.get(key(ws, g));
      if (rec && rec.builtAt) {
        rec.lastAccess = Date.now();
        rec.tasks.forEach((t) => tasks.push(t));
        Object.assign(entries, rec.entries);
        have.push(g);
      } else {
        missing.push(g);
      }
    });
    if (missing.length) warmInBackground(ws, missing); // grow coverage without blocking
    return { ready: have.length > 0, building, builtAt: newestBuiltAt(ws, have), tasks, entries, have, missing, day: istCacheDay() };
  }

  /* ── Background warmer ─────────────────────────────────────────
   * Projects that were requested but not cached get fetched one at a time in the
   * background (sharing the global rate limiter), so they're instant next time.
   * "Pre-load everything over time", driven by what people actually open. */
  const warmQueue = new Set(); // `${ws}:${gid}` pending
  const inFlight = new Set();
  let warming = false;
  function warmInBackground(ws, gids) {
    gids.forEach((g) => { const k = key(ws, g); if (!inFlight.has(k) && !projCache.has(k)) warmQueue.add(k); });
    if (!warming) drainWarm();
  }
  async function drainWarm() {
    warming = true;
    try {
      while (warmQueue.size) {
        const k = warmQueue.values().next().value;
        warmQueue.delete(k);
        if (inFlight.has(k) || projCache.has(k)) continue;
        inFlight.add(k);
        const i = k.indexOf(':'), ws = k.slice(0, i), gid = k.slice(i + 1);
        try { await ensureWsMeta(ws).catch(() => {}); await buildProject(ws, gid, null); }
        catch (e) { lastError = String(e); }
        finally { inFlight.delete(k); }
      }
    } finally { warming = false; }
  }

  function newestBuiltAt(ws, gids) {
    let newest = null;
    gids.forEach((g) => { const r = projCache.get(key(ws, g)); if (r && r.builtAt && (!newest || r.builtAt > newest)) newest = r.builtAt; });
    return newest;
  }

  /* ── Nightly refresh: update cached projects + grow coverage ── */
  async function refreshAll() {
    if (building || !token) return;
    building = true; lastError = null;
    const t0 = Date.now();
    try {
      meGid = (await asanaGet('users/me?opt_fields=name').catch(() => null))?.data?.gid || meGid;
      const workspaces = await asanaAll('workspaces', 'opt_fields=name&limit=100').catch(() => []);
      const sinceBase = lastRunAt ? new Date(Date.parse(lastRunAt) - 2 * 3600 * 1000).toISOString() : null;
      const runStart = new Date().toISOString();

      for (const w of workspaces) {
        const ws = w.gid;
        await ensureWsMeta(ws, true).catch(() => {});

        // 1) Prune projects nobody has opened in a while (bound memory).
        const cutoff = Date.now() - PRUNE_DAYS * DAY;
        for (const [k, rec] of projCache) if (rec.ws === ws && rec.lastAccess < cutoff) projCache.delete(k);

        // 2) Incrementally refresh everything still cached for this workspace.
        const cached = [...projCache.values()].filter((r) => r.ws === ws);
        await mapPool(cached, CONCURRENCY, async (rec) => {
          try { await buildProject(ws, rec.gid, sinceBase); } catch (e) { lastError = String(e); }
        });

        // 3) Back-fill a few not-yet-cached projects so coverage grows toward
        //    "everything" over successive nights — without hammering Asana.
        const meta = wsMeta.get(ws);
        const uncached = (meta ? meta.allGids : []).filter((g) => !projCache.has(key(ws, g))).slice(0, BACKFILL_PER_RUN);
        await mapPool(uncached, Math.min(CONCURRENCY, 4), async (g) => {
          try { await buildProject(ws, g, null); } catch (e) { lastError = String(e); }
        });
      }
      lastRunAt = runStart;
      console.log(`  📸 Cache refresh done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${projCache.size} project(s) cached, gap ${gap}ms, day ${istCacheDay()}.`);
    } catch (e) {
      lastError = String(e);
      console.log(`  ⚠  Cache refresh failed: ${lastError}`);
    } finally {
      building = false;
    }
  }

  function status(ws) {
    const recs = [...projCache.values()].filter((r) => !ws || r.ws === ws);
    const meta = ws ? wsMeta.get(ws) : null;
    return {
      cachedProjects: recs.length,
      knownProjects: meta ? meta.allGids.length : null,
      building, lastRunAt, lastError, gapMs: gap, day: istCacheDay(),
    };
  }

  return { ensureScope, refreshAll, status, isBuilding: () => building, lastError: () => lastError, istCacheDay };
}

module.exports = { createSnapshot, istCacheDay };
