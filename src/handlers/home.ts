// ─────────────────────────────────────────────────────────────────────────────
// microlink — GET / — Home page (served as inline HTML from the worker)
// No build step, no CDN, no external assets. Pure edge HTML.
// ─────────────────────────────────────────────────────────────────────────────

import type { Context } from "hono";
import type { Env } from "../types";

export function handleHome(c: Context<{ Bindings: Env }>): Response {
  const baseUrl = c.env.BASE_URL.replace(/\/$/, "");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>microlink — URL Shortener</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:        #0a0a0f;
      --surface:   #111118;
      --border:    #1e1e2e;
      --accent:    #7c6af7;
      --accent-hi: #9d8fff;
      --text:      #e2e2f0;
      --muted:     #6b6b8a;
      --success:   #4ade80;
      --error:     #f87171;
      --radius:    12px;
    }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }

    /* ── Header ── */
    header {
      text-align: center;
      margin-bottom: 40px;
    }
    .logo {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      font-size: 1.6rem;
      font-weight: 700;
      letter-spacing: -0.5px;
      color: var(--text);
      text-decoration: none;
      margin-bottom: 8px;
    }
    .logo svg { color: var(--accent); }
    header p {
      color: var(--muted);
      font-size: 0.95rem;
    }

    /* ── Card ── */
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 32px;
      width: 100%;
      max-width: 560px;
      box-shadow: 0 0 60px rgba(124, 106, 247, 0.06);
    }

    /* ── Form ── */
    label {
      display: block;
      font-size: 0.8rem;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 6px;
    }

    input[type="url"], input[type="text"], input[type="number"] {
      width: 100%;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      font-size: 0.95rem;
      padding: 11px 14px;
      outline: none;
      transition: border-color 0.15s;
      -webkit-appearance: none;
    }
    input:focus { border-color: var(--accent); }
    input::placeholder { color: var(--muted); }

    .field { margin-bottom: 16px; }

    /* optional fields row */
    .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .optional-label {
      font-size: 0.75rem;
      color: var(--muted);
      margin-left: 4px;
      font-weight: 400;
      text-transform: none;
      letter-spacing: 0;
    }

    /* ── Button ── */
    button[type="submit"] {
      width: 100%;
      margin-top: 8px;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 0.95rem;
      font-weight: 600;
      padding: 13px;
      cursor: pointer;
      transition: background 0.15s, transform 0.1s;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    button[type="submit"]:hover  { background: var(--accent-hi); }
    button[type="submit"]:active { transform: scale(0.98); }
    button[type="submit"]:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
    }

    /* ── Result ── */
    #result { margin-top: 20px; display: none; }

    .result-box {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px 16px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .result-box.success { border-color: rgba(74, 222, 128, 0.3); }
    .result-box.error   { border-color: rgba(248, 113, 113, 0.3); }

    .result-url {
      flex: 1;
      font-size: 0.9rem;
      color: var(--accent-hi);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 500;
    }
    .result-url a { color: inherit; text-decoration: none; }
    .result-url a:hover { text-decoration: underline; }

    .result-error { color: var(--error); font-size: 0.9rem; }

    .copy-btn {
      flex-shrink: 0;
      background: var(--border);
      border: none;
      border-radius: 6px;
      color: var(--text);
      cursor: pointer;
      padding: 6px 10px;
      font-size: 0.78rem;
      font-weight: 500;
      transition: background 0.12s;
    }
    .copy-btn:hover { background: var(--accent); }
    .copy-btn.copied { background: rgba(74,222,128,0.2); color: var(--success); }

    /* expiry chip */
    .expiry {
      font-size: 0.75rem;
      color: var(--muted);
      margin-top: 8px;
      padding-left: 2px;
    }

    /* ── Spinner ── */
    @keyframes spin { to { transform: rotate(360deg); } }
    .spinner {
      width: 16px; height: 16px;
      border: 2px solid rgba(255,255,255,0.3);
      border-top-color: #fff;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }

    /* ── Footer ── */
    footer {
      margin-top: 28px;
      text-align: center;
      color: var(--muted);
      font-size: 0.8rem;
    }
    footer a { color: var(--accent); text-decoration: none; }
    footer a:hover { text-decoration: underline; }
  </style>
</head>
<body>

<header>
  <div class="logo">
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
    </svg>
    microlink
  </div>
  <p>Paste a long URL. Get a short one.</p>
</header>

<div class="card">
  <form id="shorten-form">
    <div class="field">
      <label for="url">Long URL</label>
      <input
        id="url"
        type="url"
        name="url"
        placeholder="https://example.com/very/long/path?query=value"
        required
        autocomplete="off"
        spellcheck="false"
      />
    </div>

    <div class="row">
      <div class="field">
        <label for="alias">
          Custom alias
          <span class="optional-label">optional</span>
        </label>
        <input
          id="alias"
          type="text"
          name="alias"
          placeholder="my-link"
          maxlength="32"
          autocomplete="off"
          spellcheck="false"
        />
      </div>
      <div class="field">
        <label for="ttl">
          Expires in
          <span class="optional-label">days, optional</span>
        </label>
        <input
          id="ttl"
          type="number"
          name="ttl"
          placeholder="365"
          min="1"
          max="3650"
        />
      </div>
    </div>

    <button type="submit" id="submit-btn">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M5 12h14M12 5l7 7-7 7"/>
      </svg>
      Shorten URL
    </button>
  </form>

  <div id="result"></div>
</div>

<footer>
  Open source &mdash;
  <a href="https://github.com/ankushkamble93/microlink" target="_blank" rel="noopener">GitHub</a>
</footer>

<script>
  const BASE = '${baseUrl}';
  const form = document.getElementById('shorten-form');
  const btn  = document.getElementById('submit-btn');
  const resultEl = document.getElementById('result');

  function showResult(html) {
    resultEl.style.display = 'block';
    resultEl.innerHTML = html;
  }

  function setLoading(on) {
    btn.disabled = on;
    btn.innerHTML = on
      ? '<div class="spinner"></div> Shortening…'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg> Shorten URL';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    resultEl.style.display = 'none';

    const url   = document.getElementById('url').value.trim();
    const alias = document.getElementById('alias').value.trim();
    const ttl   = document.getElementById('ttl').value.trim();

    const body = { url };
    if (alias) body.custom_alias = alias;
    if (ttl)   body.expires_in_days = parseInt(ttl, 10);

    setLoading(true);

    try {
      const res  = await fetch(BASE + '/api/shorten', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (!res.ok) {
        showResult(\`<div class="result-box error">
          <span class="result-error">⚠ \${data.error || 'Something went wrong'}</span>
        </div>\`);
        return;
      }

      const short = data.short_url;
      const expiresAt = data.expires_at
        ? new Date(data.expires_at).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' })
        : null;

      showResult(\`
        <div class="result-box success">
          <span class="result-url">
            <a href="\${short}" target="_blank" rel="noopener">\${short}</a>
          </span>
          <button class="copy-btn" id="copy-btn" onclick="copyUrl('\${short}')">Copy</button>
        </div>
        \${expiresAt ? \`<p class="expiry">Expires \${expiresAt}</p>\` : ''}
      \`);

      // Clear fields except the URL
      document.getElementById('alias').value = '';
      document.getElementById('ttl').value   = '';

    } catch (err) {
      showResult(\`<div class="result-box error">
        <span class="result-error">⚠ Network error — please try again.</span>
      </div>\`);
    } finally {
      setLoading(false);
    }
  });

  function copyUrl(url) {
    navigator.clipboard.writeText(url).then(() => {
      const btn = document.getElementById('copy-btn');
      if (!btn) return;
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = 'Copy';
        btn.classList.remove('copied');
      }, 2000);
    });
  }
</script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      // Allow browser to cache the page for 1 minute — short enough to
      // pick up redeployments quickly without hammering the worker on refresh.
      "Cache-Control": "public, max-age=60",
    },
  });
}
