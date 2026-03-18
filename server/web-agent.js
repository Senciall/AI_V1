/* ═══════════════════════════════════════════════════════════
   Web Agent — search, scrape, and streaming two-pass orchestrator
   Self-contained module: no npm dependencies beyond Node built-ins
   ═══════════════════════════════════════════════════════════ */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { ollamaChat } = require('./ollama');
const { loadData } = require('./data');

// ── JSON fetch helper ───────────────────────────────────────
function fetchJSON(targetUrl) {
  return new Promise((resolve, reject) => {
    const client = targetUrl.startsWith('https') ? https : http;
    client.get(targetUrl, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000,
    }, (res) => {
      if ([301, 302, 303, 307].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return fetchJSON(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON')); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── Google Places API helpers ───────────────────────────────
async function googleTextSearch(query, apiKey) {
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${apiKey}`;
  const data = await fetchJSON(url);
  if (data.status !== 'OK' || !data.results || !data.results.length) return null;
  return data.results[0];
}

async function googlePlaceDetails(placeId, apiKey) {
  const fields = 'name,formatted_address,geometry,rating,user_ratings_total,reviews,photos,opening_hours,price_level,types';
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=${fields}&key=${apiKey}`;
  const data = await fetchJSON(url);
  if (data.status !== 'OK' || !data.result) return null;
  return data.result;
}

function googlePhotoUrl(photoRef, apiKey, maxWidth = 400) {
  return `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${maxWidth}&photo_reference=${photoRef}&key=${apiKey}`;
}

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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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
      const MAX = 500 * 1024;

      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX) { res.destroy(); return; }
        data += chunk;
      });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
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
    const title = titleMatch
      ? titleMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      : '';

    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:td|div|span)>/);
    const snippet = snippetMatch
      ? snippetMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      : '';

    if (title || snippet) {
      results.push({ url: link, title, snippet });
    }
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

    try { src = new URL(src, targetUrl).href; }
    catch { continue; }

    if (!src.startsWith('http')) continue;
    images.push({ src, alt });
  }

  if (ogImage) {
    try {
      const resolved = new URL(ogImage, targetUrl).href;
      if (!images.some(i => i.src === resolved)) {
        images.unshift({ src: resolved, alt: title });
      }
    } catch {}
  }

  let text = clean
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length > 15000) text = text.substring(0, 15000) + '...';

  return { title, description, content: text, images, url: targetUrl };
}

// ── Extract ld+json structured data from raw HTML ───────────
function extractStructuredData(html, pageUrl) {
  const results = [];
  const ldRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = ldRegex.exec(html)) !== null) {
    try {
      let parsed = JSON.parse(match[1]);
      // Handle arrays (some sites wrap in array)
      if (Array.isArray(parsed)) parsed = parsed[0];
      // Handle @graph
      if (parsed['@graph']) {
        for (const item of parsed['@graph']) results.push(item);
      } else {
        results.push(parsed);
      }
    } catch {}
  }

  // Filter for place-like schemas
  const placeTypes = ['LocalBusiness', 'Restaurant', 'FoodEstablishment', 'CafeOrCoffeeShop',
    'BarOrPub', 'Store', 'Hotel', 'TouristAttraction', 'LodgingBusiness', 'Place',
    'SportsActivityLocation', 'EntertainmentBusiness', 'HealthAndBeautyBusiness'];

  const places = [];
  for (const item of results) {
    const type = item['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (!types.some(t => placeTypes.includes(t))) continue;

    const addr = item.address || {};
    const geo = item.geo || {};
    const rating = item.aggregateRating || {};
    const name = item.name || '';
    if (!name) continue;

    // Extract images
    const imgs = [];
    if (item.image) {
      const imgList = Array.isArray(item.image) ? item.image : [item.image];
      for (const img of imgList) {
        const src = typeof img === 'string' ? img : img?.url;
        if (src && src.startsWith('http')) imgs.push({ src, alt: name });
      }
    }

    // Extract reviews
    const revs = [];
    if (item.review) {
      const revList = Array.isArray(item.review) ? item.review : [item.review];
      for (const rv of revList.slice(0, 5)) {
        revs.push({
          text: (rv.reviewBody || rv.description || '').substring(0, 250),
          author: rv.author?.name || rv.author || 'Anonymous',
          rating: rv.reviewRating?.ratingValue || 0,
          time: rv.datePublished || '',
          source: 'Review',
          url: pageUrl
        });
      }
    }

    places.push({
      name,
      address: [addr.streetAddress, addr.addressLocality, addr.addressRegion, addr.postalCode]
        .filter(Boolean).join(', ') || item.address || '',
      lat: geo.latitude ? parseFloat(geo.latitude) : null,
      lng: geo.longitude ? parseFloat(geo.longitude) : null,
      rating: rating.ratingValue ? parseFloat(rating.ratingValue) : null,
      totalRatings: rating.reviewCount ? parseInt(rating.reviewCount) : 0,
      priceRange: item.priceRange || null,
      phone: item.telephone || null,
      images: imgs.slice(0, 6),
      reviews: revs,
      url: pageUrl,
      types: types
    });
  }

  return places;
}

