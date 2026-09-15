/**
 * Asana Dash — server-side, disk-backed cache engine.
 *
 * Why this exists: reports used to scrape Asana live on every open, so the first
 * open of any scope waited through dozens–hundreds of Asana calls. This
 * workspace is large (hundreds of projects, 100k+ tasks, 50k+ timed tasks), so:
 *   1. We cannot hand the whole workspace to the browser at once (100+ MB).
 *   2. A full precise scrape is tens of thousands of calls and WILL get rate-
 *      limited unless every request is throttled.
 *   3. Holding it all in RAM risks running the server out of memory.
 *
 * So the server caches each project's tasks + time entries AS A FILE ON DISK and
 * serves data PER SCOPE. Because the cache is on the server (not the browser's
 * local storage), ANY device — including a brand-new PC with no local cache —
 * gets the data instantly on click. Because it's on disk, it survives server
 * restarts/redeploys (point DATA_DIR at a persistent volume to keep it across
 * Railway deploys too).
 *
 *   • `ensureScope(ws, gids)` returns the already-cached projects immediately
 *     (reading their files), and warms any not-yet-cached ones in the background.
 *   • `refreshAll()` runs on a schedule (12:00 AM IST): re-pulls only what
 *     CHANGED since the last run (Asana `modified_since`) for cached projects,
 *     and back-fills every not-yet-cached project so coverage reaches
 *     "everything" — all behind a global rate limiter so Asana never throttles.
 *   • Projects nobody has opened in PRUNE_DAYS are deleted so disk stays bounded.
 *
 * Degrades gracefully: if disk is unavailable it falls back to an in-memory map;
 * if a scope isn't cached yet, the browser live-fetches it (with its own
 * progress + instant estimate) while the server warms it for next time.
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const ASANA_BASE = 'https://app.asana.com/api/1.0';
const DAY = 86400000;

// Fields the browser needs per task. Kept in sync with TASK_FIELDS in
// public/js/dashboard.js. `memberships` is requested to resolve the section /
// project, then stripped from the stored task to save space.
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

// Normalise a "fetch since" value (a plain YYYY-MM-DD like "2026-01-01", or a
// full ISO timestamp) into an ISO 8601 string Asana's `modified_since` accepts.
function normSince(v) {
  const d = new Date(v);
  if (isNaN(d)) return new Date('2026-01-01T00:00:00.000Z').toISOString();
  return d.toISOString();
}
// Return the later of two ISO timestamps (either may be null/empty).
function maxSince(a, b) {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function createSnapshot(opts = {}) {
  const token = opts.token || '';
  // Tunables (env-overridable). Defaults stay well under Asana's rate limits.
  const CONCURRENCY = +opts.concurrency || 6;
  const PRUNE_DAYS = +opts.pruneDays || 90;  // delete projects unopened this long
  // .trim() guards against a stray space/newline in the ASANA_CACHE_DIR env var
  // (e.g. pasted with leading whitespace) — otherwise the path isn't absolute and
  // the cache silently lands off the mounted volume, on ephemeral disk.
  const DATA_DIR = (opts.dataDir || process.env.ASANA_CACHE_DIR || path.join(__dirname, '.cache')).trim();
  const PARSE_CACHE_MAX = +opts.parseCacheMax || 120; // hot projects kept parsed in RAM
  // Only fetch tasks touched on/after this date (Asana `modified_since`). Keeps
  // the cache to recent work (default: Jan 2026 onward) instead of the full,
  // years-deep history — far less to download, store, and ship to the browser.
  const SINCE_FLOOR = normSince(opts.since || process.env.FETCH_SINCE || '2026-01-01');
  const SINCE_DATE = SINCE_FLOOR.slice(0, 10); // YYYY-MM-DD, for filtering entered_on

  let meGid = null;
  let building = false;
  let aborted = false;    // set by stop()/purgeAll() to bail out of an in-flight build
  let runGen = 0;         // invalidates a superseded refreshAll so its finally can't fight a new one
  let lastError = null;
  let lastRunAt = null;
  const wsMeta = new Map(); // ws → { projects:[{gid,name}], allGids:[...], scanned }

  // Small parsed-record cache so repeat reads of the same project don't re-parse
  // the file. Auto-invalidated by file mtime; capped so RAM stays bounded.
  const parsed = new Map(); // fileKey → { mtimeMs, rec }

  let diskOk = true;
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { diskOk = false; }
  const memStore = new Map(); // fallback when disk is unavailable: key → rec

  const key = (ws, gid) => `${ws}:${gid}`;
  const fileFor = (ws, gid) => path.join(DATA_DIR, String(ws), String(gid) + '.json');

  /* ── Disk-backed record I/O ────────────────────────────────── */
  async function readRec(ws, gid) {
    const fkey = key(ws, gid);
    if (!diskOk) return memStore.get(fkey) || null;
    const file = fileFor(ws, gid);
    let st;
    try { st = await fsp.stat(file); } catch { return null; }
    const hot = parsed.get(fkey);
    if (hot && hot.mtimeMs === st.mtimeMs) return hot.rec;
    try {
      const rec = JSON.parse(await fsp.readFile(file, 'utf8'));
      parsed.set(fkey, { mtimeMs: st.mtimeMs, rec });
      if (parsed.size > PARSE_CACHE_MAX) parsed.delete(parsed.keys().next().value); // evict oldest
      return rec;
    } catch { return null; }
  }
  async function writeRec(ws, gid, rec) {
    const fkey = key(ws, gid);
    if (!diskOk) { memStore.set(fkey, rec); return; }
    const file = fileFor(ws, gid);
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(rec));
      await fsp.rename(tmp, file); // atomic replace
      try { const st = await fsp.stat(file); parsed.set(fkey, { mtimeMs: st.mtimeMs, rec }); } catch { /* ignore */ }
    } catch (e) { lastError = String(e); }
  }
  async function touch(ws, gid) { // mark "recently accessed" (mtime) so prune spares it
    if (!diskOk) return;
    const now = new Date();
    try { await fsp.utimes(fileFor(ws, gid), now, now); } catch { /* ignore */ }
  }
  async function existsRec(ws, gid) {
    if (!diskOk) return memStore.has(key(ws, gid));
    try { await fsp.stat(fileFor(ws, gid)); return true; } catch { return false; }
  }
  async function listCachedGids(ws) {
    if (!diskOk) return [...memStore.keys()].filter((k) => k.startsWith(ws + ':')).map((k) => k.slice(ws.length + 1));
    try { return (await fsp.readdir(path.join(DATA_DIR, String(ws)))).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); }
    catch { return []; }
  }

  /* ── Global adaptive rate limiter ──────────────────────────────
   * Spaces request START times so overall rate stays controlled regardless of
   * concurrency. Widens the gap on a 429, narrows it on sustained success —
   * self-tuning to whatever Asana tier the token is on. */
  let gap = 80; const MIN_GAP = 60, MAX_GAP = 2000; let nextAt = 0;
  async function gate() {
    const now = Date.now();
    const wait = Math.max(0, nextAt - now);
    nextAt = Math.max(now, nextAt) + gap;
    if (wait) await sleep(wait);
  }

  /* ── Asana access (throttled, retry on 429 / 5xx) ──────────── */
  async function asanaGet(pathQ) {
    const url = `${ASANA_BASE}/${pathQ}`;
    for (let attempt = 0; ; attempt++) {
      await gate();
      let res;
      try { res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }); }
      catch (e) { if (attempt < 3) { await sleep(700); continue; } throw e; }
      if (res.status === 429) {
        gap = Math.min(MAX_GAP, Math.round(gap * 1.5));
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
      if (gap > MIN_GAP) gap = Math.max(MIN_GAP, gap - 2);
      return json;
    }
  }
  async function asanaAll(p, query) {
    let out = [], offset = null;
    do {
      const q = query + (offset ? `&offset=${encodeURIComponent(offset)}` : '');
      const res = await asanaGet(`${p}?${q}`);
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

  /* ── Fetch one project's tasks (+ entries) and persist it ──── */
  async function buildProject(ws, gid, since) {
    const name = projNameOf(ws, gid);
    // Never fetch earlier than the floor: a full fetch (since=null) uses the
    // floor; an incremental fetch uses the later of its base and the floor.
    const eff = maxSince(since, SINCE_FLOOR);
    const q = `opt_fields=${TASK_FIELDS}&limit=100&modified_since=${encodeURIComponent(eff)}`;
    let tasks;
    try { tasks = await asanaAll(`projects/${gid}/tasks`, q); } catch { tasks = []; }
    tasks.forEach((t) => {
      const m = (t.memberships || []).find((mm) => mm.project && mm.project.gid === gid) || (t.memberships || [])[0];
      t._section = (m && m.section && m.section.name) || 'No section';
      t._projectGid = gid; t._projectName = name;
      delete t.memberships;
    });

    const prior = (since ? await readRec(ws, gid) : null) || { ws, gid, name, tasks: [], entries: {} };
    const rec = { ws, gid, name, tasks: prior.tasks || [], entries: prior.entries || {}, builtAt: null };
    if (since) {
      const map = new Map(rec.tasks.map((t) => [t.gid, t]));
      tasks.forEach((t) => map.set(t.gid, t));
      rec.tasks = [...map.values()];
    } else {
      rec.tasks = tasks;
    }

    const timed = tasks.filter((t) => (t.actual_time_minutes || 0) > 0);
    await mapPool(timed, CONCURRENCY, async (t) => {
      if (aborted) return; // stop() / purge asked us to bail
      try {
        const res = await asanaGet(`tasks/${t.gid}/time_tracking_entries?opt_fields=duration_minutes,entered_on,created_by.name`);
        // Keep only time logged on/after the floor date (YYYY-MM-DD compares
        // lexicographically) — smaller payload + "actual time tracked" is the
        // time logged from Jan 2026 onward, not a task's whole history.
        rec.entries[t.gid] = (res.data || []).filter((e) => !e.entered_on || e.entered_on >= SINCE_DATE);
      } catch { /* keep any prior entries */ }
    });
    const live = new Set(rec.tasks.map((t) => t.gid));
    for (const tg of Object.keys(rec.entries)) if (!live.has(tg)) delete rec.entries[tg];

    rec.builtAt = new Date().toISOString();
    await writeRec(ws, gid, rec);
    return rec;
  }

  /* ── Public: return the ALREADY-cached part of a scope ─────────
   * Reads cached projects from disk (fast, local) and returns them right away;
   * never blocks on Asana. Not-yet-cached projects come back in `missing` (the
   * browser live-fetches those) and are warmed in the background for next time.
   * Works for ANY device — the data lives on the server, not the browser. */
  async function ensureScope(ws, gids) {
    if (!token) return { ready: false, tasks: [], entries: {}, have: [], missing: gids };
    const tasks = [], entries = {}, have = [], missing = [];
    let builtAt = null;
    await mapPool(gids, 12, async (g) => {
      const rec = await readRec(ws, g);
      if (rec && rec.builtAt) {
        rec.tasks.forEach((t) => tasks.push(t));
        Object.assign(entries, rec.entries);
        have.push(g);
        if (!builtAt || rec.builtAt > builtAt) builtAt = rec.builtAt;
        touch(ws, g); // fire-and-forget access stamp
      } else {
        missing.push(g);
      }
    });
    if (missing.length) warmInBackground(ws, missing);
    return { ready: have.length > 0, building, builtAt, tasks, entries, have, missing, day: istCacheDay() };
  }

  /* ── Background warmer ─────────────────────────────────────────
   * Requested-but-uncached projects get fetched one at a time in the background
   * (sharing the rate limiter) and persisted, so they're instant next time — on
   * every device. This is what grows coverage toward "everything" from normal
   * use, on top of the nightly back-fill. */
  const warmQueue = new Set();
  const inFlight = new Set();
  let warming = false;
  function warmInBackground(ws, gids) {
    gids.forEach((g) => { const k = key(ws, g); if (!inFlight.has(k)) warmQueue.add(k); });
    if (!warming) drainWarm();
  }
  async function drainWarm() {
    warming = true;
    try {
      while (warmQueue.size) {
        const k = warmQueue.values().next().value; warmQueue.delete(k);
        if (inFlight.has(k)) continue;
        const i = k.indexOf(':'), ws = k.slice(0, i), gid = k.slice(i + 1);
        if (await existsRec(ws, gid)) continue;
        inFlight.add(k);
        try { await ensureWsMeta(ws).catch(() => {}); await buildProject(ws, gid, null); }
        catch (e) { lastError = String(e); }
        finally { inFlight.delete(k); }
      }
    } finally { warming = false; }
  }

  /* ── Nightly refresh: keep cached fresh + complete coverage ──── */
  async function refreshAll() {
    if (building || !token) return;
    building = true; aborted = false; lastError = null;
    const myGen = ++runGen;                       // this run's identity
    const alive = () => !aborted && myGen === runGen; // false once stopped/superseded
    const t0 = Date.now();
    try {
      meGid = (await asanaGet('users/me?opt_fields=name').catch(() => null))?.data?.gid || meGid;
      const workspaces = await asanaAll('workspaces', 'opt_fields=name&limit=100').catch(() => []);
      const sinceBase = lastRunAt ? new Date(Date.parse(lastRunAt) - 2 * 3600 * 1000).toISOString() : null;
      const runStart = new Date().toISOString();

      for (const w of workspaces) {
        if (!alive()) break;
        const ws = w.gid;
        await ensureWsMeta(ws, true).catch(() => {});

        // 1) Prune projects nobody has opened in a while (bound disk).
        if (diskOk) {
          const cutoff = Date.now() - PRUNE_DAYS * DAY;
          for (const gid of await listCachedGids(ws)) {
            try { const st = await fsp.stat(fileFor(ws, gid)); if (st.mtimeMs < cutoff) { await fsp.unlink(fileFor(ws, gid)); parsed.delete(key(ws, gid)); } } catch { /* ignore */ }
          }
        }

        // 2) Incrementally refresh everything already cached for this workspace.
        const cached = await listCachedGids(ws);
        await mapPool(cached, CONCURRENCY, async (gid) => {
          if (!alive()) return;
          try { await buildProject(ws, gid, sinceBase); } catch (e) { lastError = String(e); }
        });

        // 3) Back-fill EVERY not-yet-cached project so coverage becomes complete
        //    (so a fresh device is instant on anything). Throttled by the limiter.
        const meta = wsMeta.get(ws);
        const cachedSet = new Set(cached);
        const uncached = (meta ? meta.allGids : []).filter((g) => !cachedSet.has(String(g)));
        await mapPool(uncached, CONCURRENCY, async (gid) => {
          if (!alive()) return;
          try { await buildProject(ws, gid, null); } catch (e) { lastError = String(e); }
        });
      }
      if (alive()) lastRunAt = runStart;
      console.log(`  📸 Cache refresh ${alive() ? 'done' : 'stopped'} in ${((Date.now() - t0) / 1000).toFixed(1)}s — gap ${gap}ms, day ${istCacheDay()}.`);
    } catch (e) {
      lastError = String(e);
      console.log(`  ⚠  Cache refresh failed: ${lastError}`);
    } finally {
      if (myGen === runGen) building = false; // don't clear a newer run's flag
    }
  }

  // Ask any in-flight build to stop as soon as possible (workers bail before
  // their next task). Used before purge, or to cancel a long prefetch.
  function stop() {
    aborted = true;
    runGen++;              // invalidate the current run
    building = false;      // let a fresh refreshAll start immediately
    warmQueue.clear();     // drop queued background warms too
  }

  /* ── Delete EVERYTHING cached (so the next refresh rebuilds clean) ────
   * Used to drop the old, pre-floor data on demand ("delete the earlier data")
   * so a fresh, floored full fetch replaces it. Stops any in-flight build first
   * (otherwise it would keep writing old data), and resets lastRunAt so the next
   * refreshAll does a full (not incremental) pull. */
  async function purgeAll() {
    stop();                // halt the current prefetch before wiping
    parsed.clear();
    memStore.clear();
    lastRunAt = null;
    wsMeta.clear();
    if (diskOk) {
      try { await fsp.rm(DATA_DIR, { recursive: true, force: true }); } catch (e) { lastError = String(e); }
      try { await fsp.mkdir(DATA_DIR, { recursive: true }); } catch { diskOk = false; }
    }
    return true;
  }

  async function status(ws) {
    let cachedProjects = 0;
    try { cachedProjects = ws ? (await listCachedGids(ws)).length : 0; } catch { /* ignore */ }
    const meta = ws ? wsMeta.get(ws) : null;
    return {
      cachedProjects, knownProjects: meta ? meta.allGids.length : null,
      building, warming, queued: warmQueue.size, lastRunAt, lastError, gapMs: gap,
      diskOk, dataDir: DATA_DIR, day: istCacheDay(), since: SINCE_FLOOR,
    };
  }

  return { ensureScope, refreshAll, purgeAll, stop, status, isBuilding: () => building, lastError: () => lastError, istCacheDay, since: () => SINCE_FLOOR };
}

module.exports = { createSnapshot, istCacheDay };
