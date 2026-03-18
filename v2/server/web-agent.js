/* ═══════════════════════════════════════════════════════════
   Web Agent — search, scrape, streaming orchestrator + places
   No npm deps — pure Node built-ins
   ═══════════════════════════════════════════════════════════ */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PLACE_TYPES = ['LocalBusiness','Restaurant','Cafe','Hotel','Store','Food','Bar','Bakery',
  'FastFoodRestaurant','LodgingBusiness','Place','Museum','Park','TouristAttraction',
  'Hospital','Pharmacy','Library','ArtGallery','MovieTheater','ShoppingCenter',
  'FoodEstablishment','Accommodation','SportsActivityLocation','EntertainmentBusiness'];

const PLACE_SITES = ['yelp.com','tripadvisor.com','foursquare.com','zomato.com',
  'opentable.com','happycow.net','booking.com','restaurants.com'];

// Nitter instances (public Twitter mirrors that serve real HTML)
const NITTER_INSTANCES = [
  'nitter.privacydev.net',
  'nitter.poast.org',
  'nitter.1d4.us',
  'nitter.cz',
];

// Twitter/X domains
const TWITTER_HOSTS = new Set(['twitter.com','x.com','www.twitter.com','www.x.com']);

// ── Fetch helper with redirect following ────────────────────
function fetchPage(targetUrl, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 3) return reject(new Error('Too many redirects'));
    let parsedUrl;
    try { parsedUrl = new URL(targetUrl); }
    catch { return reject(new Error('Invalid URL')); }

    const client = parsedUrl.protocol === 'https:' ? https : http;
    const req = client.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = new URL(res.headers.location, targetUrl).href;
        res.resume();
        return fetchPage(next, depth + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      let size = 0;
      const MAX = 600 * 1024;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX) { res.destroy(); return; }
        data += chunk;
      });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── DuckDuckGo HTML search ──────────────────────────────────
async function searchDDG(query, max = 6) {
  const encoded = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${encoded}`;
  const html = await fetchPage(url);

  const results = [];
  const blocks = html.split(/class="result\s/g).slice(1);

  for (const block of blocks) {
    if (results.length >= max) break;
    const hrefMatch = block.match(/class="result__a"[^>]*href="([^"]+)"/);
    if (!hrefMatch) continue;
    let link = hrefMatch[1];
    const uddgMatch = link.match(/uddg=([^&]+)/);
    if (uddgMatch) link = decodeURIComponent(uddgMatch[1]);
    if (link.includes('duckduckgo.com')) continue;

    const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:td|div|span)>/);
    const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
    if (title || snippet) results.push({ url: link, title, snippet });
  }
  return results;
}

// ── Scrape page for text + images ───────────────────────────
async function scrapePage(targetUrl) {
  const html = await fetchPage(targetUrl);

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';

  const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["']/i)
    || html.match(/<meta[^>]*content=["']([\s\S]*?)["'][^>]*name=["']description["']/i);
  const description = descMatch ? descMatch[1].trim() : '';

  const ogImgMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([\s\S]*?)["']/i)
    || html.match(/<meta[^>]*content=["']([\s\S]*?)["'][^>]*property=["']og:image["']/i);
  const ogImage = ogImgMatch ? ogImgMatch[1].trim() : null;

  let clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

  const images = [];
  const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*(?:alt=["']([^"']*)["'])?[^>]*>/gi;
  let imgMatch;
  while ((imgMatch = imgRegex.exec(clean)) !== null && images.length < 20) {
    let src = imgMatch[1];
    const alt = imgMatch[2] || '';
    if (src.includes('data:') || src.includes('1x1') || src.includes('pixel')
      || src.includes('tracking') || src.includes('.svg') || src.length < 10) continue;
    try { src = new URL(src, targetUrl).href; } catch { continue; }
    if (!src.startsWith('http')) continue;
    images.push({ src, alt });
  }

  if (ogImage) {
    try {
      const resolved = new URL(ogImage, targetUrl).href;
      if (!images.some(i => i.src === resolved)) images.unshift({ src: resolved, alt: title });
    } catch {}
  }

  let text = clean
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
  if (text.length > 15000) text = text.substring(0, 15000) + '...';

  return { title, description, content: text, images, url: targetUrl };
}

// ── Nitter: convert Twitter/X URL to Nitter ─────────────────
function toNitterUrl(url, instanceIndex = 0) {
  try {
    const u = new URL(url);
    if (TWITTER_HOSTS.has(u.hostname)) {
      const instance = NITTER_INSTANCES[instanceIndex % NITTER_INSTANCES.length];
      return `https://${instance}${u.pathname}${u.search}`;
    }
  } catch {}
  return null;
}

