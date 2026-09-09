// Login page logic. Redirects to the dashboard on success.

const form = document.getElementById('login-form');
const errEl = document.getElementById('login-error');
const btn = document.getElementById('login-btn');
const hint = document.getElementById('config-hint');

// If already logged in, skip straight to the dashboard.
fetch('/api/me')
  .then((r) => r.json())
  .then((data) => {
    if (data.authenticated) {
      window.location.href = '/';
      return;
    }
    // Warn if the server is missing its keys, so login isn't a mystery.
    const missing = [];
    if (!data.config.asana) missing.push('Asana token');
    if (!data.config.groq) missing.push('Groq key');
    if (missing.length) {
      hint.hidden = false;
      hint.textContent = `Note: server is missing ${missing.join(' and ')} in .env — the dashboard will load but those features stay disabled until you add them.`;
    }
  })
  .catch(() => {});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errEl.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Signing in…';

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    window.location.href = '/';
  } catch (err) {
    errEl.hidden = false;
    errEl.textContent = err.message;
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});