// ── Search for places via DDG → scrape structured data ──────
async function searchPlaces(query, location, max = 6) {
  const searchQ = location ? `${query} near ${location}` : query;
  const allPlaces = [];
  const seenNames = new Set();

  // Search DDG for the query — results will include Yelp, TripAdvisor, etc.
  const ddgResults = await searchDDG(searchQ, 10);

  // Prioritize review sites that have structured data
  const prioritySites = ['yelp.com', 'tripadvisor.com', 'foursquare.com', 'zomato.com', 'opentable.com'];
  const sorted = [...ddgResults].sort((a, b) => {
    const aP = prioritySites.some(s => a.url.includes(s)) ? 0 : 1;
    const bP = prioritySites.some(s => b.url.includes(s)) ? 0 : 1;
    return aP - bP;
  });

  // Scrape top results for ld+json place data
  for (const result of sorted.slice(0, 5)) {
    if (allPlaces.length >= max) break;

    try {
      const html = await fetchPage(result.url);
      const places = extractStructuredData(html, result.url);

      for (const place of places) {
        if (seenNames.has(place.name.toLowerCase())) continue;
        seenNames.add(place.name.toLowerCase());

        // If no images from ld+json, grab from page scrape
        if (place.images.length === 0) {
          try {
            const scraped = await scrapePage(result.url);
            place.images = scraped.images.slice(0, 4);
          } catch {}
        }

        allPlaces.push(place);
        if (allPlaces.length >= max) break;
      }
    } catch {}
  }

  // If we didn't get enough from structured data, supplement with DDG snippets
  if (allPlaces.length < 2) {
    for (const r of ddgResults) {
      if (allPlaces.length >= max) break;
      // Check if the title looks like a place name (not a list article)
      if (r.title && !r.title.toLowerCase().includes('best ') && !r.title.toLowerCase().includes(' top ')) {
        const name = r.title.split(' - ')[0].split(' | ')[0].trim();
        if (name.length > 2 && name.length < 80 && !seenNames.has(name.toLowerCase())) {
          seenNames.add(name.toLowerCase());
          let domain = '';
          try { domain = new URL(r.url).hostname.replace('www.', ''); } catch {}
          allPlaces.push({
            name,
            address: '',
            lat: null, lng: null,
            rating: null, totalRatings: 0,
            priceRange: null, phone: null,
            images: [],
            reviews: r.snippet ? [{
              text: r.snippet.substring(0, 200),
              author: domain, rating: 0, source: domain, url: r.url
            }] : [],
            url: r.url,
            types: []
          });
        }
      }
    }
  }

  return allPlaces;
}

// ── Pass 1: Generate search queries via Ollama ──────────────
async function generateSearchQueries(userQuery, chatHistory, model) {
  const systemPrompt = `You are a search query generator. Given the user's message and conversation context, generate 1-3 focused web search queries that would find the most relevant and current information. Respond ONLY with a JSON array of strings. If the message is purely conversational and needs no web search, respond with [].

Examples:
- User asks "What's the weather in NYC?" → ["weather NYC today"]
- User asks "Latest Python version" → ["Python latest version 2024", "Python release notes"]
- User says "Hello how are you?" → []`;

  const recentHistory = chatHistory.slice(-4);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...recentHistory,
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
    console.error('Query generation failed, using raw query:', err.message);
    return [userQuery];
  }
}

