// Minimal agentic browser — public GETs only. No secrets, no auth, quiet logs.
// Env: TARGETS_JSON, STAMP, CASE, DEPTH, RENDER, MAX_TARGETS, MAX_FOLLOWS, RPC_URL.
// Case presets set the depth:breadth ratio; explicit env overrides the preset.
// Writes evidence/<stamp>/t-<name>.json + evidence/<stamp>/summary.json.
//
// CASE GUIDE (depth:breadth per case type — measured on this lane, read at boot):
// - discover   : breadth HIGH, depth 0. 8-12 seed URLs, no follows, render 0.
//                Use: find new hubs. Why shallow: hub homepages diverge; follows burn
//                runs. (search1: 30 results -> 8 hubs browsed, all verdicts from heads.)
// - inventory  : breadth LOW (1-3 boards), depth 0, render 1 + apiCalls harvest.
//                Use: JS-rendered bounty boards (uBounty filters, TaskBounty /board).
//                Do NOT follow links — harvest the API routes instead (bp /api/bounties/open
//                found via render, not via crawling).
// - proof      : breadth LOW (1-2 seeds), depth 2 NARROW (docs/faq/pricing/terms only).
//                Use: escrow / payout / KYC proof. Why depth 2: proof lives 2 hops down
//                (home -> docs -> pricing/terms). Depth 1 MISSED it — opire needed 3
//                dispatches before depth existed. Narrow FOLLOW_RE keeps it cheap.
// - api-hunt   : breadth LOW (1-2 apps), depth 1 WIDE + bundle-mine + render apiCalls.
//                Use: hidden /api routes, registry addresses, openapi.json. Mine JS
//                chunks (__NEXT_DATA__ buildId, /_next/static/*.js) for /api/ strings.
// - repo-mine  : breadth LOW (2-4 raw files), depth 1, via CDN (cdn.jsdelivr, NOT
//                raw.githubusercontent which times out from worker/Actions).
//                Use: docs repos (uBounty ProductFeatures), ABI, route lists.
// - search-sweep: breadth HIGH (6-10 queries), depth 0, engines ddg+mojeek+github.
//                Use: query expansion. No follows — next dispatch browses the hits.
// - chain-read : breadth = contracts, depth = blocks. RPC targets bypass JS walls
//                entirely (BountyPay escrow 0xd0A0… inventory via eth_getLogs).
//                Use when the app is wallet-walled but the escrow is on-chain (OUR chain).
//
// Rule of thumb: discovery = wide+shallow, proof = narrow+deep, inventory = render
// don't crawl, chain = don't browse at all. When unsure, proof-like questions take
// depth 2 narrow; hub questions take depth 0 wide. Depth 1 is the DEFAULT, not the best.
import { writeFile, mkdir } from 'node:fs/promises';

const stamp = (process.env.STAMP || new Date().toISOString().replace(/[:.]/g, '-')).replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 60) || 'run';
const outDir = `evidence/${stamp}`;
await mkdir(outDir, { recursive: true });

let targets = [];
try { targets = JSON.parse(process.env.TARGETS_JSON || '[]'); } catch { targets = []; }

