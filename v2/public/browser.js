/* ═══════════════════════════════════════════════════════════
   In-App Browser — wraps Electron <webview> for real browsing
   ═══════════════════════════════════════════════════════════ */

let bInitialized = false;

// ── Short name / search resolver ──────────────────────────────
const SHORT_NAMES = {
  x:         'https://x.com',
  twitter:   'https://twitter.com',
  google:    'https://www.google.com',
  gmail:     'https://mail.google.com',
  youtube:   'https://www.youtube.com',
  yt:        'https://www.youtube.com',
  reddit:    'https://www.reddit.com',
  github:    'https://github.com',
  instagram: 'https://www.instagram.com',
  facebook:  'https://www.facebook.com',
  fb:        'https://www.facebook.com',
  tiktok:    'https://www.tiktok.com',
  linkedin:  'https://www.linkedin.com',
  amazon:    'https://www.amazon.com',
  netflix:   'https://www.netflix.com',
  wikipedia: 'https://en.wikipedia.org',
  wiki:      'https://en.wikipedia.org',
  discord:   'https://discord.com',
  twitch:    'https://www.twitch.tv',
  spotify:   'https://open.spotify.com',
  maps:      'https://www.google.com/maps',
};

function normalizeUrl(raw) {
  const input = (raw || '').trim();
  if (!input) return 'https://www.google.com';
  if (/^https?:\/\//i.test(input)) return input;
  if (input.startsWith('//')) return 'https:' + input;
  const lower = input.toLowerCase().replace(/\/$/, '');
  if (SHORT_NAMES[lower]) return SHORT_NAMES[lower];
  if (!input.includes(' ') && /[a-z0-9-]+\.[a-z]{2,}/i.test(input)) return 'https://' + input;
  return 'https://www.google.com/search?q=' + encodeURIComponent(input);
}

// ── Init ──────────────────────────────────────────────────────
function initBrowser() {
  if (bInitialized) return;
  bInitialized = true;

  const wv           = document.getElementById('browser-iframe');   // <webview>
  const addrBar      = document.getElementById('browser-address-bar');
  const backBtn      = document.getElementById('browser-back');
  const fwdBtn       = document.getElementById('browser-forward');
  const reloadBtn    = document.getElementById('browser-reload');
  const homeBtn      = document.getElementById('browser-home');
  const panelToggle  = document.getElementById('browser-panel-toggle');
  const sidePanel    = document.querySelector('.browser-side-panel');
  const loading      = document.getElementById('browser-loading');

  // ── Address bar ──
  addrBar.addEventListener('focus', () => addrBar.select());
  addrBar.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); browserNavigate(addrBar.value.trim()); }
  });
  addrBar.addEventListener('click', () => addrBar.select());

  backBtn.addEventListener('click',   () => wv.canGoBack()    && wv.goBack());
  fwdBtn.addEventListener('click',    () => wv.canGoForward() && wv.goForward());
  reloadBtn.addEventListener('click', () => wv.reload());
  homeBtn.addEventListener('click',   () => browserNavigate('https://www.google.com'));
  panelToggle.addEventListener('click', () => sidePanel.classList.toggle('collapsed'));

  // ── Webview events ──

  // Show/hide spinner + swap reload button to stop
  wv.addEventListener('did-start-loading', () => {
    if (loading) loading.style.display = 'block';
    if (reloadBtn) { reloadBtn.textContent = '✕'; reloadBtn.title = 'Stop'; reloadBtn.onclick = () => wv.stop(); }
  });
  wv.addEventListener('did-stop-loading', () => {
    if (loading) loading.style.display = 'none';
    if (reloadBtn) { reloadBtn.innerHTML = '&#8635;'; reloadBtn.title = 'Reload'; reloadBtn.onclick = () => wv.reload(); }
    updateNavBtns();
  });

  // Update address bar on navigation
  wv.addEventListener('did-navigate', e => {
    if (document.activeElement !== addrBar) addrBar.value = e.url;
    updateNavBtns();
  });
  wv.addEventListener('did-navigate-in-page', e => {
    if (e.isMainFrame && document.activeElement !== addrBar) addrBar.value = e.url;
    updateNavBtns();
  });

  // Handle load failures gracefully
  wv.addEventListener('did-fail-load', e => {
    if (loading) loading.style.display = 'none';
    if (e.errorCode === -3) return; // aborted (user navigated away)
    updateNavBtns();
  });

  // Open new-window requests in the same webview
  wv.addEventListener('new-window', e => {
    browserNavigate(e.url);
  });

  // ── Notifications poll button ──
  document.getElementById('browser-poll-btn')?.addEventListener('click', browserForcePoll);
  document.getElementById('notif-refresh-btn')?.addEventListener('click', browserForcePoll);

  // ── Account dialog ──
  document.getElementById('account-name-form')?.addEventListener('submit', e => {
    e.preventDefault();
    const domain = document.getElementById('account-dialog-domain').value;
    const name   = document.getElementById('account-display-name').value.trim() || domain;
    browserSaveAccount(domain, name).then(closeAccountDialog);
  });
  document.getElementById('account-dialog-close')?.addEventListener('click', closeAccountDialog);
  document.getElementById('account-dialog-skip')?.addEventListener('click',  closeAccountDialog);

  // ── Initial load ──
  updateNavBtns();
  browserRefreshNotifications();
  browserNavigate('https://www.google.com');
}

