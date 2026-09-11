# Asana Dash

A detailed, customizable **Asana dashboard** with **Groq AI insights**.
Plain HTML/CSS/JS frontend + a tiny Node proxy that keeps your API keys secret and behind a login.

## Features

- 🔐 **Login-gated** — session-based auth; keys live only on the server.
- 🗂 **Workspace & project switcher** with live data from the Asana API.
- 📊 **Overview** — KPIs (total, complete %, overdue, due-soon, unassigned), status doughnut, due-soon list.
- ☑ **Tasks** — searchable/sortable table, filters (status, assignee), grouping (section / assignee / due), **toggleable columns including your custom fields**, links back to Asana.
- 👥 **Workload** — incomplete tasks per assignee, overload highlighting.
- 📈 **Analytics** — charts by assignee, completion, 30-day due timeline, by section.
- ✦ **AI Insights (Groq)** — model list is **fetched live from your Groq account** (checks what's available first). One-click presets (exec summary, risks, priorities, standup, overload, weekly report) or free-form questions over the loaded task data.
- 🎨 **Customization** — dark/light theme, accent color, compact density, show/hide sections, auto-refresh — all saved in your browser.

## Setup

1. **Install [Node.js](https://nodejs.org/) 18 or newer.**

2. **Install dependencies** (in this folder):
   ```
   npm install
   ```

3. **Create your `.env`** — copy the example and fill it in:
   ```
   copy .env.example .env      (Windows)
   cp .env.example .env         (macOS/Linux)
   ```
   Set:
   - `ADMIN_USER` / `ADMIN_PASS` — the login you'll use.
   - `SESSION_SECRET` — any long random string.
   - `ASANA_TOKEN` — Personal Access Token from https://app.asana.com/0/my-apps
   - `GROQ_API_KEY` — from https://console.groq.com/keys

4. **Run it:**
   ```
   npm start
   ```
   Open **http://localhost:3000**, log in, and you're set.

## Deploy to Railway

Railway auto-detects the Node app (via `railway.json` / Nixpacks) and runs `npm start`.

1. **Create the project.** Either:
   - **CLI (no Git needed):**
     ```
     npm i -g @railway/cli
     railway login
     railway init          # create a new project
     railway up            # build & deploy this folder
     ```
   - **or GitHub:** push this folder to a repo, then in Railway → *New Project → Deploy from GitHub repo*.

2. **Set the environment variables** (Railway → your service → *Variables*):
   | Variable | Value |
   |---|---|
   | `ADMIN_USER` | your login username |
   | `ADMIN_PASS` | a strong password |
   | `SESSION_SECRET` | a long random string (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) |
   | `ASANA_TOKEN` | your Asana Personal Access Token |
   | `GROQ_API_KEY` | your Groq API key |
   | `SECURE_COOKIE` | `true` |

   **Do not set `PORT`** — Railway injects it automatically.

3. **Add a persistent volume for the cache (important).** Railway → your service →
   *Settings → Volumes → New Volume*, mount it at **`/data`**. Then add one more
   variable:

   | Variable | Value |
   |---|---|
   | `ASANA_CACHE_DIR` | `/data/asana-cache` |

   This is what makes the server's data cache **survive redeploys**, so every
   device — including a brand-new browser or incognito window — loads instantly.
   Without a volume the cache still works, but each redeploy wipes it and the
   server has to warm up again (a new browser will see a live fetch until it does).

4. **Generate a domain** (Railway → *Settings → Networking → Generate Domain*), open it, and log in.

> The session store is in-memory, so a redeploy logs you out (just log back in). That's fine for single-user use.

### How the cache works (instant loads on any device)

The heavy data lives in a **server-side cache on disk**, shared by every device —
so you never depend on a particular browser's local storage. You don't fetch
anything manually; it fills in automatically:

- **On first open** — the first time anyone opens a project, the browser does that
  one live fetch and the **server stores the project on disk** in the background.
  Every later open of that project — on any device, including incognito — is
  instant, served straight from the server cache.
- **Nightly at 12:00 AM IST** — a `node-cron` job re-pulls only what **changed**
  since the last run for cached projects, **back-fills every project that isn't
  cached yet** (so even never-opened projects become instant), and drops projects
  nobody has opened in 90 days so the cache stays bounded.

All scraping is behind a **global rate limiter** that self-tunes to your Asana
plan, so the nightly full back-fill never trips Asana's rate limits (it just takes
a while the first time, then stays fast via incremental updates). The ⟳ **Refresh**
button still forces an immediate re-scrape of the current scope any time.

> **First warm-up after a deploy takes a while.** With a large workspace the very
> first full back-fill is tens of thousands of Asana calls (throttled), so give it
> time to complete in the background. With the volume above, it only has to do that
> once — after that the cache persists and nightly updates are incremental.

## How the keys stay safe

The browser never sees your Asana or Groq keys. It only calls this app's own
endpoints (`/api/asana/*`, `/api/groq/*`), which run **behind the login** and
attach the secret tokens server-side before forwarding to Asana/Groq.

## Notes

- The Asana proxy is a generic passthrough, so you can extend the frontend to
  hit any Asana REST endpoint without touching the server.
- Groq's model lineup changes over time; the AI dropdown always reflects what
  your key can actually use.
- Single-user login by design. For team accounts you'd swap the `.env`
  credentials check for a user store — ask if you want that.