// ---- case presets (depth:breadth) ----
const CASES = {
  discover: { depth: 0, render: 0, maxTargets: 12, maxFollows: 0, bundle: 0, sitemap: 1 },
  inventory: { depth: 0, render: 1, maxTargets: 3, maxFollows: 0, bundle: 0, sitemap: 0 },
  proof: { depth: 2, render: 0, maxTargets: 2, maxFollows: 6, bundle: 0, sitemap: 1 },
  'api-hunt': { depth: 1, render: 1, maxTargets: 2, maxFollows: 8, bundle: 1, sitemap: 1 },
  'repo-mine': { depth: 1, render: 0, maxTargets: 4, maxFollows: 4, bundle: 0, sitemap: 0 },
  'search-sweep': { depth: 0, render: 0, maxTargets: 10, maxFollows: 0, bundle: 0, sitemap: 0 },
  'chain-read': { depth: 0, render: 0, maxTargets: 12, maxFollows: 0, bundle: 0, sitemap: 0 },
};
const caseName = (process.env.CASE || '').toLowerCase().trim() || null;
const preset = (caseName && CASES[caseName]) || { depth: 1, render: 0, maxTargets: 8, maxFollows: 8, bundle: 0, sitemap: 0 };
// Empty-string env (undispatched workflow inputs default to '') means "unset" — fall
// back to the CASE preset. Without this, '' overrides the preset (parseInt('')=NaN).
const numOr = (v, d) => {
  const s = (v ?? '').toString().trim();
  if (!s) return d;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : d;
};
const DEPTH = Math.min(Math.max(numOr(process.env.DEPTH, preset.depth), 0), 2);
const RENDER_ON = ((process.env.RENDER ?? '').toString().trim() === '' ? String(preset.render) : process.env.RENDER) === '1';
const MAX_TARGETS = Math.min(Math.max(numOr(process.env.MAX_TARGETS, preset.maxTargets), 1), 12);
const MAX_FOLLOWS = Math.min(Math.max(numOr(process.env.MAX_FOLLOWS, preset.maxFollows), 0), 12);
const BUNDLE_ON = ((process.env.BUNDLE ?? '').toString().trim() === '' ? String(preset.bundle || 0) : process.env.BUNDLE) === '1';
const SITEMAP_ON = ((process.env.SITEMAP ?? '').toString().trim() === '' ? String(preset.sitemap ?? 0) : process.env.SITEMAP) === '1';
const RPC_URL = (process.env.RPC_URL || 'https://mainnet.base.org').slice(0, 200);
console.log(`boot case=${caseName || 'default'} depth=${DEPTH} breadth=${MAX_TARGETS}+${MAX_FOLLOWS} render=${RENDER_ON ? 1 : 0} bundle=${BUNDLE_ON ? 1 : 0} sitemap=${SITEMAP_ON ? 1 : 0}`);

const FOLLOW_NARROW = /(docs|faq|pricing|terms|lifecycle|guide|how-it-works|attach)/i;
const FOLLOW_WIDE = /(docs|faq|pricing|terms|lifecycle|bount|board|how-it-works|\/api\/|attach|guide|openapi|\.json)/i;
const FOLLOW_RE = DEPTH >= 2 ? FOLLOW_NARROW : FOLLOW_WIDE;

const KW = ['payout', 'paid out', 'stripe', 'wallet', 'bank account', 'usdc', 'usdt', 'crypto',
  'kyc', 'interview', 'video call', 'fee', 'withdraw', 'claim', 'escrow', 'reward', 'bounty',
  'get paid', 'how it works', 'weekly', 'monthly', 'terms'];
const cap = (s, n) => (s.length > n ? s.slice(0, n) + `…[trunc ${s.length}]` : s);

// Scramble hygiene: evidence/ is PUBLIC. Never persist credentials or secret-bearing
// query params — a future authed-URL dispatch must not land secrets in the repo.
// Authed targets are out of scope for this lane (public GETs only); params get
// redacted, which may break such targets by design.
function sanitizeUrl(u) {
  try {
    const x = new URL(u);
    let hit = false;
    if (x.username || x.password) { x.username = ''; x.password = ''; hit = true; }
    const secretKeys = ['key', 'token', 'secret', 'sig', 'signature', 'auth', 'apikey', 'api_key', 'access_token'];
    for (const k of [...x.searchParams.keys()]) {
      if (secretKeys.includes(k.toLowerCase())) { x.searchParams.set(k, '…redacted'); hit = true; }
    }
    return { url: x.toString().slice(0, 500), sanitized: hit };
  } catch { return { url: String(u).slice(0, 500), sanitized: false }; }
}

function textOf(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}
function linksOf(html) {
  const out = [];
  const re = /<a\b[^>]*href="([^"#]+)"[^>]*>([\s\S]{0,120}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 200) {
    out.push({ h: m[1].slice(0, 200), t: m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) });
  }
  return out.filter((l) => /faq|how|reward|bount|payout|pay|doc|term|price|open|app|issue|earn|start|api|guide/i.test(l.h + ' ' + l.t)).slice(0, 40);
}
function windows(text) {
  const L = text.toLowerCase();
  const wins = [];
  for (const k of KW) {
    let i = L.indexOf(k);
    let n = 0;
    while (i !== -1 && n < 3) {
      wins.push({ k, w: text.slice(Math.max(0, i - 140), i + 180) });
      i = L.indexOf(k, i + k.length);
      n++;
    }
  }
  return wins.slice(0, 40);
}
function nextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[1]);
    return { keys: Object.keys(j).slice(0, 20), page: j.page || j.path || null, buildId: j.buildId || null };
  } catch { return { parse: 'fail', bytes: m[1].length }; }
}
function scriptSrcs(html, base) {
  const out = [];
  const re = /<script[^>]+src="([^"]+\.js[^"]*)"/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 15) {
    try { out.push(new URL(m[1], base).toString().slice(0, 300)); } catch { /* skip */ }
  }
  return out.filter((u) => /_next\/static|static\/js|assets|chunks|bundle/i.test(u)).slice(0, 8);
}