// ── Navigation ────────────────────────────────────────────────
function browserNavigate(raw) {
  const url = normalizeUrl(raw);
  const wv      = document.getElementById('browser-iframe');
  const addrBar = document.getElementById('browser-address-bar');
  const loading = document.getElementById('browser-loading');
  if (addrBar) addrBar.value = url;
  if (loading) loading.style.display = 'block';
  wv.loadURL(url);
}

function updateNavBtns() {
  const wv  = document.getElementById('browser-iframe');
  const back = document.getElementById('browser-back');
  const fwd  = document.getElementById('browser-forward');
  if (!wv) return;
  if (back) back.disabled = !wv.canGoBack();
  if (fwd)  fwd.disabled  = !wv.canGoForward();
}

// ── Notifications (polling via Express server) ────────────────
let bNotifs = {};

async function browserRefreshNotifications() {
  try {
    const r = await fetch('/api/browser/notifications');
    bNotifs = await r.json();
    renderNotificationsPanel();
  } catch {}
}

async function browserForcePoll() {
  const pollBtn  = document.getElementById('browser-poll-btn');
  const notifBtn = document.getElementById('notif-refresh-btn');
  [pollBtn, notifBtn].forEach(b => { if (b) { b.disabled = true; b.textContent = '…'; } });
  try {
    const r = await fetch('/api/browser/notifications/poll', { method: 'POST' });
    bNotifs = await r.json();
    renderNotificationsPanel();
  } catch {}
  [pollBtn, notifBtn].forEach(b => { if (b) { b.disabled = false; b.textContent = '↻'; } });
}

function renderNotificationsPanel(filterDomain = null) {
  const panel = document.getElementById('notifications-panel');
  if (!panel) return;

  function fmtDate(iso) {
    if (!iso) return '';
    try {
      const diff = Math.floor((Date.now() - new Date(iso)) / 60000);
      if (diff < 1) return 'just now';
      if (diff < 60) return `${diff}m ago`;
      if (diff < 1440) return `${Math.floor(diff / 60)}h ago`;
      return new Date(iso).toLocaleDateString();
    } catch { return ''; }
  }

  const all = [];
  if (bNotifs.gmail?.items && (!filterDomain || filterDomain === 'google.com')) {
    bNotifs.gmail.items.slice(0, 6).forEach(i =>
      all.push({ color: 'gmail-color',   label: 'GMAIL',  title: i.title,   sub: i.sender,     body: i.snippet, date: i.date }));
  }
  if (bNotifs.reddit?.items && (!filterDomain || filterDomain === 'reddit.com')) {
    bNotifs.reddit.items.slice(0, 6).forEach(i =>
      all.push({ color: 'reddit-color',  label: 'REDDIT', title: i.subject, sub: `u/${i.from}`, body: i.body,    date: i.date }));
  }
  if (bNotifs.twitter?.items && (!filterDomain || ['twitter.com', 'x.com'].includes(filterDomain))) {
    bNotifs.twitter.items.slice(0, 6).forEach(i =>
      all.push({ color: 'twitter-color', label: '𝕏',      title: `@${bNotifs.twitter.username}`, sub: '', body: i.text, date: i.date }));
  }

  if (!all.length) {
    panel.innerHTML = '<p class="no-accounts">No notifications yet — sign in to accounts and click ↻</p>';
    return;
  }
  panel.innerHTML = all.map(n => `
    <div class="notif-item">
      <div class="notif-header">
        <span class="notif-source ${n.color}">${n.label}</span>
        <span class="notif-date">${fmtDate(n.date)}</span>
      </div>
      ${n.title ? `<div class="notif-title">${escB(n.title)}</div>` : ''}
      ${n.sub   ? `<div class="notif-sub">${escB(n.sub)}</div>` : ''}
      ${n.body  ? `<div class="notif-snippet">${escB(n.body)}</div>` : ''}
    </div>`).join('');
}

