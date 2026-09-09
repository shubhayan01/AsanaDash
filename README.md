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

3. **Generate a domain** (Railway → *Settings → Networking → Generate Domain*), open it, and log in.

> The session store is in-memory, so a redeploy logs you out (just log back in). That's fine for single-user use.

### Daily auto-refresh (12:00 AM IST)

The dashboard caches Asana data on two levels so it loads fast and doesn't re-scrape
constantly:

- **Server cache** — successful Asana reads are memoised in the Node process.
- **Browser cache** — processed tasks/time-entries are stored in IndexedDB.

Both are **wiped automatically every day at 12:00 AM India Standard Time**: an
in-process `node-cron` job clears the server cache (dropping the previous day's
data so memory never grows without bound), and the browser drops its IndexedDB
cache the next time you open the app on a new IST day (it checks `/api/cache-day`).
So every day starts from **fresh Asana data**, and old data is discarded to save
space. The ⟳ **Refresh** button still forces an immediate re-scrape any time.

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
