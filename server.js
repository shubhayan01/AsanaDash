/**
 * Asana Dash — minimal backend.
 *
 * Responsibilities (and nothing more):
 *   1. Serve the static HTML/CSS/JS frontend.
 *   2. Handle login / logout with a signed session cookie.
 *   3. Securely proxy requests to Asana and Groq so the API keys
 *      never reach the browser.
 *
 * Everything the dashboard shows is fetched by the browser through
 * these proxy endpoints, which inject the secret tokens server-side.
 */

require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const cron = require('node-cron');
const { createSnapshot } = require('./snapshot');

const app = express();

// Railway (and most PaaS) terminate HTTPS at an edge proxy and forward
// plain HTTP to the app. Trusting the proxy lets Express see the original
// protocol so `secure` session cookies are actually sent.
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const ASANA_TOKEN = process.env.ASANA_TOKEN || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
// Developer login: a separate, privileged account that can pre-fetch and save
// all Asana data to the server cache so ordinary users open reports instantly.
const DEV_USER = process.env.DEV_USER || '';
const DEV_PASS = process.env.DEV_PASS || '';
// Only fetch/store Asana data touched on/after this date (default: Jan 2026 →
// now). Keeps the cache small and recent instead of the full years-deep history.
const FETCH_SINCE = process.env.FETCH_SINCE || '2026-01-01';

const ASANA_BASE = 'https://app.asana.com/api/1.0';
const GROQ_BASE = 'https://api.groq.com/openai/v1';

app.use(express.json({ limit: '2mb' }));

app.use(
  session({
    name: 'asana_dash.sid',
    secret: process.env.SESSION_SECRET || 'dev-insecure-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: String(process.env.SECURE_COOKIE).toLowerCase() === 'true',
      maxAge: 1000 * 60 * 60 * 12, // 12 hours
    },
  })
);

/* ─── Daily-expiring server cache ───────────────────────────────
 * A lightweight in-memory cache in front of the Asana proxy. Successful
 * GET responses are memoised so repeat loads (and different browsers /
 * sessions) don't re-hit Asana. The whole cache is wiped once a day at
 * 12:00 AM IST — the previous day's data is dropped ("delete older
 * memory to store new") so it never grows without bound and every day
 * starts from fresh Asana data. Memory-only: it also resets on redeploy,
 * which is fine for a cache.
 */
const asanaCache = new Map(); // url → { status, contentType, body }
const MAX_CACHE_ENTRIES = 800;

// Current "cache day" as a YYYY-MM-DD string in India Standard Time.
// The day rolls over at 00:00 IST, which is when the cron purge fires.
function istCacheDay() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}
let cacheDay = istCacheDay();

function purgeCache(reason) {
  const n = asanaCache.size;
  asanaCache.clear();
  cacheDay = istCacheDay();
  console.log(`  🧹 Cache purged (${n} entries) — ${reason}. Cache day is now ${cacheDay}.`);
}

// Safety net in case the process was asleep when the cron should have run:
// any request after the IST date changes triggers a purge too.
function ensureFreshDay() {
  if (istCacheDay() !== cacheDay) {
    purgeCache('day rollover');
    snapshot.refreshAll(); // background re-scrape in case the process slept through the cron
  }
}

/* ─── Pre-loaded snapshot (the "auto-fetch so mornings are instant" engine) ──
 * The snapshot engine scrapes every workspace server-side — on startup and
 * every night at 12:00 AM IST — and serves it pre-assembled so the browser
 * opens reports with zero Asana round-trips. Nightly runs are incremental
 * (only tasks changed since the last run), so we fetch just the last day's
 * data and never re-download what we already have.
 */
const snapshot = createSnapshot({ token: ASANA_TOKEN, since: FETCH_SINCE });

// Every night at 12:00 AM IST: drop the thin URL-passthrough cache AND refresh
// the pre-loaded snapshot, so the morning starts from fresh Asana data.
cron.schedule('0 0 * * *', () => {
  purgeCache('daily 12:00 AM IST refresh');
  snapshot.refreshAll();
}, { timezone: 'Asia/Kolkata' });

/* ─── Helpers ───────────────────────────────────────────────── */

// Timing-safe string comparison so login can't be brute-forced by timing.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  // Mark OUR auth failures distinctly so the frontend can tell a real
  // "session expired" apart from an upstream (Asana/Groq) 401. Without
  // this, a rejected Asana token would look like a logout and bounce
  // the user to the login page → redirect loop.
  return res.status(401).set('X-Auth-Required', '1').json({ error: 'Not authenticated' });
}

