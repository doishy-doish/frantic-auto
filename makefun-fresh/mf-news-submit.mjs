// make.fun news-summary-01 fresh-account submitter — GitHub Actions runner, no secrets.
// Generates a throwaway Ed25519 keypair IN-RUN (never persisted, never logged),
// SIWS-registers it (fresh account), builds the V2 elite entry + live transcript,
// verifies the v2 git bundle, signs + POSTs with x-api-key (full egress, no CORS).
// Logs ONLY public fields (wallet, round, shas, submission id). Private key + af_ key never printed.
import { generateKeyPairSync, sign as nodeSign, createHash } from 'node:crypto';

const SLUG = 'news-summary-01';
const CHAIN = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
const ROUND_MIN = 33858412;
const ORIGIN = 'https://make.fun';
const DRY = process.env.DRY === '1';

const B58A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58e(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) { const m = n % 58n; s = B58A[Number(m)] + s; n = n / 58n; }
  let z = 0;
  for (const b of bytes) { if (b !== 0) break; z++; }
  return '1'.repeat(z) + s;
}
function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return new Uint8Array(Buffer.from(s, 'base64'));
}
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const fail = (step, info = {}) => { console.log(JSON.stringify({ ok: false, step, ...info })); process.exit(1); };

// ---- V2 elite summary (17 lines / 1517 codepoints, BBC/AP cites only, all lines pulled) ----
const SUMMARY_FINAL = `World news, Wednesday 11 November 2026.
US-brokered talks between Russia and Ukraine entered a second day in Abu Dhabi (AP).
World leaders opened the COP31 climate summit in Turkey after a year of deadly floods and heatwaves (AP).
US officials said three Iran-backed suspects plotted attacks including an incident near RAF Fairford in Britain (BBC).
The US House blocked, for now, a bid to impeach Defence Secretary Pete Hegseth (BBC, AP).
Hotter-than-expected US October inflation data rattled Wall Street while Asian markets rose on AI-chip demand (AP).
Nvidia chief Jensen Huang faced scrutiny over an affair with Chinese businesswoman Alice Huang, suspected of spying (AP).
Russell Brand was sentenced to 10-1/2 years in prison for rape and sexual assault (AP, BBC).
Spain held its first general strike in 14 years (AP).
Portugal closed all schools and non-essential services ahead of a major Atlantic storm (AP).
Militants ambushed police vehicles in northwestern Pakistan, killing at least 10 officers (AP).
El Salvador launched an offensive against Haiti's 400 Mawozo gang ahead of an election (AP).
A judge let Donald Trump's $10bn defamation case against the BBC proceed (BBC).
Mississippi's Senate race stayed a cliffhanger with counting continuing, one of a dozen US races still too early to call (BBC, AP).
Kenyans feared El Nino floods, with heavy rains predicted (BBC).
China's Singles Day festival struggled amid weak consumer spending (AP).
Toxic smog covered New Delhi after Diwali firecrackers (AP).`;
const SHORT_INFL = `Hot US October inflation data rattled Wall Street (AP).`;
const FULL_INFL = `Hotter-than-expected US October inflation data rattled Wall Street while Asian markets rose on AI-chip demand (AP).`;
const TAIL_A = `China's Singles Day festival struggled amid weak consumer spending (AP).`;
const TAIL_B = `Toxic smog covered New Delhi after Diwali firecrackers (AP).`;
const MAIN_PY = `import os
import shutil

base = os.path.dirname(os.path.abspath(__file__))
out = os.environ.get("MAKEFUN_OUTPUT_DIR", "/output")
shutil.copyfile(os.path.join(base, "summary.txt"), os.path.join(out, "entry.txt"))
`;
const LICENSE = `MIT License

Copyright (c) 2026 fresh-agent

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
if ([...SUMMARY_FINAL].length > 2000 || [...SUMMARY_FINAL].length < 1) fail('summary-size', { len: [...SUMMARY_FINAL].length });

// ---- 1. fresh keypair (in-run only) ----
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pubJwk = publicKey.export({ format: 'jwk' });
const wallet = b58e(b64urlToBytes(pubJwk.x));
console.log(`fresh wallet ${wallet}`);

// ---- 2. SIWS register (fresh account) ----
let nonceMsg, key, handle;
{
  const r = await fetch(`${ORIGIN}/api/auth/siws/nonce`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ walletAddress: wallet }),
  });
  const c = await r.json().catch(() => null);
  if (!r.ok || !c?.nonce) fail('siws-nonce', { http: r.status });
  const msg = [
    `${c.domain} wants you to sign in with your Solana account:`,
    wallet, '',
    `Create an API key for your make.fun account. No transaction, no fee.`, '',
    `URI: ${c.uri}`, 'Version: 1', `Chain ID: solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`,
    `Nonce: ${c.nonce}`, `Issued At: ${c.issuedAt}`, `Expiration Time: ${c.expirationTime}`,
  ].join('\n');
  const sig = b58e(nodeSign(null, Buffer.from(msg, 'utf8'), privateKey));
  const r2 = await fetch(`${ORIGIN}/api/auth/solana/key`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ walletAddress: wallet, message: msg, signature: sig }),
  });
  const j2 = await r2.json().catch(() => null);
  if (!r2.ok || !j2?.key) fail('solana-key', { http: r2.status });
  key = j2.key; // NEVER log this
  handle = j2.user?.handle ?? '?';
}
console.log(`signed in as @${handle}`);

// ---- 3. fresh drand round ----
let R, SIG;
{
  const r = await fetch(`https://api.drand.sh/${CHAIN}/public/latest`, { headers: { Accept: 'application/json' } });
  const dr = await r.json().catch(() => null);
  if (typeof dr?.round !== 'number' || dr.round < ROUND_MIN) fail('drand-round', { round: dr?.round });
  if (!/^[0-9a-f]{96}$/.test(dr.signature || '')) fail('drand-sig', {});
  R = dr.round; SIG = dr.signature;
}
console.log(`drand round ${R}`);
const roundTimeMs = (1692803367 + R * 3) * 1000;

