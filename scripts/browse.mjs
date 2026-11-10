// Minimal agentic browser — public GETs only. No secrets, no auth, quiet logs.
// Env: TARGETS_JSON = [{name, url} | {name, search}], STAMP = evidence dir name,
//   DEPTH = 0|1 (1 = follow interesting links inside the same run — one run does hop chains).
// Writes evidence/<stamp>/t-<name>.json (+ t-d1-<n>.json follows) + evidence/<stamp>/summary.json.
import { writeFile, mkdir } from 'node:fs/promises';

const stamp = (process.env.STAMP || new Date().toISOString().replace(/[:.]/g, '-')).replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 60) || 'run';
const outDir = `evidence/${stamp}`;
await mkdir(outDir, { recursive: true });

let targets = [];
try { targets = JSON.parse(process.env.TARGETS_JSON || '[]'); } catch { targets = []; }

const DEPTH = Math.min(parseInt(process.env.DEPTH || '0', 10) || 0, 1);
const FOLLOW_RE = /(docs|faq|pricing|terms|lifecycle|bount|board|how-it-works|\/api\/|attach|guide)/i;

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
  return out.filter((l) => /faq|how|reward|bount|payout|pay|doc|term|price|open|app|issue|earn|start/i.test(l.h + ' ' + l.t)).slice(0, 40);
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

const RENDER = process.env.RENDER === '1';
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
async function browseUrl(name, rawUrl) {
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
        const j = JSON.parse(buf.toString('utf8'));
        const items = j.items || j.data || j.bounties || j.issues || j.rewards || (Array.isArray(j) ? j : null);
        row.json = {
          keys: (Array.isArray(j) ? ['<array>'] : Object.keys(j)).slice(0, 20),
          count: Array.isArray(items) ? items.length : (j.count ?? j.total ?? null),
          first: items && items[0] ? JSON.stringify(items[0]).slice(0, 600) : null,
        };
      } catch { row.json = { parse: 'fail' }; }
    } else {
      const html = buf.toString('utf8').slice(0, 500000);
      const text = textOf(html);
      row.textLen = text.length;
      row.head = cap(text, 1200);
      row.links = linksOf(html);
      row.nextData = nextData(html);
      row.hits = windows(text);
    }
  } catch (e) { row.error = String(e).slice(0, 160); }
  return row;
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
const followQueue = [];
const seen = new Set();
for (const t of targets.slice(0, 12)) {
  if (t.search) {
    const row = { name: t.name };
    try { Object.assign(row, await doSearch(t.search.engine, t.search.query, t.search.count, t.search.kind)); }
    catch (e) { row.error = String(e).slice(0, 160); }
    rows.push(row);
    await writeFile(`${outDir}/t-${t.name}.json`, JSON.stringify(row, null, 1).slice(0, 60000));
    continue;
  }
  seen.add(sanitizeUrl(t.url).url);
  const row = await browseUrl(t.name, t.url);
  rows.push(row);
  await writeFile(`${outDir}/t-${t.name}.json`, JSON.stringify(row, null, 1).slice(0, 60000));
  if (DEPTH >= 1 && row.links) {
    for (const l of row.links) {
      let abs;
      try { abs = new URL(l.h, row.final || row.url).toString(); } catch { continue; }
      if (!FOLLOW_RE.test(abs) || seen.has(sanitizeUrl(abs).url)) continue;
      seen.add(sanitizeUrl(abs).url);
      if (followQueue.length < 8) followQueue.push(abs);
    }
  }
}
// DEPTH=1: hop chain inside the SAME run — same evidence format, no extra dispatches.
let d = 0;
for (const u of followQueue) {
  d++;
  const row = await browseUrl(`d1-${d}`, u);
  row.followOf = stamp;
  rows.push(row);
  await writeFile(`${outDir}/t-d1-${d}.json`, JSON.stringify(row, null, 1).slice(0, 60000));
}
await writeFile(`${outDir}/summary.json`, JSON.stringify({
  stamp,
  takenAt: new Date().toISOString(),
  depth: DEPTH,
  targets: rows.map((r) => ({ name: r.name, status: r.status ?? r.error ?? '?', bytes: r.bytes ?? 0 })),
}, null, 1));
console.log('browse ok ' + rows.map((r) => `${r.name}=${r.status ?? r.error}`).join(' '));