// Only the developer account may trigger a full pre-fetch. A logged-in
// non-dev gets a plain 403 (no X-Auth-Required header) so the frontend
// doesn't mistake it for a logout and bounce to the login page.
function requireDev(req, res, next) {
  if (req.session && req.session.user && req.session.role === 'dev') return next();
  if (req.session && req.session.user) return res.status(403).json({ error: 'Developer access required' });
  return res.status(401).set('X-Auth-Required', '1').json({ error: 'Not authenticated' });
}

// Forward a request to an upstream API, injecting the auth header.
// When `cacheKey` is given, a successful GET is served from / stored in
// the daily-expiring server cache.
async function proxy(res, url, { method = 'GET', token, body, cacheKey } = {}) {
  if (cacheKey) {
    const hit = asanaCache.get(cacheKey);
    if (hit) {
      res.status(hit.status).set('Content-Type', hit.contentType).set('X-Cache', 'HIT').send(hit.body);
      return;
    }
  }
  try {
    const headers = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const upstream = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await upstream.text();
    const contentType = upstream.headers.get('content-type') || 'application/json';

    // Only cache clean GET reads. Errors are never cached.
    if (cacheKey && method === 'GET' && upstream.status === 200) {
      if (asanaCache.size >= MAX_CACHE_ENTRIES) {
        asanaCache.delete(asanaCache.keys().next().value); // evict oldest
      }
      asanaCache.set(cacheKey, { status: upstream.status, contentType, body: text });
    }

    res.status(upstream.status).set('Content-Type', contentType);
    if (cacheKey) res.set('X-Cache', 'MISS');
    res.send(text);
  } catch (err) {
    res.status(502).json({ error: 'Upstream request failed', detail: String(err) });
  }
}

/* ─── Auth routes ───────────────────────────────────────────── */

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = username || '', p = password || '';

  // Developer account first (privileged: can pre-fetch & save all data).
  if (DEV_PASS.length > 0 && safeEqual(u, DEV_USER) && safeEqual(p, DEV_PASS)) {
    req.session.user = DEV_USER;
    req.session.role = 'dev';
    return res.json({ ok: true, user: DEV_USER, role: 'dev' });
  }
  // Regular dashboard user.
  if (ADMIN_PASS.length > 0 && safeEqual(u, ADMIN_USER) && safeEqual(p, ADMIN_PASS)) {
    req.session.user = ADMIN_USER;
    req.session.role = 'user';
    return res.json({ ok: true, user: ADMIN_USER, role: 'user' });
  }
  return res.status(401).json({ error: 'Invalid username or password' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Lets the frontend know whether we're logged in + config health.
app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    authenticated: !!(req.session && req.session.user),
    user: req.session ? req.session.user : null,
    role: req.session ? (req.session.role || 'user') : null,
    config: {
      asana: ASANA_TOKEN.length > 0,
      groq: GROQ_API_KEY.length > 0,
      fetchSince: FETCH_SINCE, // client mirrors this floor on its live-fetch fallback
    },
  });
});

/* ─── Asana proxy ───────────────────────────────────────────────
 * Generic, auth-gated passthrough to the Asana REST API. The browser
 * calls e.g. GET /api/asana/workspaces?opt_fields=name and we forward
 * it to https://app.asana.com/api/1.0/workspaces with the token.
 * A generic proxy (rather than one endpoint per resource) is what
 * makes the "in depth, fully customizable" data access possible.
 */
app.all('/api/asana/*', requireAuth, (req, res) => {
  if (!ASANA_TOKEN) return res.status(500).json({ error: 'ASANA_TOKEN not configured in .env' });

  ensureFreshDay(); // purge if the IST day rolled over while we were idle

  const subPath = req.params[0]; // everything after /api/asana/
  const qs = req.originalUrl.includes('?') ? '?' + req.originalUrl.split('?')[1] : '';
  const url = `${ASANA_BASE}/${subPath}${qs}`;

  const method = req.method;
  const body = ['POST', 'PUT', 'PATCH'].includes(method) ? req.body : undefined;

  // Cache read-only GETs (keyed by the exact URL); mutations bypass the cache.
  const cacheKey = method === 'GET' ? url : undefined;

  proxy(res, url, { method, token: ASANA_TOKEN, body, cacheKey });
});

// Lets the frontend detect the daily rollover and drop its own (IndexedDB)
// cache so both layers refresh together at 12:00 AM IST.
app.get('/api/cache-day', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ day: istCacheDay() });
});