const RENDER = RENDER_ON;
let _pw = null;
async function renderedHtml(url) {
  try {
    if (!_pw) _pw = (await import('playwright')).chromium;
  } catch { return { error: 'playwright-missing' }; }
  let browser = null;
  try {
    browser = await _pw.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage({ userAgent: 'agent-browser/1.0' });
    const apiCalls = [];
    page.on('request', (req) => {
      const u = req.url();
      if (/\/(api|graphql|trpc)|_next\/data|supabase|firebase|hasura|rest\/v1/i.test(u) && !/sockjs|socket|analytics|telemetry/i.test(u)) {
        if (!apiCalls.includes(u) && apiCalls.length < 20) apiCalls.push(u.slice(0, 300));
      }
    });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);
    const html = await page.content();
    await browser.close();
    return { html, apiCalls };
  } catch (e) { try { await browser?.close(); } catch {} return { error: String(e).slice(0, 160) }; }
}
async function browseUrl(name, rawUrl, depthLeft = 0) {
  const su = sanitizeUrl(rawUrl);
  const row = { name, url: su.url };
  if (su.sanitized) row.sanitized = true;
  if (RENDER && !/\/api\//.test(rawUrl)) {
    const rr = await renderedHtml(su.url);
    if (rr.error) { row.renderError = rr.error; }
    else {
      row.rendered = true;
      const html = rr.html.slice(0, 500000);
      const text = textOf(html);
      row.status = 200; row.ct = 'rendered-dom';
      row.bytes = rr.html.length; row.textLen = text.length;
      row.head = cap(text, 1200);
      row.links = linksOf(html);
      row.nextData = nextData(html);
      row.hits = windows(text);
      if (rr.apiCalls && rr.apiCalls.length) row.apiCalls = rr.apiCalls;
      return row;
    }
  }
  try {
    const r = await fetch(su.url, {
      headers: { 'User-Agent': 'agent-browser/1.0', Accept: 'text/html,application/json' },
      redirect: 'follow',
    });
    row.status = r.status;
    if (r.url !== su.url) row.final = sanitizeUrl(r.url).url;
    row.ct = (r.headers.get('content-type') || '').slice(0, 60);
    const buf = Buffer.from(await r.arrayBuffer());
    row.bytes = buf.length;
    if (row.ct.includes('json') || /\/api\//.test(rawUrl)) {
      try {
        const txt = buf.toString('utf8');
        const j = JSON.parse(txt);
        const items = j.items || j.data || j.bounties || j.issues || j.rewards || (Array.isArray(j) ? j : null);
        row.json = {
          keys: (Array.isArray(j) ? ['<array>'] : Object.keys(j)).slice(0, 20),
          count: Array.isArray(items) ? items.length : (j.count ?? j.total ?? null),
          first: items && items[0] ? JSON.stringify(items[0]).slice(0, 600) : null,
        };
        if (buf.length < 4096) row.json.body = txt.slice(0, 4000);
      } catch { row.json = { parse: 'fail' }; }
    } else {
      const html = buf.toString('utf8').slice(0, 500000);
      const text = textOf(html);
      row.textLen = text.length;
      row.head = cap(text, 1200);
      row.links = linksOf(html);
      row.nextData = nextData(html);
      row.hits = windows(text);
      if (BUNDLE_ON) {
        const chunks = scriptSrcs(html, row.final || row.url);
        const hits = [];
        for (const cu of chunks.slice(0, 5)) {
          try {
            const cr = await fetch(cu, { headers: { 'User-Agent': 'agent-browser/1.0' } });
            if (!cr.ok) continue;
            const js = await cr.text();
            const re = /\/api\/[a-zA-Z0-9_\-/{}:?=.]{1,80}|0x[0-9a-fA-F]{40}|openapi\.json|_next\/data\/[^\s"']{1,80}/g;
            let m; let n = 0;
            while ((m = re.exec(js)) && n < 10) { hits.push(m[0].slice(0, 120)); n++; }
            if (hits.length >= 15) break;
          } catch { /* skip chunk */ }
        }
        if (hits.length) row.bundleHits = [...new Set(hits)].slice(0, 20);
        row.bundlesChecked = chunks.length;
      }
    }
  } catch (e) { row.error = String(e).slice(0, 160); }
  return row;
}

// NEW SKILL 1 — chain-read: public JSON-RPC (no key, no secret). Bypasses JS walls.
// Target shape: {name, rpc:{url?, method, params}} — result capped, committed as public chain data.
async function rpcCall(name, spec) {
  const row = { name, rpc: { method: spec.method } };
  const url = (spec.url || RPC_URL).slice(0, 200);
  row.rpc.url = sanitizeUrl(url).url;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'agent-browser/1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: spec.method, params: spec.params || [] }),
    });
    row.status = r.status;
    const txt = await r.text();
    const j = JSON.parse(txt);
    if (j.error) row.rpcError = JSON.stringify(j.error).slice(0, 300);
    else row.result = JSON.stringify(j.result).slice(0, 2000);
  } catch (e) { row.error = String(e).slice(0, 160); }
  return row;
}