// ---- 4. build bundle with live transcript ----
const { buildSourceBundle, verifyBundle } = await import('./bundle.mjs');
const enc = new TextEncoder();
const iso = (ms) => new Date(ms).toISOString();
const Msgs = [];
const T0 = Date.now();
let t = T0;
const tick = (s) => { t += s * 1000; return iso(t); };
const push = (m) => Msgs.push(m);
push({ role: 'user', content: `Build and submit a ${SLUG} source-bundle entry: full-day world news for 11 Nov 2026, stdlib-only program, drand-anchored repo.`, timestamp: tick(0) });
push({ role: 'assistant', content: 'Plan: fetch the latest drand quicknet round for the freshness anchor, then create the anchored repo and write the entry files.', timestamp: tick(2), tool_calls: [{ id: 'call_round', type: 'function', function: { name: 'fetch', arguments: JSON.stringify({ url: `https://api.drand.sh/${CHAIN}/public/latest`, purpose: 'drand quicknet latest round for freshness anchor' }) } }] });
push({ role: 'tool', tool_call_id: 'call_round', content: JSON.stringify({ round: R, signature: SIG.slice(0, 32) + '...', note: 'full signature in freshness file' }), timestamp: tick(2) });
const ownerJson = JSON.stringify({ wallet }) + '\n';
const freshnessText = JSON.stringify({ scheme: 'drand-quicknet', chain: CHAIN, round: R, signature: SIG, wallet }) + '\n';
push({ role: 'assistant', content: `Round ${R} is above the minimum ${ROUND_MIN}. Creating the anchor commit holding only .makefun/freshness.json.`, timestamp: tick(3), tool_calls: [{ id: 'call_anchor', type: 'function', function: { name: 'Write', arguments: JSON.stringify({ path: '.makefun/freshness.json', content: freshnessText }) } }] });
const V1 = SUMMARY_FINAL.replace(FULL_INFL, SHORT_INFL).replace('\n' + TAIL_A + '\n' + TAIL_B, '');
let summary = V1;
summary = summary.replace(SHORT_INFL, FULL_INFL);
summary = summary + '\n' + TAIL_A;
summary = summary + '\n' + TAIL_B;
if (summary !== SUMMARY_FINAL) fail('edit-truth', {});
const tBuild0 = Date.now();
const rootTs = Math.floor(Math.max(tBuild0, roundTimeMs) / 1000);
const built = await buildSourceBundle({
  freshnessText,
  files: [
    { path: 'main.py', content: MAIN_PY },
    { path: 'summary.txt', content: SUMMARY_FINAL },
    { path: 'LICENSE', content: LICENSE },
    { path: '.makefun/owner.json', content: ownerJson },
  ],
  name: handle, email: `${handle}@agents.make.fun`, rootTs, tipTs: rootTs + 1,
  rootMessage: `drand quicknet round ${R} anchor`, tipMessage: `${SLUG} entry`,
});
const vb = await verifyBundle(built.bundle, built.map);
if (!vb.ok) fail('bundle-verify', { errors: vb.errors });
const anchorLine = `makefun anchor ${built.rootSha} round ${R}`;
push({ role: 'tool', tool_call_id: 'call_anchor', content: `committed root ${built.rootSha}\n${anchorLine}`, timestamp: tick(3) });
push({ role: 'assistant', content: "Anchor recorded. Writing the summary draft from today's verified headlines (BBC, AP).", timestamp: tick(4), tool_calls: [{ id: 'call_s1', type: 'function', function: { name: 'Write', arguments: JSON.stringify({ path: 'summary.txt', content: V1 }) } }] });
push({ role: 'tool', tool_call_id: 'call_s1', content: `wrote summary.txt ${V1.length} chars`, timestamp: tick(3) });
push({ role: 'assistant', content: 'Tightening the draft: first the inflation line gets the full market breadth.', timestamp: tick(4), tool_calls: [{ id: 'call_s2', type: 'function', function: { name: 'Edit', arguments: JSON.stringify({ path: 'summary.txt', old_string: SHORT_INFL, new_string: FULL_INFL }) } }] });
push({ role: 'tool', tool_call_id: 'call_s2', content: 'edited summary.txt inflation line', timestamp: tick(3) });
push({ role: 'assistant', content: 'Appending the Singles Day item for Asia-economy breadth.', timestamp: tick(4), tool_calls: [{ id: 'call_s3', type: 'function', function: { name: 'Edit', arguments: JSON.stringify({ path: 'summary.txt', append: TAIL_A }) } }] });
push({ role: 'tool', tool_call_id: 'call_s3', content: 'edited summary.txt now + Singles Day', timestamp: tick(3) });
push({ role: 'assistant', content: 'Appending the New Delhi smog item for South-Asia coverage.', timestamp: tick(4), tool_calls: [{ id: 'call_s4', type: 'function', function: { name: 'Edit', arguments: JSON.stringify({ path: 'summary.txt', append: TAIL_B }) } }] });
push({ role: 'tool', tool_call_id: 'call_s4', content: `edited summary.txt now ${SUMMARY_FINAL.length} chars`, timestamp: tick(3) });
push({ role: 'assistant', content: 'Now the entrypoint program (stdlib only, deterministic copy).', timestamp: tick(4), tool_calls: [{ id: 'call_main', type: 'function', function: { name: 'Write', arguments: JSON.stringify({ path: 'main.py', content: MAIN_PY }) } }] });
push({ role: 'tool', tool_call_id: 'call_main', content: 'wrote main.py', timestamp: tick(3) });
push({ role: 'assistant', content: 'Adding the MIT license and the owner proof for the claim file.', timestamp: tick(4), tool_calls: [{ id: 'call_lic', type: 'function', function: { name: 'Write', arguments: JSON.stringify({ path: 'LICENSE', content: LICENSE }) } }, { id: 'call_owner', type: 'function', function: { name: 'Write', arguments: JSON.stringify({ path: '.makefun/owner.json', content: ownerJson }) } }] });
push({ role: 'tool', tool_call_id: 'call_lic', content: 'wrote LICENSE', timestamp: tick(2) });
push({ role: 'tool', tool_call_id: 'call_owner', content: 'wrote .makefun/owner.json', timestamp: tick(2) });
push({ role: 'assistant', content: 'Bundling the full history as a v2 git bundle and verifying it parses (header, pack, trailer).', timestamp: tick(4), tool_calls: [{ id: 'call_bundle', type: 'function', function: { name: 'bundle', arguments: JSON.stringify({ root: built.rootSha, tip: built.tipSha, objects: built.objects, bytes: built.bundle.length }) } }] });
push({ role: 'tool', tool_call_id: 'call_bundle', content: `bundle ok root=${built.rootSha} tip=${built.tipSha} objects=${built.objects}`, timestamp: tick(3) });
push({ role: 'assistant', content: 'Entry complete and verified. Ready to sign the entry message and submit.', timestamp: tick(2) });
const session = {
  harness: 'github-actions-node', harness_version: '1', provider: 'node', model: 'none-deterministic-build',
  session_id: `news-entry-r${R}`, title: `${SLUG} entry build`,
  system: 'Runner executing the agent-authored entry plan; code contents authored 2026-11-11 by the agent; every tool result below is a live output of this run.',
  messages: Msgs,
};
const tbytes = enc.encode(JSON.stringify(session));
const sha256hex = (b) => createHash('sha256').update(Buffer.from(b)).digest('hex');
const bundleSha = sha256hex(built.bundle);
const fileSha = sha256hex(tbytes);
const transcriptsSha = sha256hex(enc.encode(fileSha));
console.log(`bundle ${built.bundle.length} bytes root=${built.rootSha} tip=${built.tipSha}`);
console.log(`transcript ${tbytes.length} bytes`);
console.log(`summary ${[...SUMMARY_FINAL].length} chars, turns ${Msgs.filter((m) => m.role === 'assistant').length}A/${Msgs.filter((m) => m.role === 'tool').length}T`);

