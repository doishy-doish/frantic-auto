// logpeek: read a workflow run's logs WITHOUT operator clicks.
// Runner has full egress: downloads the log archive with a dispatch-passed
// token, unzips with node:zlib, greps status lines, commits evidence/logpeek/.
// Token travels dispatch-only, never committed, never logged. Evidence holds
// ONLY the grepped status lines (ARTIFACTKEY=, upload-req status=, fromkeys
// status=) — grep output is allowlisted line-by-line before write.
import { writeFile, mkdir } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

const RUN = (process.env.RUN_ID || '').trim();
const TOKEN = (process.env.LOGT || '').trim();
const STAMP = (process.env.STAMP || RUN).replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 60) || 'run';
if (!RUN || !TOKEN) { console.log('need RUN_ID + LOGT'); process.exit(1); }

const outDir = `evidence/logpeek/${STAMP}`;
await mkdir(outDir, { recursive: true });

const r = await fetch(`https://api.github.com/repos/doishy-doish/frantic-auto/actions/runs/${RUN}/logs`, {
  headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'doishy-doish' },
  redirect: 'follow',
});
if (r.status !== 200) { console.log('logs-http=' + r.status); process.exit(1); }
const zip = Buffer.from(await r.arrayBuffer());

// minimal zip walk (stored + deflated entries) — avoids heavy deps.
const out = {};
try {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.length);
  let off = 0;
  while (off + 30 < zip.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const csize = dv.getUint32(off + 18, true);
    const nlen = dv.getUint16(off + 26, true);
    const elen = dv.getUint16(off + 28, true);
    const name = zip.toString('utf8', off + 30, off + 30 + nlen);
    const start = off + 30 + nlen + elen;
    const data = zip.subarray(start, start + csize);
    out[name] = method === 0 ? data : inflateSync(data);
    off = start + csize;
  }
} catch (e) {
  console.log('unzip-fail bytes=' + zip.length);
  process.exit(1);
}

const names = Object.keys(out);
const keep = [];
for (const n of names) {
  const txt = out[n].toString('utf8');
  const hits = txt.split('\n').filter((l) => /ARTIFACTKEY=|upload-req status=|fromkeys(\[\d+\])? status=|submissionId/i.test(l)).slice(0, 40);
  if (hits.length) keep.push('### ' + n + '\n' + hits.join('\n'));
}
await writeFile(`${outDir}/keys.txt`, keep.join('\n\n').slice(0, 8000) || 'NO_MATCHING_LINES');
await writeFile(`${outDir}/summary.json`, JSON.stringify({ run: RUN, files: names.length, matched: keep.length, at: new Date().toISOString() }));
console.log('logpeek ok files=' + names.length + ' matched=' + keep.length);