// Per-scope cache: the browser sends the workspace + the project gids it's about
// to report on, and gets back just those projects' tasks + time entries from the
// server cache (fetching any not cached yet, throttled). `missing` lists projects
// we couldn't serve, which the browser then live-fetches itself. Small payload,
// instant for anything already cached.
app.post('/api/cached-scope', requireAuth, async (req, res) => {
  if (!ASANA_TOKEN) return res.status(500).json({ error: 'ASANA_TOKEN not configured in .env' });
  const ws = (req.body && req.body.workspace) || '';
  const gids = (req.body && Array.isArray(req.body.projects)) ? req.body.projects.slice(0, 400) : [];
  if (!ws || !gids.length) return res.status(400).json({ error: 'workspace and projects[] required' });
  res.set('Cache-Control', 'no-store');
  try { res.json(await snapshot.ensureScope(ws, gids)); }
  catch (e) { res.status(502).json({ error: 'scope fetch failed', detail: String(e) }); }
});

// Lightweight cache health (how many projects are warm vs known).
app.get('/api/cache-status', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await snapshot.status(req.query.workspace));
});

// Developer-only: fetch EVERY project's tasks + time entries and SAVE them to
// the server cache, so afterwards any user opens any report with zero waiting.
// Fire-and-forget — it runs in the background; the dev page polls
// /api/cache-status to watch progress. Safe to click again; it no-ops while a
// run is already in flight.
app.post('/api/prefetch', requireDev, (req, res) => {
  if (!ASANA_TOKEN) return res.status(500).json({ error: 'ASANA_TOKEN not configured in .env' });
  res.set('Cache-Control', 'no-store');
  if (snapshot.isBuilding()) return res.json({ started: false, building: true });
  snapshot.refreshAll(); // runs in the background
  res.json({ started: true, building: true });
});

// Developer-only: DELETE all cached data (the old, pre-floor history) and then
// re-download it fresh, floored to FETCH_SINCE. This is how the earlier data on
// the server (e.g. Railway's cache volume) is wiped and replaced without shell
// access. Rebuild runs in the background; the dev page polls /api/cache-status.
app.post('/api/purge-cache', requireDev, async (req, res) => {
  if (!ASANA_TOKEN) return res.status(500).json({ error: 'ASANA_TOKEN not configured in .env' });
  res.set('Cache-Control', 'no-store');
  try {
    await snapshot.purgeAll();  // delete the disk-backed per-project cache
    purgeCache('developer purge & rebuild'); // also drop the URL passthrough cache
    snapshot.refreshAll();      // re-download from scratch, floored to FETCH_SINCE
    res.json({ purged: true, building: true });
  } catch (e) {
    res.status(502).json({ error: 'purge failed', detail: String(e) });
  }
});

/* ─── Groq proxy ────────────────────────────────────────────── */

// List the models actually available to this API key ("check first").
app.get('/api/groq/models', requireAuth, (req, res) => {
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not configured in .env' });
  proxy(res, `${GROQ_BASE}/models`, { token: GROQ_API_KEY });
});

// Chat completion — the AI "betterment" engine.
app.post('/api/groq/chat', requireAuth, (req, res) => {
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not configured in .env' });
  proxy(res, `${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    token: GROQ_API_KEY,
    body: req.body,
  });
});

/* ─── Static frontend ───────────────────────────────────────── */

app.use(express.static(path.join(__dirname, 'public')));

// Send unauthenticated users hitting the root to the login page is
// handled client-side; here we just default to the dashboard shell.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  Asana Dash running →  http://localhost:${PORT}`);
  console.log(`  🗓  Cache day ${cacheDay} — auto-refreshes daily at 12:00 AM IST.`);
  // Warm the pre-loaded snapshot in the background so it's ready soon after boot
  // (e.g. after a redeploy). Does not block the server from accepting requests;
  // the frontend falls back to live fetch until this finishes.
  if (ASANA_TOKEN) { console.log('  📸 Warming snapshot in the background…\n'); snapshot.refreshAll(); }
  else console.log('');
  if (!ASANA_TOKEN || !GROQ_API_KEY || !ADMIN_PASS) {
    console.log('  ⚠  Missing config. Copy .env.example to .env and fill in:');
    if (!ADMIN_PASS) console.log('     - ADMIN_PASS');
    if (!ASANA_TOKEN) console.log('     - ASANA_TOKEN');
    if (!GROQ_API_KEY) console.log('     - GROQ_API_KEY');
    console.log('');
  }
});