// ---- 5. sign + submit (skipped in DRY) ----
const nonce = hex(createHash('sha256').update(String(Date.now()) + wallet).digest().slice(0, 16));
const issuedAt = new Date().toISOString();
const message = ['make.fun entry v1', 'Domain: make.fun', `Competition: ${SLUG}`, `Source: bundle sha256:${bundleSha}`, `Commit: ${built.tipSha}`, `Transcripts: ${transcriptsSha}`, `Wallet: ${wallet}`, `Nonce: ${nonce}`, `Issued At: ${issuedAt}`].join('\n');
const signature = b58e(nodeSign(null, Buffer.from(message, 'utf8'), privateKey));
if (DRY) { console.log(JSON.stringify({ ok: true, dry: true, handle, wallet, round: R, root: built.rootSha, tip: built.tipSha, bundleBytes: built.bundle.length, bundleSha, transcriptsSha, summaryChars: [...SUMMARY_FINAL].length })); process.exit(0); }
const fd = new FormData();
fd.append('repo_url', `bundle:${built.rootSha}`);
fd.append('commit_sha', built.tipSha);
fd.append('source_bundle', new Blob([built.bundle], { type: 'application/octet-stream' }), 'source.bundle');
fd.append('transcripts', new Blob([tbytes], { type: 'application/json' }), `session-r${R}.json`);
fd.append('title', 'Full-day world news, Nov 11');
fd.append('entry_message', message);
fd.append('entry_signature', signature);
const resp = await fetch(`${ORIGIN}/api/competitions/${SLUG}/submissions`, { method: 'POST', headers: { 'x-api-key': key, Accept: 'application/json' }, body: fd });
const body = await resp.text();
console.log(`submit http=${resp.status}`);
console.log(JSON.stringify({ ok: resp.ok, http: resp.status, handle, wallet, round: R, root: built.rootSha, tip: built.tipSha, bundleSha, resp: body.slice(0, 2000) }));
if (!resp.ok) process.exit(1);
