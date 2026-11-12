// run-elite-detectors.mjs <targetDir> <outJson> — runs vendored D1-D5 over .sol sources.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as det from './elite-detectors.mjs';
const target = process.argv[2] || '.';
const outPath = process.argv[3] || 'elite-detectors.json';
const files = [];
(function walk(d){
  let ents; try { ents = readdirSync(d); } catch { return; }
  for (const e of ents){
    const p = join(d, e);
    let s; try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()){ if (/^(lib|node_modules|\.git|out|cache)$/i.test(e)) continue; walk(p); }
    else if (/\.sol$/i.test(e) && !/test|mock|script|deploy|fixture/i.test(p)) files.push(p);
  }
})(target);
const FNS = Object.entries(det).filter(([k, v]) => typeof v === 'function' && /^d[1-5]_/.test(k));
const hits = [];
const N = Math.min(files.length, 400);
for (let i = 0; i < N; i++){
  const f = files[i];
  let src = '';
  try { src = readFileSync(f, 'utf8'); } catch { continue; }
  for (const [name, fn] of FNS){
    let res = [];
    try { res = fn(src, f) || []; } catch { continue; }
    for (const h of res) hits.push({ detector: name, file: f, hit: String(h).slice(0, 300) });
  }
}
writeFileSync(outPath, JSON.stringify({ files: files.length, scanned: N, detectors: FNS.map(([k]) => k), hits }, null, 1));
console.log('elite-detectors: ' + hits.length + ' hits across ' + N + ' files');
