/* ═══════════════════════════════════════════════════════════
   Browser Agent — in-app proxy browser + notification hub
   Handles: cookie jar, URL rewriting, gzip, account detection,
   Gmail/Reddit/Twitter polling, AI notification injection
   No npm deps — pure Node built-ins
   ═══════════════════════════════════════════════════════════ */

const http  = require('http');
const https = require('https');
const zlib  = require('zlib');
const path  = require('path');
const fs    = require('fs');
const { URL } = require('url');

const BASE_PATH         = path.join(__dirname, '..');
const COOKIE_JAR_FILE   = path.join(BASE_PATH, 'browser-cookies.json');
const ACCOUNTS_FILE     = path.join(BASE_PATH, 'browser-accounts.json');
const NOTIFS_FILE       = path.join(BASE_PATH, 'browser-notifications.json');
const POLL_MS           = 2 * 60 * 1000;
const MAX_BODY          = 5 * 1024 * 1024;
const MAX_REDIRECTS     = 5;
const PROXY_PATH        = '/api/browser/proxy';
const UA                = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Nitter instances for Twitter polling
const NITTER = ['nitter.privacydev.net','nitter.poast.org','nitter.1d4.us'];

// Private IP ranges to block (SSRF protection)
const PRIVATE_RE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|localhost)/;

// ── Persistent data ──────────────────────────────────────────
let cookieJar   = {};   // { 'google.com': { SSID: { value, expires, path, ... }, ... }, ... }
let accounts    = {};   // { 'google.com': { service, displayName, username, loggedIn, unreadCount, ... } }
let notifCache  = {};   // { gmail: { fetchedAt, unreadCount, items[] }, reddit: {...}, twitter: {...} }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return fallback; }
}
function writeJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch {}
}

cookieJar  = readJson(COOKIE_JAR_FILE, {});
accounts   = readJson(ACCOUNTS_FILE,   {});
notifCache = readJson(NOTIFS_FILE,      {});