// ── Account save (for side panel) ────────────────────────────
async function browserSaveAccount(domain, displayName) {
  try {
    await fetch('/api/browser/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, displayName }),
    });
  } catch {}
}

function showAccountDialog(domain) {
  const dlg = document.getElementById('account-name-dialog');
  if (!dlg) return;
  document.getElementById('account-dialog-domain').value = domain;
  document.getElementById('account-display-name').value  = domain.split('.')[0];
  dlg.style.display = 'flex';
}
function closeAccountDialog() {
  const dlg = document.getElementById('account-name-dialog');
  if (dlg) dlg.style.display = 'none';
}

// ══════════════════════════════════════════════════════════════
//  Real-browser web search — uses hidden <webview> elements so
//  requests look like genuine Chrome traffic (no bot-blocking)
// ══════════════════════════════════════════════════════════════

// ── Single DDG search webview ──────────────────────────────
let _searchWebview = null;

function getSearchWebview() {
  if (_searchWebview && _searchWebview.isConnected) return _searchWebview;
  const wv = document.createElement('webview');
  wv.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1280px;height:800px;opacity:0;pointer-events:none;z-index:-9999;';
  document.body.appendChild(wv);
  _searchWebview = wv;
  return wv;
}

// ── Parallel scraper pool — 3 independent webviews ─────────
const _scraperPool = [null, null, null];

function getScraperWv(idx) {
  if (_scraperPool[idx]?.isConnected) return _scraperPool[idx];
  const wv = document.createElement('webview');
  wv.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1280px;height:800px;opacity:0;pointer-events:none;z-index:-9999;';
  document.body.appendChild(wv);
  _scraperPool[idx] = wv;
  return wv;
}

function wvNavigate(wv, url, timeoutMs = 12000) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    function onStop() { clearTimeout(timer); wv.removeEventListener('did-stop-loading', onStop); resolve(true); }
    wv.addEventListener('did-stop-loading', onStop);
    wv.src = url;
  });
}