// NEW SKILL 2 — sitemap discovery: /sitemap.xml + /robots.txt per origin (free breadth).
async function sitemapOf(seedUrl) {
  try {
    const o = new URL(seedUrl);
    const base = o.origin;
    const out = { origin: base, routes: [] };
    for (const p of ['/sitemap.xml', '/robots.txt']) {
      try {
        const r = await fetch(base + p, { headers: { 'User-Agent': 'agent-browser/1.0' } });
        if (!r.ok) continue;
        const t = (await r.text()).slice(0, 20000);
        const locs = [...t.matchAll(/<loc>([^<]{1,200})<\/loc>/g)].map((m) => m[1]).slice(0, 30);
        const paths = [...t.matchAll(/(?:Allow|Disallow|Sitemap):\s*(\S{1,200})/g)].map((m) => m[1]).slice(0, 30);
        out.routes.push({ path: p, status: r.status, locs, paths });
      } catch { /* skip */ }
    }
    return out.routes.length ? out : null;
  } catch { return null; }
}

async function doSearch(engine, query, count = 10, kind = 'repositories') {  count = Math.min(Math.max(count || 10, 1), 10);
  const UA = { 'User-Agent': 'agent-browser/1.0' };
  if (engine === 'ddg') {
    const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), { headers: UA });
    const html = await r.text();
    const out = [];
    let m;
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = re.exec(html)) && out.length < count) {
      let href = m[1];
      const u = href.match(/[?&]uddg=([^&]+)/);
      try { href = u ? decodeURIComponent(u[1]) : href; } catch { /* keep raw */ }
      if (/duckduckgo\.com/.test(href)) continue;
      out.push({ title: m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160), url: href.slice(0, 300) });
    }
    const snips = [];
    const rs = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = rs.exec(html)) && snips.length < count) snips.push(m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240));
    out.forEach((o, i) => { if (snips[i]) o.snippet = snips[i]; });
    return { engine, query, status: r.status, count: out.length, results: out };
  }
  if (engine === 'mojeek') {
    const r = await fetch('https://www.mojeek.com/search?q=' + encodeURIComponent(query), { headers: UA });
    const html = await r.text();
    const out = [];
    const seen = new Set();
    let m;
    const re = /<h2>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = re.exec(html)) && out.length < count) {
      const href = m[1];
      if (!/^https?:\/\//.test(href) || /mojeek\.com/.test(href) || seen.has(href)) continue;
      seen.add(href);
      out.push({ title: m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160), url: href.slice(0, 300) });
    }
    return { engine, query, status: r.status, count: out.length, results: out };
  }
  if (engine === 'github') {
    // kind: repositories | issues. Auth: Actions-provided GITHUB_TOKEN (never committed/logged).
    const H = { Accept: 'application/vnd.github+json', 'User-Agent': 'agent-browser' };
    if (process.env.GH_TOKEN) H.Authorization = 'Bearer ' + process.env.GH_TOKEN;
    const r = await fetch(`https://api.github.com/search/${kind}?q=` + encodeURIComponent(query) + `&per_page=${count}&sort=updated`, { headers: H });
    const jj = await r.json().catch(() => ({}));
    const items = jj.items || [];
    const out = items.slice(0, count).map((it) => kind === 'issues'
      ? { title: `${(it.repository_url || '').split('/').slice(-1)}#${it.number} ${it.title}`.slice(0, 160), url: it.html_url, snippet: `${it.state} ${it.labels ? it.labels.map((l) => l.name).join(',') : ''} ${it.created_at || ''}`.slice(0, 240) }
      : { title: it.full_name, url: it.html_url, snippet: `${it.description || ''} ★${it.stargazers_count} ${it.language || ''} upd:${(it.updated_at || '').slice(0, 10)}`.slice(0, 240) });
    return { engine: 'github:' + kind, query, status: r.status, count: out.length, results: out };
  }
  return { engine, query, error: 'unknown engine (ddg | mojeek | github)' };
}