// ── Build LLM context string from results ───────────────────
function buildContextString(allResults) {
  let context = '[Web Search Results]\n\n';
  for (let i = 0; i < allResults.length && i < 6; i++) {
    const r = allResults[i];
    context += `Source ${i + 1}: ${r.title} (${r.url})\n`;
    if (r.content) {
      context += `Content: ${r.content}\n`;
    } else {
      context += `Snippet: ${r.snippet}\n`;
    }
    if (r.images && r.images.length > 0) {
      context += `Images: ${r.images.slice(0, 3).map(img => `![${img.alt || 'image'}](${img.src})`).join(' ')}\n`;
    }
    context += '\n';
  }
  context += '[End Web Search Results]';
  return context;
}

// ── Mount Express routes ────────────────────────────────────
module.exports = function mountWebAgentRoutes(app) {

  // Raw search endpoint
  app.post('/api/web/search', async (req, res) => {
    const { query, count } = req.body;
    if (!query) return res.status(400).json({ error: 'Missing query' });
    try {
      const results = await searchDDG(query, count || 6);
      res.json({ query, results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Raw scrape endpoint
  app.post('/api/web/scrape', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Missing url' });
    try {
      const data = await scrapePage(url);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Streaming agent search — sends NDJSON progress events ──
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
      // ── Step 1: Generate search queries ──
      emit({ type: 'status', message: 'Analyzing your question...' });

      const searchQueries = await generateSearchQueries(query, chatHistory, model);

      if (searchQueries.length === 0) {
        emit({ type: 'done', searchQueries: [], webResults: [], contextForLLM: '' });
        return res.end();
      }

      emit({ type: 'queries', queries: searchQueries });

      // ── Step 2: Search each query ──
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

      // ── Step 3: Scrape top results one by one ──
      const scrapeTargets = allResults.slice(0, maxScrape);

      for (const result of scrapeTargets) {
        let domain = '';
        try { domain = new URL(result.url).hostname.replace('www.', ''); } catch {}

        emit({ type: 'scraping', url: result.url, title: result.title, domain });

        try {
          const scraped = await scrapePage(result.url);
          result.content = scraped.content.substring(0, 3000);
          result.images = scraped.images.slice(0, 8);
          result.pageTitle = scraped.title || result.title;
          result.description = scraped.description;

          emit({
            type: 'scraped',
            url: result.url,
            title: result.pageTitle || result.title,
            domain,
            images: result.images.slice(0, 8),
            snippet: result.description || result.snippet,
            fullContent: result.content.substring(0, 800),
            charCount: result.content.length
          });
        } catch (err) {
          emit({ type: 'scrape-error', url: result.url, domain, error: err.message });
        }
      }

      // ── Step 4: Build final context and send done ──
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

  // Search for places — DDG → scrape structured data from Yelp/TripAdvisor/etc.
  app.get('/api/web/search-places', async (req, res) => {
    const { q, near, max } = req.query;
    if (!q) return res.status(400).json({ error: 'Missing q' });
    try {
      const places = await searchPlaces(q, near || '', parseInt(max) || 6);
      res.json({ query: q, places });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Place details — Google Places API (if key set) or DDG→ld+json scraper
  app.get('/api/web/place-details', async (req, res) => {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Missing q' });

    try {
      const data = await loadData();
      const apiKey = data.settings?.googleMapsKey;

      // ── Google Places API path ──
      if (apiKey) {
        try {
          const searchResult = await googleTextSearch(q, apiKey);
          if (searchResult) {
            const details = await googlePlaceDetails(searchResult.place_id, apiKey);
            if (details) {
              const photos = (details.photos || []).slice(0, 10).map(p => ({
                src: `/api/web/place-photo?ref=${encodeURIComponent(p.photo_reference)}&maxw=600`,
                alt: (p.html_attributions?.[0] || '').replace(/<[^>]+>/g, '') || details.name
              }));

              const reviews = (details.reviews || []).slice(0, 5).map(rv => ({
                text: rv.text?.substring(0, 250) || '',
                author: rv.author_name || 'Anonymous',
                rating: rv.rating || 0,
                time: rv.relative_time_description || '',
                source: 'Google',
                url: rv.author_url || ''
              }));

              const loc = details.geometry?.location || {};

              return res.json({
                query: q,
                source: 'google',
                name: details.name,
                address: details.formatted_address,
                lat: loc.lat,
                lng: loc.lng,
                rating: details.rating || null,
                totalRatings: details.user_ratings_total || 0,
                priceLevel: details.price_level ?? null,
                images: photos,
                reviews,
                types: (details.types || []).slice(0, 4),
                openNow: details.opening_hours?.open_now ?? null
              });
            }
          }
        } catch (err) {
          console.error('Google Places API failed, falling back to scraper:', err.message);
        }
      }

      // ── Scraper fallback: DDG → Yelp/TripAdvisor ld+json ──
      const places = await searchPlaces(q, '', 1);
      if (places.length > 0) {
        const p = places[0];
        return res.json({
          query: q,
          source: 'scrape',
          name: p.name,
          address: p.address,
          lat: p.lat,
          lng: p.lng,
          rating: p.rating,
          totalRatings: p.totalRatings,
          priceRange: p.priceRange,
          images: p.images.slice(0, 8),
          reviews: p.reviews.slice(0, 3)
        });
      }

      // Final fallback: basic DDG scrape for images/snippets
      const images = [];
      const reviews = [];
      const searchResults = await searchDDG(`${q} reviews`, 4);

      for (const result of searchResults.slice(0, 2)) {
        try {
          const scraped = await scrapePage(result.url);
          for (const img of scraped.images.slice(0, 4)) {
            if (!images.some(i => i.src === img.src)) images.push(img);
          }
        } catch {}
      }
      for (const r of searchResults.slice(0, 3)) {
        if (r.snippet && r.snippet.length > 30) {
          let domain = '';
          try { domain = new URL(r.url).hostname.replace('www.', ''); } catch {}
          reviews.push({
            text: r.snippet.substring(0, 200),
            author: domain, rating: 0, source: domain, url: r.url
          });
        }
      }

      res.json({
        query: q,
        source: 'scrape',
        images: images.slice(0, 6),
        reviews: reviews.slice(0, 3)
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Google Place Photo proxy (avoids exposing API key to client)
  app.get('/api/web/place-photo', async (req, res) => {
    const { ref, maxw } = req.query;
    if (!ref) return res.status(400).send('Missing ref');
    try {
      const data = await loadData();
      const apiKey = data.settings?.googleMapsKey;
      if (!apiKey) return res.status(400).send('No API key');

      const photoUrl = googlePhotoUrl(ref, apiKey, parseInt(maxw) || 400);
      // Google redirects to the actual image — follow it
      https.get(photoUrl, (proxyRes) => {
        if ([301, 302, 303, 307].includes(proxyRes.statusCode) && proxyRes.headers.location) {
          // Follow redirect to actual image
          https.get(proxyRes.headers.location, (imgRes) => {
            res.setHeader('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            imgRes.pipe(res);
          }).on('error', () => res.status(500).send('Photo fetch failed'));
          proxyRes.resume();
        } else if (proxyRes.statusCode === 200) {
          res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'image/jpeg');
          res.setHeader('Cache-Control', 'public, max-age=86400');
          proxyRes.pipe(res);
        } else {
          res.status(proxyRes.statusCode).send('Photo unavailable');
          proxyRes.resume();
        }
      }).on('error', () => res.status(500).send('Photo proxy error'));
    } catch {
      res.status(500).send('Error');
    }
  });

  // Image proxy
  app.get('/api/web/image-proxy', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send('Missing url');

    try {
      const parsedUrl = new URL(url);
      const client = parsedUrl.protocol === 'https:' ? https : http;

      client.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 8000,
      }, (proxyRes) => {
        if (proxyRes.statusCode !== 200) {
          res.status(proxyRes.statusCode).send('Image fetch failed');
          return proxyRes.resume();
        }
        const contentType = proxyRes.headers['content-type'] || 'image/jpeg';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        proxyRes.pipe(res);
      }).on('error', () => res.status(500).send('Proxy error'));
    } catch {
      res.status(400).send('Invalid URL');
    }
  });
};