// ── Domain helpers ───────────────────────────────────────────
function rootDomain(hostname) {
  if (!hostname) return '';
  const h = hostname.replace(/^www\./, '').toLowerCase();
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  // Handle two-part TLDs like co.uk, com.au
  const twoPartTLDs = new Set(['co.uk','com.au','co.nz','co.jp','co.in','com.br','com.cn']);
  const last2 = parts.slice(-2).join('.');
  if (twoPartTLDs.has(last2) && parts.length > 2) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

// ── Cookie jar helpers ───────────────────────────────────────
function buildCookieHeader(url) {
  try {
    const rd = rootDomain(new URL(url).hostname);
    const jar = cookieJar[rd];
    if (!jar) return '';
    const now = Math.floor(Date.now() / 1000);
    return Object.values(jar)
      .filter(c => !c.expires || c.expires > now)
      .map(c => `${c.name}=${c.value}`)
      .join('; ');
  } catch { return ''; }
}

function mergeCookies(url, setCookieHeaders) {
  if (!setCookieHeaders) return;
  const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  try {
    const rd = rootDomain(new URL(url).hostname);
    if (!cookieJar[rd]) cookieJar[rd] = {};

    for (const raw of list) {
      const parts = raw.split(';').map(s => s.trim());
      const [nameVal] = parts;
      const eq = nameVal.indexOf('=');
      if (eq < 1) continue;
      const name  = nameVal.slice(0, eq).trim();
      const value = nameVal.slice(eq + 1).trim();

      let expires = 0;
      let cookiePath = '/';
      for (const attr of parts.slice(1)) {
        const al = attr.toLowerCase();
        if (al.startsWith('max-age=')) {
          const age = parseInt(al.slice(8));
          expires = age <= 0 ? -1 : Math.floor(Date.now() / 1000) + age;
        } else if (al.startsWith('expires=')) {
          try { expires = Math.floor(new Date(attr.slice(8)).getTime() / 1000); } catch {}
        } else if (al.startsWith('path=')) {
          cookiePath = attr.slice(5).trim() || '/';
        }
      }

      if (expires === -1) {
        delete cookieJar[rd][name];
      } else {
        cookieJar[rd][name] = { name, value, expires, path: cookiePath };
      }
    }
    writeJson(COOKIE_JAR_FILE, cookieJar);
  } catch {}
}

function hasCookiesFor(url) {
  try {
    const rd = rootDomain(new URL(url).hostname);
    const jar = cookieJar[rd];
    return jar && Object.keys(jar).length > 3; // >3 cookies = likely logged in
  } catch { return false; }
}

// ── Fetch with cookie jar + redirect following ───────────────
function proxyFetch(targetUrl, opts = {}, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > MAX_REDIRECTS) return reject(new Error('Too many redirects'));

    let parsed;
    try { parsed = new URL(targetUrl); }
    catch { return reject(new Error('Invalid URL')); }

    // SSRF protection
    if (PRIVATE_RE.test(parsed.hostname)) return reject(new Error('Private address blocked'));

    const isHttps = parsed.protocol === 'https:';
    const method  = (opts.method || 'GET').toUpperCase();
    const bodyStr = opts.body || null;

    const reqHeaders = {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': parsed.origin + '/',
      ...opts.headers,
    };

    const cookieH = buildCookieHeader(targetUrl);
    if (cookieH) reqHeaders['Cookie'] = cookieH;
    if (bodyStr) {
      reqHeaders['Content-Type'] = opts.contentType || 'application/x-www-form-urlencoded';
      reqHeaders['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: reqHeaders,
    };

    const clientLib = isHttps ? https : http;
    const req = clientLib.request(reqOpts, (res) => {
      // Capture cookies
      mergeCookies(targetUrl, res.headers['set-cookie']);

      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = new URL(res.headers.location, targetUrl).href;
        res.resume();
        return proxyFetch(next, opts, depth + 1).then(resolve).catch(reject);
      }

      const contentType    = (res.headers['content-type'] || '').toLowerCase();
      const contentEncoding = (res.headers['content-encoding'] || '').toLowerCase();
      const isHtmlOrCss    = contentType.includes('text/html') || contentType.includes('text/css');
      const isText         = isHtmlOrCss || contentType.includes('text/') || contentType.includes('json') || contentType.includes('xml');

      // Strip frame-blocking headers and build sanitized headers
      const safeHeaders = {};
      for (const [k, v] of Object.entries(res.headers)) {
        const kl = k.toLowerCase();
        if (['x-frame-options','content-security-policy','strict-transport-security'].includes(kl)) continue;
        safeHeaders[k] = v;
      }

      // For non-text: pipe directly (no buffering)
      if (!isText) {
        resolve({ status: res.statusCode, headers: safeHeaders, body: null, stream: res, finalUrl: targetUrl, contentType });
        return;
      }

      // Decompress if needed
      let stream;
      if (contentEncoding === 'gzip') {
        stream = res.pipe(zlib.createGunzip());
      } else if (contentEncoding === 'br') {
        stream = res.pipe(zlib.createBrotliDecompress());
      } else if (contentEncoding === 'deflate') {
        stream = res.pipe(zlib.createInflate());
      } else {
        stream = res;
      }

      let body = '';
      let size = 0;
      stream.on('data', chunk => {
        size += chunk.length;
        if (size <= MAX_BODY) body += chunk.toString('utf-8');
      });
      stream.on('end', () => resolve({ status: res.statusCode, headers: safeHeaders, body, stream: null, finalUrl: targetUrl, contentType }));
      stream.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timed out')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── HTML rewriting ───────────────────────────────────────────
const NAV_SCRIPT = `
<script>
(function(){
  function notify(type,url){
    try{ window.parent.postMessage({type:type,url:url},'*'); }catch(e){}
  }
  window.addEventListener('load',function(){
    notify('browser-pageload', location.href);
  });
  var _push=history.pushState, _rep=history.replaceState;
  history.pushState=function(s,t,u){ _push.call(this,s,t,u); if(u) notify('browser-nav',u); };
  history.replaceState=function(s,t,u){ _rep.call(this,s,t,u); if(u) notify('browser-nav',u); };
  window.addEventListener('popstate',function(){ notify('browser-nav',location.href); });
})();
</script>`;

function rewriteHtml(html, baseUrl) {
  // Extract <base href> if present
  const baseM = html.match(/<base[^>]+href=["']([^"']+)["']/i);
  const effectiveBase = baseM ? new URL(baseM[1], baseUrl).href : baseUrl;

  function toProxy(href) {
    if (!href) return href;
    const h = href.trim();
    if (!h || /^(javascript:|data:|mailto:|tel:|#|blob:)/i.test(h)) return h;
    if (h.startsWith(PROXY_PATH)) return h;
    try {
      const abs = new URL(h, effectiveBase).href;
      if (!abs.startsWith('http')) return h;
      return `${PROXY_PATH}?url=${encodeURIComponent(abs)}`;
    } catch { return h; }
  }

  return html
    // Strip X-Frame-Options meta
    .replace(/<meta[^>]+http-equiv=["']?x-frame-options["']?[^>]*>/gi, '')
    // Strip frame-blocking CSP meta
    .replace(/<meta[^>]+content=["'][^"']*frame-ancestors[^"']*["'][^>]*>/gi, '')
    // Rewrite href (a, link, area)
    .replace(/(<(?:a|link|area)[^>]+\s)href=(["'])([^"']*)\2/gi,
      (m, pre, q, v) => pre + `href=${q}${toProxy(v)}${q}`)
    // Rewrite src (img, script, iframe, source, input[src])
    .replace(/(<(?:img|script|iframe|source|input|audio|video|track)[^>]+\s)src=(["'])([^"']*)\2/gi,
      (m, pre, q, v) => pre + `src=${q}${toProxy(v)}${q}`)
    // Rewrite srcset
    .replace(/\bsrcset=(["'])([^"']*)\1/gi, (m, q, v) => {
      const rewritten = v.split(',').map(entry => {
        const [url, ...rest] = entry.trim().split(/\s+/);
        return [toProxy(url), ...rest].join(' ');
      }).join(', ');
      return `srcset=${q}${rewritten}${q}`;
    })
    // Rewrite form action
    .replace(/(<form[^>]+\s)action=(["'])([^"']*)\2/gi,
      (m, pre, q, v) => pre + `action=${q}${toProxy(v)}${q}`)
    // Inject nav script before </body>
    .replace(/<\/body>/i, NAV_SCRIPT + '</body>');
}

// ── Account detection ────────────────────────────────────────
async function detectGmailLogin() {
  try {
    const r = await proxyFetch('https://mail.google.com/mail/feed/atom');
    if (r.status !== 200 || !r.body || !r.body.includes('<feed')) return null;
    const emailM = r.body.match(/<email>([\s\S]*?)<\/email>/i);
    const countM = r.body.match(/<fullcount>(\d+)<\/fullcount>/i);
    return {
      service: 'gmail',
      username: emailM ? emailM[1].trim() : null,
      loggedIn: true,
      unreadCount: countM ? parseInt(countM[1]) : 0,
    };
  } catch { return null; }
}

async function detectRedditLogin() {
  try {
    const r = await proxyFetch('https://www.reddit.com/api/v1/me.json', {
      headers: { 'Accept': 'application/json', 'User-Agent': 'MyAI-NotificationBot/1.0' }
    });
    if (r.status !== 200 || !r.body) return null;
    const data = JSON.parse(r.body);
    if (!data.name || data.error) return null;
    return { service: 'reddit', username: data.name, loggedIn: true, unreadCount: data.inbox_count || 0 };
  } catch { return null; }
}

async function detectLoginForDomain(domain) {
  const SERVICE_MAP = {
    'google.com': detectGmailLogin,
    'reddit.com': detectRedditLogin,
  };
  const checker = SERVICE_MAP[domain];
  if (checker) return checker();
  return { service: 'custom', username: null, loggedIn: true, unreadCount: 0 };
}

// ── Notification pollers ─────────────────────────────────────
async function pollGmail() {
  try {
    const r = await proxyFetch('https://mail.google.com/mail/feed/atom');
    if (r.status !== 200 || !r.body || !r.body.includes('<entry')) return null;
    const countM = r.body.match(/<fullcount>(\d+)<\/fullcount>/i);
    const entries = r.body.match(/<entry[\s\S]*?<\/entry>/gi) || [];
    const items = entries.slice(0, 10).map(e => {
      const get = (tag) => e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1]?.replace(/<[^>]+>/g,'').trim() || '';
      return {
        id:      get('id'),
        title:   get('title'),
        sender:  get('name') || get('email'),
        snippet: get('summary').slice(0, 200),
        date:    get('issued') || get('modified'),
      };
    });
    return { fetchedAt: new Date().toISOString(), unreadCount: countM ? parseInt(countM[1]) : items.length, items };
  } catch { return null; }
}

async function pollReddit() {
  try {
    const r = await proxyFetch('https://www.reddit.com/message/unread.json', {
      headers: { 'Accept': 'application/json', 'User-Agent': 'MyAI-NotificationBot/1.0' }
    });
    if (r.status !== 200 || !r.body) return null;
    const data = JSON.parse(r.body);
    const children = data?.data?.children || [];
    const items = children.slice(0, 10).map(c => ({
      id:      c.data.id,
      from:    c.data.author,
      subject: c.data.subject || c.data.link_title || 'Reddit message',
      body:    (c.data.body || '').slice(0, 200),
      date:    c.data.created_utc ? new Date(c.data.created_utc * 1000).toISOString() : '',
    }));
    return { fetchedAt: new Date().toISOString(), unreadCount: items.length, items };
  } catch { return null; }
}

async function pollTwitter(username) {
  for (const instance of NITTER) {
    try {
      const r = await proxyFetch(`https://${instance}/${username}`);
      if (r.status !== 200 || !r.body) continue;
      const blocks = r.body.split(/class="timeline-item/).slice(1, 11);
      const items = blocks.map(block => {
        const textM = block.match(/class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/);
        const text = textM ? textM[1].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim() : '';
        const dateM = block.match(/title="([^"]*\d{4}[^"]*)"[^>]*>[\s\S]{0,5}(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d)/);
        const rtM   = block.match(/([\d,]+)\s*(?:Retweet|retweet)/);
        const likeM = block.match(/([\d,]+)\s*(?:Like|like)/);
        return { text, date: dateM?.[1] || '', retweets: rtM?.[1] || '0', likes: likeM?.[1] || '0' };
      }).filter(t => t.text.length > 3);
      if (items.length === 0) continue;
      return { fetchedAt: new Date().toISOString(), username, items };
    } catch {}
  }
  return null;
}

async function runNotificationPoll() {
  const tasks = [];

  for (const [domain, account] of Object.entries(accounts)) {
    if (!account.loggedIn) continue;
    if (domain === 'google.com' && account.service === 'gmail') {
      tasks.push(pollGmail().then(r => r && (notifCache.gmail = r)));
    }
    if (domain === 'reddit.com') {
      tasks.push(pollReddit().then(r => r && (notifCache.reddit = r)));
    }
    if ((domain === 'twitter.com' || domain === 'x.com') && account.username) {
      tasks.push(pollTwitter(account.username).then(r => r && (notifCache.twitter = r)));
    }
  }

  if (tasks.length === 0) return;
  await Promise.allSettled(tasks);

  // Update unread counts in accounts
  if (notifCache.gmail)   { const a = accounts['google.com'];  if (a) a.unreadCount = notifCache.gmail.unreadCount; }
  if (notifCache.reddit)  { const a = accounts['reddit.com'];  if (a) a.unreadCount = notifCache.reddit.unreadCount; }

  writeJson(NOTIFS_FILE,  notifCache);
  writeJson(ACCOUNTS_FILE, accounts);
}

// ── AI notification summary (synchronous — no I/O) ──────────
function buildNotificationSummary() {
  const parts = [];
  const now = new Date();
  function ago(iso) {
    if (!iso) return '';
    try {
      const diff = Math.floor((now - new Date(iso)) / 60000);
      if (diff < 1) return 'just now';
      if (diff < 60) return `${diff}m ago`;
      if (diff < 1440) return `${Math.floor(diff/60)}h ago`;
      return `${Math.floor(diff/1440)}d ago`;
    } catch { return ''; }
  }

  if (notifCache.gmail && notifCache.gmail.unreadCount > 0) {
    const g = notifCache.gmail;
    const latest = g.items[0];
    let line = `Gmail: ${g.unreadCount} unread email${g.unreadCount !== 1 ? 's' : ''}.`;
    if (latest) line += ` Latest: "${latest.title}" from ${latest.sender}${latest.date ? ' (' + ago(latest.date) + ')' : ''}.`;
    parts.push(line);
  }

  if (notifCache.reddit && notifCache.reddit.unreadCount > 0) {
    const r = notifCache.reddit;
    const latest = r.items[0];
    let line = `Reddit: ${r.unreadCount} unread message${r.unreadCount !== 1 ? 's' : ''}.`;
    if (latest) line += ` Latest from u/${latest.from}: "${latest.subject}"${latest.date ? ' (' + ago(latest.date) + ')' : ''}.`;
    parts.push(line);
  }

  if (notifCache.twitter && notifCache.twitter.items && notifCache.twitter.items.length > 0) {
    const t = notifCache.twitter;
    const latest = t.items[0];
    parts.push(`Twitter (@${t.username}): ${t.items.length} recent tweet${t.items.length !== 1 ? 's' : ''}. Latest${latest.date ? ' (' + ago(latest.date) + ')' : ''}: "${latest.text.slice(0, 100)}..."`);
  }

  if (parts.length === 0) return '';
  return `[Notifications — checked ${ago(notifCache.gmail?.fetchedAt || notifCache.reddit?.fetchedAt || '')}]\n` + parts.join('\n');
}

// ── Mount Express routes ─────────────────────────────────────
function mountBrowserAgentRoutes(app) {

  // ── Main proxy endpoint ──
  app.get(PROXY_PATH, async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send('Missing url parameter');

    let targetUrl;
    try {
      targetUrl = decodeURIComponent(url);
      new URL(targetUrl); // validate
    } catch { return res.status(400).send('Invalid URL'); }

    try {
      const result = await proxyFetch(targetUrl);

      // Check if this is a new domain acquiring cookies (trigger account detection)
      const rd = rootDomain(new URL(targetUrl).hostname);
      if (!accounts[rd] && hasCookiesFor(targetUrl)) {
        const detected = await detectLoginForDomain(rd);
        if (detected) {
          accounts[rd] = {
            domain: rd,
            ...detected,
            displayName: detected.username || rd,
            detectedAt: new Date().toISOString(),
            lastChecked: new Date().toISOString(),
          };
          writeJson(ACCOUNTS_FILE, accounts);
          res.setHeader('X-Browser-New-Account', rd);
        }
      }

      // Strip blocking headers
      const blockedHeaders = new Set(['x-frame-options','content-security-policy',
        'strict-transport-security','set-cookie']);
      for (const [k, v] of Object.entries(result.headers)) {
        if (!blockedHeaders.has(k.toLowerCase())) res.setHeader(k, v);
      }
      res.setHeader('X-Proxied-Final-Url', result.finalUrl);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(result.status || 200);

      // Pipe binary, rewrite text
      if (result.stream) {
        result.stream.pipe(res);
      } else if (result.body !== null) {
        const ct = result.contentType || '';
        if (ct.includes('text/html')) {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.send(rewriteHtml(result.body, result.finalUrl));
        } else {
          res.send(result.body);
        }
      } else {
        res.end();
      }

    } catch (err) {
      res.status(502).send(`
        <html><body style="font:14px/1.6 sans-serif;padding:24px;color:#ccc;background:#1e1e1e">
        <h3 style="color:#e57373">Could not load page</h3>
        <p>${err.message}</p>
        <p><a href="javascript:history.back()" style="color:#7cb4f7">← Go back</a></p>
        </body></html>`);
    }
  });

  // POST proxy (form submissions)
  app.post(PROXY_PATH, express.urlencoded({ extended: true }), async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send('Missing url');
    const body = new URLSearchParams(req.body).toString();
    try {
      const result = await proxyFetch(decodeURIComponent(url), { method: 'POST', body });
      const rd = rootDomain(new URL(decodeURIComponent(url)).hostname);
      if (!accounts[rd] && hasCookiesFor(decodeURIComponent(url))) {
        const detected = await detectLoginForDomain(rd);
        if (detected) {
          accounts[rd] = { domain: rd, ...detected, displayName: detected.username || rd,
            detectedAt: new Date().toISOString(), lastChecked: new Date().toISOString() };
          writeJson(ACCOUNTS_FILE, accounts);
          res.setHeader('X-Browser-New-Account', rd);
        }
      }
      const blocked = new Set(['x-frame-options','content-security-policy','strict-transport-security','set-cookie']);
      for (const [k, v] of Object.entries(result.headers)) {
        if (!blocked.has(k.toLowerCase())) res.setHeader(k, v);
      }
      res.setHeader('X-Proxied-Final-Url', result.finalUrl);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(result.status || 200);
      if (result.stream) result.stream.pipe(res);
      else if (result.body) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(rewriteHtml(result.body, result.finalUrl));
      } else res.end();
    } catch (err) { res.status(502).send(err.message); }
  });

  // List accounts
  app.get('/api/browser/accounts', (req, res) => {
    res.json(Object.values(accounts));
  });

  // Create or update account (set display name)
  app.post('/api/browser/accounts', express.json(), (req, res) => {
    const { domain, displayName, username, service } = req.body;
    if (!domain) return res.status(400).json({ error: 'Missing domain' });
    const rd = rootDomain(domain);
    if (!accounts[rd]) accounts[rd] = { domain: rd, service: service || 'custom', loggedIn: true, unreadCount: 0 };
    if (displayName) accounts[rd].displayName = displayName;
    if (username)    accounts[rd].username    = username;
    accounts[rd].updatedAt = new Date().toISOString();
    writeJson(ACCOUNTS_FILE, accounts);
    res.json(accounts[rd]);
  });

  // Delete account + cookies
  app.delete('/api/browser/accounts/:domain', (req, res) => {
    const rd = rootDomain(req.params.domain);
    delete accounts[rd];
    delete cookieJar[rd];
    writeJson(ACCOUNTS_FILE, accounts);
    writeJson(COOKIE_JAR_FILE, cookieJar);
    res.json({ ok: true });
  });

  // Get notifications
  app.get('/api/browser/notifications', (req, res) => {
    res.json(notifCache);
  });

  // Force notification poll
  app.post('/api/browser/notifications/poll', async (req, res) => {
    await runNotificationPoll();
    res.json(notifCache);
  });

  // Cookie info (names only for safety)
  app.get('/api/browser/cookies', (req, res) => {
    const safe = {};
    for (const [domain, jar] of Object.entries(cookieJar)) {
      safe[domain] = Object.keys(jar);
    }
    res.json(safe);
  });

  // Clear cookies for a domain
  app.delete('/api/browser/cookies/:domain', (req, res) => {
    const rd = rootDomain(req.params.domain);
    delete cookieJar[rd];
    if (accounts[rd]) accounts[rd].loggedIn = false;
    writeJson(COOKIE_JAR_FILE, cookieJar);
    writeJson(ACCOUNTS_FILE, accounts);
    res.json({ ok: true });
  });

  // Start background poller
  setInterval(runNotificationPoll, POLL_MS);
  // Initial poll after 10 seconds (give server time to start)
  setTimeout(runNotificationPoll, 10000);
}

// Need express for the POST proxy middleware
let express;
try { express = require('express'); } catch { express = { json: () => (r,s,n) => n(), urlencoded: () => (r,s,n) => n() }; }

module.exports = {
  mount: mountBrowserAgentRoutes,
  getNotificationSummary: buildNotificationSummary,
};