const rows = [];
const seen = new Set();
// BFS across DEPTH levels: level 0 = seeds, level 1..DEPTH = follows. Breadth capped.
let frontier = [];
for (const t of targets.slice(0, MAX_TARGETS)) {
  if (t.search) {
    const row = { name: t.name };
    try { Object.assign(row, await doSearch(t.search.engine, t.search.query, t.search.count, t.search.kind)); }
    catch (e) { row.error = String(e).slice(0, 160); }
    rows.push(row);
    await writeFile(`${outDir}/t-${t.name}.json`, JSON.stringify(row, null, 1).slice(0, 60000));
    continue;
  }
  if (t.rpc) {
    const row = await rpcCall(t.name, t.rpc);
    rows.push(row);
    await writeFile(`${outDir}/t-${t.name}.json`, JSON.stringify(row, null, 1).slice(0, 60000));
    continue;
  }
  if (!t.url) continue;
  seen.add(sanitizeUrl(t.url).url);
  const row = await browseUrl(t.name, t.url);
  row.depth = 0;
  rows.push(row);
  await writeFile(`${outDir}/t-${t.name}.json`, JSON.stringify(row, null, 1).slice(0, 60000));
  if (DEPTH >= 1 && row.links) {
    for (const l of row.links) {
      let abs;
      try { abs = new URL(l.h, row.final || row.url).toString(); } catch { continue; }
      if (!FOLLOW_RE.test(abs) || seen.has(sanitizeUrl(abs).url)) continue;
      seen.add(sanitizeUrl(abs).url);
      if (frontier.length < MAX_FOLLOWS) frontier.push({ url: abs, from: t.name, depth: 1 });
    }
  }
}
// Sitemap free-breadth: first seed origin only (2 cheap fetches, no follow budget spent).
if (SITEMAP_ON) {
  const seed = targets.find((t) => t.url);
  if (seed) {
    const sm = await sitemapOf(seed.url);
    if (sm) {
      rows.push({ name: 'sitemap', ...sm });
      await writeFile(`${outDir}/t-sitemap.json`, JSON.stringify({ name: 'sitemap', ...sm }, null, 1).slice(0, 60000));
    }
  }
}
// Follow levels 1..DEPTH inside the SAME run — same evidence format, no extra dispatches.
let d = 0;
let level = 1;
while (frontier.length && level <= DEPTH) {
  const next = [];
  for (const f of frontier) {
    d++;
    const row = await browseUrl(`d${level}-${d}`, f.url);
    row.followOf = f.from;
    row.depth = level;
    rows.push(row);
    await writeFile(`${outDir}/t-d${level}-${d}.json`, JSON.stringify(row, null, 1).slice(0, 60000));
    if (level < DEPTH && row.links) {
      for (const l of row.links) {
        let abs;
        try { abs = new URL(l.h, row.final || row.url).toString(); } catch { continue; }
        if (!FOLLOW_RE.test(abs) || seen.has(sanitizeUrl(abs).url)) continue;
        seen.add(sanitizeUrl(abs).url);
        if (frontier.length + next.length < MAX_FOLLOWS) next.push({ url: abs, from: `d${level}-${d}`, depth: level + 1 });
      }
    }
  }
  frontier = next;
  level++;
}
await writeFile(`${outDir}/summary.json`, JSON.stringify({
  stamp,
  takenAt: new Date().toISOString(),
  case: caseName || 'default',
  depth: DEPTH,
  breadth: { maxTargets: MAX_TARGETS, maxFollows: MAX_FOLLOWS },
  render: RENDER_ON,
  targets: rows.map((r) => ({ name: r.name, status: r.status ?? r.error ?? '?', bytes: r.bytes ?? 0 })),
}, null, 1));
console.log('browse ok ' + rows.map((r) => `${r.name}=${r.status ?? r.error}`).join(' '));