// Parse tweets from Nitter HTML
function parseNitterHtml(html, sourceUrl) {
  const tweets = [];
  // Split on timeline items
  const blocks = html.split(/class="timeline-item/).slice(1);
  for (const block of blocks.slice(0, 25)) {
    // Extract tweet text
    const contentM = block.match(/class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const text = contentM
      ? contentM[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      : '';
    if (!text || text.length < 3) continue;

    // Date
    const dateM = block.match(/title="([^"]+\d{4}[^"]*)"[^>]*>\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d)/);
    const date = dateM ? dateM[1] : '';

    // Stats
    const rtM = block.match(/([\d,]+)\s*(?:Retweet|retweet|RT)/);
    const likeM = block.match(/([\d,]+)\s*(?:Like|like|Heart|heart)/);

    // Images inside tweet
    const imgMatches = [...block.matchAll(/src="([^"]+\/(?:pic|media|orig)[^"]+)"/g)];
    const images = imgMatches.slice(0, 3).map(m => {
      try { return { src: new URL(m[1], `https://${NITTER_INSTANCES[0]}`).href, alt: '' }; }
      catch { return null; }
    }).filter(Boolean);

    tweets.push({ text, date, retweets: rtM?.[1] || '0', likes: likeM?.[1] || '0', images });
  }
  return tweets;
}

// ── Reddit: scrape via public JSON API ───────────────────────
function parseRedditJson(jsonStr, sourceUrl) {
  try {
    const data = JSON.parse(jsonStr);
    // Handles both /r/sub.json and /r/sub/comments/id.json
    const listing = Array.isArray(data) ? data[0] : data;
    const children = listing?.data?.children || [];
    return children.slice(0, 15).map(c => {
      const d = c.data;
      return {
        title: d.title || '',
        url: d.url || sourceUrl,
        text: (d.selftext || '').slice(0, 400),
        author: d.author || '',
        score: d.score || 0,
        comments: d.num_comments || 0,
        subreddit: d.subreddit || '',
        created: d.created_utc ? new Date(d.created_utc * 1000).toISOString().slice(0, 10) : '',
      };
    }).filter(p => p.title || p.text);
  } catch { return []; }
}

// ── RSS / Atom: parse feed XML ───────────────────────────────
function parseRSSFeed(xml) {
  const items = [];
  const rssBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  const atomBlocks = xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const block of [...rssBlocks, ...atomBlocks].slice(0, 20)) {
    const getVal = (tag) => {
      const m = block.match(new RegExp(
        `<${tag}[^>]*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*<\\/${tag}>`, 'i'
      ));
      return m ? m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    };
    const title = getVal('title');
    const link = block.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] || getVal('link') || '';
    const desc = getVal('description') || getVal('summary') || getVal('content');
    const date = getVal('pubDate') || getVal('published') || getVal('updated');
    if (title || desc) items.push({ title, url: link, snippet: desc.slice(0, 350), date });
  }
  return items;
}