// Search DuckDuckGo Lite (simple HTML, no JS required) and return top result URLs
async function ddgSearch(query, max = 5) {
  console.log(`[WebSearch] ▶ DDG search: "${query}" (max=${max})`);
  const wv = getSearchWebview();
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=us-en`;
  console.log(`[WebSearch]   Navigating hidden webview → ${url}`);
  await wvNavigate(wv, url);
  console.log(`[WebSearch]   DDG page loaded, extracting links…`);

  try {
    const results = await wv.executeJavaScript(`
      (function() {
        const links = [];
        document.querySelectorAll('a.result__a').forEach(a => {
          const href = a.href || '';
          const uddg = href.match(/uddg=([^&]+)/);
          const real = uddg ? decodeURIComponent(uddg[1]) : href;
          if (real && real.startsWith('http') && !real.includes('duckduckgo.com')) {
            links.push({
              url: real,
              title: a.textContent.trim()
            });
          }
        });
        // Also grab snippets
        const snips = Array.from(document.querySelectorAll('.result__snippet')).map(s => s.textContent.trim());
        return links.slice(0, ${max}).map((l, i) => ({ ...l, snippet: snips[i] || '' }));
      })()
    `);
    const arr = Array.isArray(results) ? results : [];
    console.log(`[WebSearch]   DDG found ${arr.length} results:`);
    arr.forEach((r, i) => console.log(`[WebSearch]     ${i+1}. ${r.url}  — "${r.title}"`));
    return arr;
  } catch(e) {
    console.error('[WebSearch]   DDG scrape failed:', e);
    return [];
  }
}

// Visit a URL with the hidden webview and extract OG metadata + screenshot
async function fetchPagePreview(url) {
  console.log(`[WebSearch] ▶ Visiting: ${url}`);
  const wv = getSearchWebview();

  // Expand to full render size so capturePage works properly
  wv.style.width  = '1280px';
  wv.style.height = '800px';
  wv.style.opacity = '0';

  const ok = await wvNavigate(wv, url, 15000);
  if (!ok) {
    console.warn(`[WebSearch]   ✗ Timed out loading: ${url}`);
    wv.style.width = '1px'; wv.style.height = '1px';
    return null;
  }
  console.log(`[WebSearch]   ✓ Page loaded: ${url}`);

  // Let JS and images settle
  await new Promise(r => setTimeout(r, 900));

  let meta = { title: '', description: '', image: '', favicon: '' };
  try {
    meta = await wv.executeJavaScript(`
      (function() {
        const get = sel => document.querySelector(sel)?.content?.trim() || '';
        const title = get('meta[property="og:title"]') || get('meta[name="twitter:title"]') || document.title || '';
        const desc  = get('meta[property="og:description"]') || get('meta[name="description"]') || get('meta[name="twitter:description"]') || '';
        const img   = get('meta[property="og:image"]') || get('meta[name="twitter:image"]') || '';
        const icon  = document.querySelector('link[rel~="icon"]')?.href || '';
        return { title, description: desc.slice(0, 300), image: img, favicon: icon };
      })()
    `);
    console.log(`[WebSearch]   Meta → title: "${meta.title.slice(0,60)}", desc: "${meta.description.slice(0,60)}…", ogImg: ${!!meta.image}, favicon: ${!!meta.favicon}`);
  } catch(e) {
    console.warn('[WebSearch]   Meta extraction failed:', e);
  }

  // Capture real screenshot at 1280×800
  let screenshot = null;
  try {
    const nativeImg = await wv.capturePage();
    const sz = nativeImg.getSize();
    console.log(`[WebSearch]   capturePage → ${sz.width}×${sz.height}`);
    const dataUrl = nativeImg.toDataURL();
    // Scale to 640×400 thumbnail
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 400;
    const ctx = canvas.getContext('2d');
    const img = new Image();
    await new Promise(r => { img.onload = r; img.onerror = r; img.src = dataUrl; });
    ctx.drawImage(img, 0, 0, 640, 400);
    screenshot = canvas.toDataURL('image/jpeg', 0.82);
    console.log(`[WebSearch]   ✓ Screenshot captured (${Math.round(screenshot.length/1024)}KB)`);
  } catch(e) {
    console.warn('[WebSearch]   capturePage failed:', e);
  }

  // Shrink back to hidden size
  wv.style.width = '1px'; wv.style.height = '1px';

  return { url, ...meta, screenshot };
}

/**
 * Full browser-powered web search.
 * Returns up to `max` results with title, description, OG image, screenshot, and URL.
 * Called from app.js when web mode is on.
 */
async function browserSearch(query, max = 3) {
  console.log(`[WebSearch] ═══ browserSearch("${query}", max=${max}) ═══`);
  const searchResults = await ddgSearch(query, max + 2);
  if (!searchResults.length) {
    console.warn('[WebSearch] ✗ No DDG results — cannot build cards');
    return [];
  }

  console.log(`[WebSearch] Processing top ${Math.min(searchResults.length, max)} URLs…`);
  const previews = [];
  for (const r of searchResults.slice(0, max)) {
    const preview = await fetchPagePreview(r.url);
    if (preview) {
      const card = {
        url:         r.url,
        title:       preview.title || r.title,
        description: preview.description || r.snippet,
        image:       preview.image,
        screenshot:  preview.screenshot,
        favicon:     preview.favicon,
        domain:      (() => { try { return new URL(r.url).hostname.replace('www.',''); } catch { return r.url; } })(),
      };
      console.log(`[WebSearch] ✓ Card ready: ${card.domain} — screenshot:${!!card.screenshot} ogImg:${!!card.image}`);
      previews.push(card);
    } else {
      console.warn(`[WebSearch] ✗ Preview failed for: ${r.url}`);
    }
  }
  console.log(`[WebSearch] ═══ Done — ${previews.length} card(s) produced ═══`);
  return previews;
}

// ══════════════════════════════════════════════════════════════
//  FAST PARALLEL SEARCH — DDG + 3 simultaneous page scrapes
//  Returns [{ url, title, text, favicon, domain, snippet }]
// ══════════════════════════════════════════════════════════════

async function scrapePage(url, idx) {
  console.log(`[Scraper${idx}] ▶ ${url}`);
  const wv = getScraperWv(idx);
  const ok = await wvNavigate(wv, url, 12000);
  if (!ok) { console.warn(`[Scraper${idx}] ✗ Timeout: ${url}`); return null; }

  await new Promise(r => setTimeout(r, 700));

  let data = { url, title: '', text: '', favicon: '' };
  try {
    data = await wv.executeJavaScript(`
      (function() {
        const title = document.title || '';
        const favicon = document.querySelector('link[rel~="icon"]')?.href || '';

        // Pull text from tables first (stat sites put data in tables)
        let tableText = '';
        document.querySelectorAll('table').forEach(t => {
          tableText += t.innerText.replace(/[ \\t]+/g,' ').trim() + '\\n\\n';
        });

        // Then main prose content
        const sels = ['article','main','[role="main"]','.post-content','.entry-content','.article-body','#content','.content','body'];
        let el = null;
        for (const s of sels) { const e = document.querySelector(s); if (e && e.innerText.length > 200) { el = e; break; } }
        const prose = (el || document.body).innerText || '';

        // Merge: tables first (rich in numbers), then prose
        const combined = (tableText + '\\n' + prose).replace(/[ \\t]+/g,' ').replace(/\\n{3,}/g,'\\n\\n').trim();
        const text = combined.slice(0, 4000);
        return { url: location.href, title, text, favicon };
      })()
    `);
    console.log(`[Scraper${idx}] ✓ "${data.title.slice(0,50)}" — ${data.text.length} chars`);
  } catch(e) {
    console.warn(`[Scraper${idx}] JS extract failed:`, e.message);
  }

  const domain = (() => { try { return new URL(url).hostname.replace('www.',''); } catch { return url; } })();
  return { ...data, domain };
}

// ── Known statistics / data sites — sorted first in results ──
const STAT_SITES = [
  'statista.com','ourworldindata.org','pewresearch.org','worldbank.org',
  'worldometers.info','macrotrends.net','numbeo.com','gallup.com',
  'gapminder.org','bls.gov','census.gov','data.gov','cdc.gov',
  'who.int','oecd.org','imf.org','un.org','data.un.org',
  'statcdn.com','knoema.com','indexmundi.com','tradingeconomics.com',
  'visualcapitalist.com','hedgethink.com','businessinsider.com',
];

function isStatSite(url) {
  try { const h = new URL(url).hostname; return STAT_SITES.some(s => h.includes(s)); }
  catch { return false; }
}

async function browserSearchFast(query, max = 3) {
  // Append "statistics data" so DDG surfaces stat-heavy pages
  const statsQuery = query.toLowerCase().includes('statistic') ? query : `${query} statistics data`;
  console.log(`[FastSearch] ═══ "${statsQuery}" ═══`);

  // Step 1 — DDG: fetch more results so we can filter for stat sites
  const ddgResults = await ddgSearch(statsQuery, max + 5);
  if (!ddgResults.length) { console.warn('[FastSearch] No DDG results'); return []; }

  // Sort: known stat domains first, then everything else (preserve relative order within each group)
  const statHits  = ddgResults.filter(r => isStatSite(r.url));
  const otherHits = ddgResults.filter(r => !isStatSite(r.url));
  const ranked = [...statHits, ...otherHits];

  const top = ranked.slice(0, max);
  console.log(`[FastSearch] Top ${top.length} (${statHits.length} stat sites):`, top.map(r => r.url));

  // Step 2 — scrape all pages simultaneously (3 separate webviews)
  const pages = await Promise.all(
    top.map((r, i) => scrapePage(r.url, i).then(p => p ? {
      ...p,
      title:   p.title   || r.title,
      snippet: r.snippet || '',
    } : null))
  );

  const results = pages.filter(Boolean);
  console.log(`[FastSearch] ═══ Done — ${results.length} pages ready ═══`);
  return results;
}

// ── Util ──────────────────────────────────────────────────────
function escB(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
