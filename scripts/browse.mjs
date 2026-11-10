// Minimal agentic browser — public GETs only. No secrets, no auth, quiet logs.
// Env: TARGETS_JSON = [{name, url}] (max 12), STAMP = evidence dir name.
// Writes evidence/<stamp>/t-<name>.json + evidence/<stamp>/summary.json (all size-capped).
import { writeFile, mkdir } from 'node:fs/promises';

const stamp = (process.env.STAMP || new Date().toISOString().replace(/[:.]/g, '-')).replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 60) || 'run';
const outDir = `evidence/${stamp}`;
await mkdir(outDir, { recursive: true });

let targets = [];
try { targets = JSON.parse(process.env.TARGETS_JSON || '[]'); } catch { targets = []; }

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

const rows = [];
for (const t of targets.slice(0, 12)) {
  const su = sanitizeUrl(t.url);
  const row = { name: t.name, url: su.url };
  if (su.sanitized) row.sanitized = true;
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
    if (row.ct.includes('json') || /\/api\//.test(t.url)) {
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
  rows.push(row);
  await writeFile(`${outDir}/t-${t.name}.json`, JSON.stringify(row, null, 1).slice(0, 60000));
}
await writeFile(`${outDir}/summary.json`, JSON.stringify({
  stamp,
  takenAt: new Date().toISOString(),
  targets: rows.map((r) => ({ name: r.name, status: r.status ?? r.error ?? '?', bytes: r.bytes ?? 0 })),
}, null, 1));
console.log('browse ok ' + rows.map((r) => `${r.name}=${r.status ?? r.error}`).join(' '));