// Find RSS/Atom <link> in page <head>
function findFeedUrl(html, pageUrl) {
  const m = html.match(/<link[^>]+type=["']application\/(rss|atom)\+xml["'][^>]*href=["']([^"']+)["']/i)
           || html.match(/<link[^>]+href=["']([^"']+)["'][^>]*type=["']application\/(rss|atom)\+xml["']/i);
  if (!m) return null;
  const href = (m[2] || m[1] || '').trim();
  if (!href) return null;
  try { return new URL(href, pageUrl).href; } catch { return null; }
}

// ── Smart scraper — picks the best strategy per URL ──────────
async function scrapeSmart(targetUrl) {
  // ── Twitter / X → Nitter ──
  const nitterUrl = toNitterUrl(targetUrl);
  if (nitterUrl) {
    let lastErr;
    for (let i = 0; i < NITTER_INSTANCES.length; i++) {
      const url = toNitterUrl(targetUrl, i);
      try {
        const html = await fetchPage(url);
        const tweets = parseNitterHtml(html, url);
        if (tweets.length === 0) continue;

        const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const allImages = tweets.flatMap(t => t.images);
        const content = tweets
          .map(t => `${t.date ? `[${t.date}] ` : ''}${t.text}  ♥ ${t.likes}  ↺ ${t.retweets}`)
          .join('\n\n');

        return {
          title: titleM ? titleM[1].replace(/\s+/g, ' ').trim() : 'Twitter/X',
          description: `${tweets.length} tweets`,
          content,
          images: allImages.slice(0, 12),
          url: targetUrl,
          source: 'twitter',
          liveItems: tweets,
        };
      } catch (err) { lastErr = err; }
    }
    console.error('All Nitter instances failed:', lastErr?.message);
    // Fall through to plain scrape
  }

  // ── Reddit → .json API ──
  if (/(?:^|\.)reddit\.com/.test(new URL(targetUrl).hostname)) {
    try {
      const jsonUrl = targetUrl.replace(/\/$/, '').replace(/\?.*/, '') + '.json?limit=15';
      const jsonStr = await fetchPage(jsonUrl);
      const posts = parseRedditJson(jsonStr, targetUrl);
      if (posts.length > 0) {
        const content = posts
          .map(p => `**${p.title}**${p.created ? ` (${p.created})` : ''}\n${p.text || p.url}\n↑ ${p.score}  💬 ${p.comments}`)
          .join('\n\n');
        return {
          title: `Reddit — ${posts[0]?.subreddit || ''}`,
          description: `${posts.length} posts`,
          content,
          images: [],
          url: targetUrl,
          source: 'reddit',
          liveItems: posts,
        };
      }
    } catch {}
  }

  // ── Any site: try auto-detecting RSS/Atom feed ──
  try {
    const html = await fetchPage(targetUrl);
    const feedUrl = findFeedUrl(html, targetUrl);
    if (feedUrl) {
      try {
        const feedXml = await fetchPage(feedUrl);
        const feedItems = parseRSSFeed(feedXml);
        if (feedItems.length > 0) {
          const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
          const content = feedItems
            .map(i => `**${i.title}**${i.date ? ` (${i.date})` : ''}\n${i.snippet}`)
            .join('\n\n');
          return {
            title: titleM ? titleM[1].replace(/\s+/g, ' ').trim() : feedUrl,
            description: `${feedItems.length} feed items`,
            content,
            images: [],
            url: targetUrl,
            source: 'rss',
            liveItems: feedItems,
          };
        }
      } catch {}
    }
    // Fall back to standard HTML scrape
    return { ...(await scrapePage(targetUrl)), source: 'html' };
  } catch (err) {
    // Last resort: straight scrape
    return { ...(await scrapePage(targetUrl)), source: 'html' };
  }
}

// ── Extract ld+json structured place data ───────────────────
function extractStructuredData(html, pageUrl) {
  const places = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const raw = JSON.parse(m[1]);
      const items = Array.isArray(raw) ? raw : (raw['@graph'] ? raw['@graph'] : [raw]);
      for (const item of items) {
        if (!item || !item['@type']) continue;
        const type = Array.isArray(item['@type']) ? item['@type'].join(',') : String(item['@type']);
        if (!PLACE_TYPES.some(t => type.includes(t))) continue;
        if (!item.name) continue;

        const lat = item.geo?.latitude ?? item.geo?.lat ?? null;
        const lng = item.geo?.longitude ?? item.geo?.lng ?? null;

        const imgs = [];
        if (item.image) {
          const arr = Array.isArray(item.image) ? item.image : [item.image];
          for (const img of arr.slice(0, 8)) {
            if (typeof img === 'string' && img.startsWith('http')) imgs.push({ src: img, alt: item.name });
            else if (img?.url?.startsWith('http')) imgs.push({ src: img.url, alt: img.name || item.name });
          }
        }

        const reviews = [];
        if (item.review) {
          const revArr = Array.isArray(item.review) ? item.review : [item.review];
          for (const r of revArr.slice(0, 3)) {
            const txt = r.reviewBody || r.description || '';
            if (!txt) continue;
            reviews.push({
              author: r.author?.name || 'Anonymous',
              rating: r.reviewRating?.ratingValue ? parseFloat(r.reviewRating.ratingValue) : null,
              text: txt.slice(0, 300)
            });
          }
        }

        let address = '';
        if (item.address) {
          if (typeof item.address === 'string') {
            address = item.address;
          } else {
            address = [item.address.streetAddress, item.address.addressLocality, item.address.addressRegion]
              .filter(Boolean).join(', ');
          }
        }

        places.push({
          name: item.name,
          type,
          address,
          phone: item.telephone || '',
          website: item.url || pageUrl,
          rating: item.aggregateRating?.ratingValue ? parseFloat(item.aggregateRating.ratingValue) : null,
          ratingCount: item.aggregateRating?.reviewCount ? parseInt(item.aggregateRating.reviewCount) : null,
          lat: lat !== null ? parseFloat(lat) : null,
          lng: lng !== null ? parseFloat(lng) : null,
          images: imgs,
          reviews,
          priceRange: item.priceRange || null,
          url: pageUrl
        });
      }
    } catch {}
  }
  return places;
}

// ── Search for real places via DDG → ld+json scraping ───────
async function searchPlaces(query, location = '', max = 6) {
  const q = location ? `${query} near ${location}` : query;
  let ddgResults;
  try { ddgResults = await searchDDG(q, 14); } catch { return []; }

  // Prioritise review sites that have ld+json
  ddgResults.sort((a, b) => {
    const aP = PLACE_SITES.some(s => a.url.includes(s)) ? 0 : 1;
    const bP = PLACE_SITES.some(s => b.url.includes(s)) ? 0 : 1;
    return aP - bP;
  });

  const places = [];
  const seen = new Set();

  for (const r of ddgResults) {
    if (places.length >= max) break;
    if (seen.has(r.url)) continue;
    seen.add(r.url);

    try {
      const html = await fetchPage(r.url);
      const structured = extractStructuredData(html, r.url);
      for (const place of structured) {
        if (places.some(p => p.name.toLowerCase() === place.name.toLowerCase())) continue;
        places.push(place);
        if (places.length >= max) break;
      }
    } catch { /* skip */ }
  }

  return places;
}

// ── Pass 1: Generate search queries via Ollama ──────────────
async function generateSearchQueries(userQuery, chatHistory, model, ollamaChat) {
  const systemPrompt = `You are a search query generator. Given the user's message and conversation context, generate 1-3 focused web search queries that would find the most relevant and current information. Respond ONLY with a JSON array of strings. If the message is purely conversational and needs no web search, respond with [].

Examples:
- User asks "What's the weather in NYC?" → ["weather NYC today"]
- User asks "Latest Python version" → ["Python latest version 2024", "Python release notes"]
- User says "Hello how are you?" → []`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...chatHistory.slice(-4),
    { role: 'user', content: userQuery }
  ];

  try {
    const result = await ollamaChat(model, messages, { temperature: 0.3, num_ctx: 2048 });
    let text = result.message?.content || '[]';
    text = text.replace(/```json?\s*/gi, '').replace(/```/g, '').trim();
    const arrayMatch = text.match(/\[[\s\S]*?\]/);
    if (!arrayMatch) return [userQuery];
    const queries = JSON.parse(arrayMatch[0]);
    if (!Array.isArray(queries) || queries.length === 0) return [];
    return queries.slice(0, 3).filter(q => typeof q === 'string' && q.trim());
  } catch (err) {
    console.error('Query generation failed:', err.message);
    return [userQuery];
  }
}

// ── Build LLM context string ─────────────────────────────────
function buildContextString(allResults) {
  let ctx = '[Web Search Results]\n\n';
  for (let i = 0; i < allResults.length && i < 6; i++) {
    const r = allResults[i];
    ctx += `Source ${i + 1}: ${r.title} (${r.url})\n`;
    ctx += r.content ? `Content: ${r.content}\n` : `Snippet: ${r.snippet}\n`;
    if (r.images && r.images.length > 0) {
      ctx += `Images: ${r.images.slice(0, 3).map(img => `![${img.alt || 'image'}](${img.src})`).join(' ')}\n`;
    }
    ctx += '\n';
  }
  ctx += '[End Web Search Results]';
  return ctx;
}

// ── Mount Express routes ─────────────────────────────────────
module.exports = function mountWebAgentRoutes(app, ollamaChat) {

  // Raw DDG search
  app.post('/api/web/search', async (req, res) => {
    const { query, count } = req.body;
    if (!query) return res.status(400).json({ error: 'Missing query' });
    try {
      res.json({ query, results: await searchDDG(query, count || 6) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Raw page scrape (smart: Twitter→Nitter, Reddit→JSON, RSS auto-detect)
  app.post('/api/web/scrape', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Missing url' });
    try {
      res.json(await scrapeSmart(url));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Places search — returns structured place objects with lat/lng/images/reviews
  app.get('/api/web/search-places', async (req, res) => {
    const { q, near, max } = req.query;
    if (!q) return res.status(400).json({ error: 'Missing q' });
    try {
      const places = await searchPlaces(q, near || '', parseInt(max) || 6);
      res.json({ query: q, near: near || '', places });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Streaming agent search — NDJSON progress events
  app.post('/api/web/agent-search', async (req, res) => {
    const { query, chatHistory = [], model = 'gemma3:latest', maxScrape = 3 } = req.body;
    if (!query) return res.status(400).json({ error: 'Missing query' });

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');

    function emit(event) {
      try { res.write(JSON.stringify(event) + '\n'); } catch {}
    }

    try {
      emit({ type: 'status', message: 'Analyzing your question...' });

      const searchQueries = await generateSearchQueries(query, chatHistory, model, ollamaChat);

      if (searchQueries.length === 0) {
        emit({ type: 'done', searchQueries: [], webResults: [], contextForLLM: '' });
        return res.end();
      }

      emit({ type: 'queries', queries: searchQueries });

      // Search each query
      const allResults = [];
      const seen = new Set();

      for (const q of searchQueries) {
        emit({ type: 'searching', query: q });
        try {
          const results = await searchDDG(q, 4);
          const newResults = [];
          for (const r of results) {
            if (!seen.has(r.url)) {
              seen.add(r.url);
              allResults.push({ ...r, query: q });
              newResults.push(r);
            }
          }
          emit({ type: 'search-results', query: q, results: newResults });
        } catch (err) {
          emit({ type: 'search-error', query: q, error: err.message });
        }
      }

      if (allResults.length === 0) {
        emit({ type: 'done', searchQueries, webResults: [], contextForLLM: '' });
        return res.end();
      }

      // Scrape top results
      const scrapeTargets = allResults.slice(0, maxScrape);
      for (const result of scrapeTargets) {
        let domain = '';
        try { domain = new URL(result.url).hostname.replace('www.', ''); } catch {}
        emit({ type: 'scraping', url: result.url, title: result.title, domain });
        try {
          const scraped = await scrapeSmart(result.url);
          result.content = scraped.content.substring(0, 3000);
          result.images = scraped.images.slice(0, 8);
          result.pageTitle = scraped.title || result.title;
          result.description = scraped.description;
          result.source = scraped.source;
          result.liveItems = scraped.liveItems;
          emit({
            type: 'scraped',
            url: result.url,
            title: result.pageTitle || result.title,
            domain,
            source: scraped.source,
            images: result.images.slice(0, 4),
            snippet: result.description || result.snippet,
            charCount: result.content.length
          });
        } catch (err) {
          emit({ type: 'scrape-error', url: result.url, domain, error: err.message });
        }
      }

      emit({ type: 'status', message: 'Compiling results...' });

      const contextForLLM = buildContextString(allResults);
      emit({
        type: 'done',
        searchQueries,
        webResults: allResults.slice(0, 6),
        contextForLLM
      });

    } catch (err) {
      emit({ type: 'error', message: err.message });
    }

    res.end();
  });

  // Image proxy — avoids CORS/mixed-content issues
  app.get('/api/web/image-proxy', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send('Missing url');
    try {
      const parsedUrl = new URL(url);
      const client = parsedUrl.protocol === 'https:' ? https : http;
      client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 }, (proxyRes) => {
        if (proxyRes.statusCode !== 200) {
          res.status(proxyRes.statusCode).send('Image fetch failed');
          return proxyRes.resume();
        }
        res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        proxyRes.pipe(res);
      }).on('error', () => res.status(500).send('Proxy error'));
    } catch { res.status(400).send('Invalid URL'); }
  });
};
