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
console.log('zip-bytes=' + zip.length);

// central-directory walk (handles data-descriptor entries GitHub emits).
const out = {};
try {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.length);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no-eocd');
  const cdCount = dv.getUint16(eocd + 10, true);
  let cdOff = dv.getUint32(eocd + 16, true);
  for (let k = 0; k < cdCount; k++) {
    if (dv.getUint32(cdOff, true) !== 0x02014b50) throw new Error('bad-cd');
    const method = dv.getUint16(cdOff + 10, true);
    const csize = dv.getUint32(cdOff + 20, true);
    const nlen = dv.getUint16(cdOff + 28, true);
    const elen = dv.getUint16(cdOff + 30, true);
    const clen = dv.getUint16(cdOff + 32, true);
    const lho = dv.getUint32(cdOff + 42, true);
    const name = zip.toString('utf8', cdOff + 46, cdOff + 46 + nlen);
    const lhoNlen = dv.getUint16(lho + 26, true);
    const lhoElen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lhoNlen + lhoElen;
    const data = zip.subarray(start, start + csize);
    if (!name.endsWith('/')) out[name] = method === 0 ? data : inflateSync(data);
    cdOff += 46 + nlen + elen + clen;
  }
} catch (e) {
  console.log('unzip-fail bytes=' + zip.length + ' err=' + String(e).slice(0, 80));
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
