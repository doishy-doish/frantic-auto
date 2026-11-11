// ab-probe: Google leg via vercel-labs/agent-browser CLI (daemon browser,
// a11y snapshots, built-in state save). Evidence: evidence/<stamp>/t-<name>.json.
import { writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const stamp = (process.env.STAMP || 'ab1').replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 60) || 'ab1';
const outDir = `evidence/${stamp}`;
await mkdir(outDir, { recursive: true });
let queries = [];
try { queries = JSON.parse(process.env.QUERIES_JSON || '[]'); } catch { queries = []; }

const SESS = 'gap';
function cli(...args) {
  try {
    const out = execFileSync('agent-browser', ['--session', SESS, ...args], {
      encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, out: out.slice(0, 20000) };
  } catch (e) {
    const so = (e.stdout || '').toString().slice(0, 4000);
    const se = (e.stderr || '').toString().slice(0, 1000);
    return { ok: false, out: (so + '\n' + se).slice(0, 5000) };
  }
}

const rows = [];
for (const q of queries.slice(0, 6)) {
  const row = { name: q.name, engine: 'agent-browser:google', query: q.query };
  const url = 'https://www.google.com/search?q=' + encodeURIComponent(q.query) + '&num=8&hl=en&complete=0';
  const o = cli('open', url);
  if (!o.ok) { row.error = 'open-fail'; row.detail = o.out.slice(0, 500); }
  else {
    await new Promise((r) => setTimeout(r, 4000));
    const s = cli('snapshot', '-i');
    row.snapshotStatus = s.ok;
    row.snapshot = (s.out || '').slice(0, 12000);
    const urls = [...new Set([...(s.out || '').matchAll(/https?:\/\/[^\s)"']{8,200}/g)].map((m) => m[0]))]
      .filter((u) => !/google\.com|gstatic\.com|schema\.org|w3\.org/.test(u)).slice(0, 12);
    row.results = urls.map((u) => ({ url: u }));
    row.count = urls.length;
    row.blocked = /unusual traffic|sorry|captcha|désolé/i.test(s.out || '') || urls.length === 0;
  }
  rows.push(row);
  await writeFile(`${outDir}/t-${q.name}.json`, JSON.stringify(row, null, 1).slice(0, 60000));
}
const st = cli('state', 'save', '.ab-state.json');
rows.push({ name: 'state-save', ok: st.ok });
await writeFile(`${outDir}/t-state-save.json`, JSON.stringify({ name: 'state-save', ok: st.ok, out: st.out.slice(0, 1000) }, null, 1));
await writeFile(`${outDir}/summary.json`, JSON.stringify({
  stamp, takenAt: new Date().toISOString(), leg: 'agent-browser',
  targets: rows.map((r) => ({ name: r.name, count: r.count ?? (r.ok ? 'ok' : 'fail') })),
}, null, 1));
console.log('ab-probe ok ' + rows.map((r) => `${r.name}=${r.count ?? (r.ok ? 'ok' : 'fail')}`).join(' '));
