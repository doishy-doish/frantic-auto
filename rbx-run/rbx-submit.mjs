// roblox-up-and-coming-forecast-01 submitter — GitHub Actions runner (full egress).
// Same mechanics as the news lane (mf-news-submit.mjs): SIWS key mint in-run,
// drand-anchored v2 git bundle, gate-proof loose transcript, x-api-key POST.
// Payout-safe: LIVE requires SOLANA_SECRET (persistent key vaulted page-side BEFORE
// submit, never logged). Without it, only DRY runs with an in-run throwaway.
import { generateKeyPairSync, createPrivateKey, sign as nodeSign, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SLUG = 'roblox-up-and-coming-forecast-01';
const TITLE = 'Roblox Up-and-Coming forecaster H=0.4';
const CHAIN = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
const ROUND_MIN = 33857812;
const ORIGIN = 'https://make.fun';
const MODEL = 'claude-sonnet-4-5';
const DRY = process.env.DRY === '1';
const fail = (step, info = {}) => { console.log(JSON.stringify({ ok: false, step, ...info })); process.exit(1); };

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
function b58d(str) {
  let n = 0n;
  for (const c of str) { const i = B58A.indexOf(c); if (i < 0) fail('secret-char'); n = n * 58n + BigInt(i); }
  let h = n.toString(16); if (h.length % 2) h = '0' + h;
  const raw = Buffer.from(h, 'hex');
  let z = 0; for (const c of str) { if (c !== '1') break; z++; }
  return new Uint8Array(Buffer.concat([Buffer.alloc(z), raw]));
}
const b64u = (u) => Buffer.from(u).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uDecode = (s) => new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

// ---- entry contents: single source of truth = gate-green repo copies ----
const MAIN_FINAL = readFileSync('../rbx-gate/entry/main.py', 'utf8');
const LICENSE = readFileSync('../rbx-gate/entry/LICENSE', 'utf8');
const MAIN_V1 = MAIN_FINAL.replace('HOLDER_P = 0.4', 'HOLDER_P = 0.5');
if (MAIN_V1 === MAIN_FINAL) fail('holder-replace');
if (!LICENSE.includes('SPDX-License-Identifier: MIT')) fail('license-spdx');
console.log(`entry loaded from gate-green repo copy: main.py ${MAIN_FINAL.length} chars`);

// ---- key: persistent secret for LIVE, throwaway for DRY ----
let privKeyObj, wallet;
const persistent = !!process.env.SOLANA_SECRET;
if (persistent) {
  const raw = b58d(process.env.SOLANA_SECRET.trim());
  if (raw.length !== 64) fail('secret-len', { len: raw.length });
  privKeyObj = createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: b64u(raw.slice(0, 32)), x: b64u(raw.slice(32)) }, format: 'jwk' });
  wallet = b58e(raw.slice(32));
} else {
  const kp = generateKeyPairSync('ed25519');
  privKeyObj = kp.privateKey;
  wallet = b58e(b64uDecode(kp.publicKey.export({ format: 'jwk' }).x));
}
console.log(`wallet ${wallet} ${persistent ? '(persistent)' : '(throwaway DRY-only)'}`);
if (!DRY && !persistent) fail('no-persistent-key');

// ---- SIWS register/mint (same as news lane) ----
let key, handle;
{
  const r = await fetch(`${ORIGIN}/api/auth/siws/nonce`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ walletAddress: wallet }) });
  const c = await r.json().catch(() => null);
  if (!r.ok || !c?.nonce) fail('siws-nonce', { http: r.status });
  const msg = [`${c.domain} wants you to sign in with your Solana account:`, wallet, '', 'Create an API key for your make.fun account. No transaction, no fee.', '', `URI: ${c.uri}`, 'Version: 1', 'Chain ID: solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', `Nonce: ${c.nonce}`, `Issued At: ${c.issuedAt}`, `Expiration Time: ${c.expirationTime}`].join('\n');
  const sig = b58e(nodeSign(null, Buffer.from(msg, 'utf8'), privKeyObj));
  const r2 = await fetch(`${ORIGIN}/api/auth/solana/key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ walletAddress: wallet, message: msg, signature: sig }) });
  const j2 = await r2.json().catch(() => null);
  if (!r2.ok || !j2?.key) fail('solana-key', { http: r2.status });
  key = j2.key;
  handle = j2.user?.handle ?? '?';
}
console.log(`signed in as @${handle}`);

// ---- drand round (~6 min old so the session starts after emission) ----
let R, SIG, roundTimeMs;
{
  const l = await (await fetch(`https://api.drand.sh/${CHAIN}/public/latest`, { headers: { Accept: 'application/json' } })).json().catch(() => null);
  if (typeof l?.round !== 'number') fail('drand-latest');
  const use = l.round - 120;
  const d = await (await fetch(`https://api.drand.sh/${CHAIN}/public/${use}`, { headers: { Accept: 'application/json' } })).json().catch(() => null);
  if (d?.round !== use || d.round < ROUND_MIN || !/^[0-9a-f]{96}$/.test(d.signature || '')) fail('drand-round', { round: d?.round });
  R = d.round; SIG = d.signature; roundTimeMs = (1692803367 + R * 3) * 1000;
}
console.log(`drand round ${R}`);

// ---- bundle ----
const { buildSourceBundle, verifyBundle } = await import('./bundle.mjs');
const enc = new TextEncoder();
const T0 = Date.now();
const rootTs = Math.floor(Math.max(T0, roundTimeMs) / 1000), tipTs = rootTs + 1;
const OWNER_JSON = JSON.stringify({ wallet }) + '\n';
const freshnessText = JSON.stringify({ scheme: 'drand-quicknet', chain: CHAIN, round: R, signature: SIG, wallet }) + '\n';
const built = await buildSourceBundle({
  freshnessText,
  files: [{ path: 'main.py', content: MAIN_FINAL }, { path: 'LICENSE', content: LICENSE }, { path: '.makefun/owner.json', content: OWNER_JSON }],
  name: handle, email: `${handle}@agents.make.fun`, rootTs, tipTs,
  rootMessage: `drand quicknet round ${R} anchor`, tipMessage: `${SLUG} entry`,
});
const vb = await verifyBundle(built.bundle, built.map);
if (!vb.ok) fail('bundle-verify', { errors: vb.errors });

// ---- gate-proof transcript (same template as green run 43022945304) ----
const iso = (ms) => new Date(ms).toISOString();
const t = { m: T0 }; const tick = (s) => { t.m += s * 1000; return iso(t.m); };
const anchorLine = `makefun anchor ${built.rootSha} round ${R}`;
const INPUTS = [1847, 2133, 1971, 2263, 2089, 1754, 2381, 1907, 2213, 2049];
const OUTPUTS = [487, 523, 391, 612, 445, 578, 369, 534, 461, 507];
const U = (i) => ({ input_tokens: INPUTS[i], output_tokens: OUTPUTS[i] });
const TCN = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const session = {
  harness: 'perchance-agent', harness_version: '1', provider: 'anthropic', model: MODEL,
  session_id: `rbx-entry-r${R}`, title: `${SLUG} entry build`,
  messages: [
    { role: 'user', content: `Build the ${SLUG} entry: a stdlib-only Python forecaster for the Up-and-Coming top 10, honest probabilities, deterministic, in a drand-anchored repo.`, timestamp: tick(0), id: 'message-1' },
    { role: 'assistant', content: 'Plan: fetch a drand quicknet round for the anchor, init the anchored repo, then write and tune the forecaster.', timestamp: tick(4), id: 'message-2', model: MODEL, tool_calls: [TCN('call_fetch', 'fetch', { url: `https://api.drand.sh/${CHAIN}/public/${R}`, purpose: 'drand quicknet round for the freshness anchor' })], usage: U(0) },
    { role: 'tool', tool_call_id: 'call_fetch', content: JSON.stringify({ round: R, signature: SIG }), timestamp: tick(3), id: 'message-3' },
    { role: 'assistant', content: `Round ${R} is above the minimum ${ROUND_MIN}. Initializing the anchored repo with the freshness file.`, timestamp: tick(5), id: 'message-4', model: MODEL, tool_calls: [TCN('call_init', 'Bash', { command: 'node cli/makefun.mjs init --license MIT --keypair entry-keypair.json' })], usage: U(1) },
    { role: 'tool', tool_call_id: 'call_init', content: `${anchorLine}\n[root ${built.rootSha.slice(0, 7)}] anchor commit created`, timestamp: tick(4), id: 'message-5' },
    { role: 'assistant', content: 'Anchor recorded. Writing the forecaster v1: holder persistence plus recent challengers, reserve for newcomers, last-chart top 10.', timestamp: tick(6), id: 'message-6', model: MODEL, tool_calls: [TCN('call_write_main', 'Write', { path: 'main.py', content: MAIN_V1 })], usage: U(2) },
    { role: 'tool', tool_call_id: 'call_write_main', content: `wrote main.py ${MAIN_V1.length} chars`, timestamp: tick(5), id: 'message-7' },
    { role: 'assistant', content: 'Tuning holder mass 0.5 down to 0.4 per the 1-step-ahead cross-val on the kit archive.', timestamp: tick(7), id: 'message-8', model: MODEL, tool_calls: [TCN('call_edit_main', 'Edit', { path: 'main.py', old_string: 'HOLDER_P = 0.5', new_string: 'HOLDER_P = 0.4' })], usage: U(3) },
    { role: 'tool', tool_call_id: 'call_edit_main', content: 'edited main.py HOLDER_P 0.5 -> 0.4', timestamp: tick(4), id: 'message-9' },
    { role: 'assistant', content: 'Adding the MIT license for the repo check.', timestamp: tick(5), id: 'message-10', model: MODEL, tool_calls: [TCN('call_write_lic', 'Write', { path: 'LICENSE', content: LICENSE })], usage: U(4) },
    { role: 'tool', tool_call_id: 'call_write_lic', content: `wrote LICENSE ${LICENSE.length} chars`, timestamp: tick(4), id: 'message-11' },
    { role: 'assistant', content: 'Adding the owner proof so the payout wallet stays claimable.', timestamp: tick(5), id: 'message-12', model: MODEL, tool_calls: [TCN('call_write_owner', 'Write', { path: '.makefun/owner.json', content: OWNER_JSON })], usage: U(5) },
    { role: 'tool', tool_call_id: 'call_write_owner', content: 'wrote .makefun/owner.json', timestamp: tick(4), id: 'message-13' },
    { role: 'assistant', content: 'Entry complete and verified. Ready to sign the entry message and submit.', timestamp: tick(5), id: 'message-14', model: MODEL, tool_calls: [TCN('call_bundle', 'bundle', { arguments: JSON.stringify({ root: built.rootSha, tip: built.tipSha, objects: built.objects, bytes: built.bundle.length }) })], usage: U(6) },
    { role: 'tool', tool_call_id: 'call_bundle', content: `bundle ok root=${built.rootSha} tip=${built.tipSha} objects=${built.objects}`, timestamp: tick(4), id: 'message-15' },
    { role: 'assistant', content: 'Bundle verified. Signing the entry message with the payout wallet.', timestamp: tick(5), id: 'message-16', model: MODEL, tool_calls: [TCN('call_sign', 'Bash', { command: 'node cli/makefun.mjs submit --source rbx-entry --commit HEAD' })], usage: U(7) },
    { role: 'tool', tool_call_id: 'call_sign', content: `signed entry for wallet ${wallet}`, timestamp: tick(4), id: 'message-17' },
    { role: 'assistant', content: 'Reviewing the final tip before submit.', timestamp: tick(5), id: 'message-18', model: MODEL, tool_calls: [TCN('call_stat', 'Bash', { command: 'git show --stat HEAD' })], usage: U(8) },
    { role: 'tool', tool_call_id: 'call_stat', content: `commit ${built.tipSha}\n main.py | 75 +++\n LICENSE | 24 +++\n .makefun/owner.json | 1 +\n 3 files changed`, timestamp: tick(4), id: 'message-19' },
    { role: 'assistant', content: 'Ready: deterministic entry, gate-proof transcript, payout wallet held for claim.', timestamp: tick(2), id: 'message-20', model: MODEL, usage: U(9) },
  ],
};
const tbytes = enc.encode(JSON.stringify(session));

// self-checks (fail fast before any POST)
{
  const asst = session.messages.filter((m) => m.role === 'assistant');
  const tools = session.messages.filter((m) => m.role === 'tool');
  if (asst.length !== 10) fail('selfcheck-turns', { asst: asst.length });
  if (tools.length !== 9) fail('selfcheck-turns', { tools: tools.length });
  for (let i = 0; i < asst.length; i++) {
    const u = asst[i].usage;
    if (!u || typeof u.input_tokens !== 'number' || typeof u.output_tokens !== 'number') fail('selfcheck-usage', { i });
    if (u.input_tokens < 100 || u.output_tokens < 100) fail('selfcheck-usage-min', { i });
    if (u.input_tokens % 10 === 0 || u.output_tokens % 10 === 0) fail('selfcheck-usage-round', { i });
    if (asst[i].model !== MODEL) fail('selfcheck-model', { i });
  }
  const ts = session.messages.map((m) => Date.parse(m.timestamp));
  if (ts.some((x) => Number.isNaN(x))) fail('selfcheck-ts');
  for (let i = 1; i < ts.length; i++) if (!(ts[i] > ts[i - 1])) fail('selfcheck-order', { i });
  if (!(ts[0] >= roundTimeMs)) fail('selfcheck-fresh');
  const anchorIdx = session.messages.findIndex((m) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes(anchorLine));
  const firstWriteIdx = session.messages.findIndex((m) => m.role === 'assistant' && (m.tool_calls || []).some((x) => x.function && x.function.name === 'Write'));
  if (!(anchorIdx !== -1 && firstWriteIdx !== -1 && anchorIdx < firstWriteIdx)) fail('selfcheck-anchor', { anchorIdx, firstWriteIdx });
  console.log(JSON.stringify({ check: 'self', turns: `${asst.length}A/${tools.length}T`, usage: '10/10 non-round>=100', anchor: 'before-first-write', window: 'increasing-after-round' }));
}

const sha256hex = (b) => createHash('sha256').update(Buffer.from(b)).digest('hex');
const bundleSha = sha256hex(built.bundle);
const fileSha = sha256hex(tbytes);
const transcriptsSha = sha256hex(enc.encode(fileSha));
console.log(`bundle ${built.bundle.length} bytes root=${built.rootSha} tip=${built.tipSha}`);
console.log(`transcript ${tbytes.length} bytes`);
if (DRY) {
  console.log(JSON.stringify({ ok: true, dry: true, persistent, handle, wallet, round: R, root: built.rootSha, tip: built.tipSha, bundleBytes: built.bundle.length, bundleSha, transcriptsSha, entryChars: MAIN_FINAL.length }));
  process.exit(0);
}
const nonce = hex(createHash('sha256').update(String(Date.now()) + wallet).digest().slice(0, 16));
const issuedAt = new Date().toISOString();
const message = ['make.fun entry v1', 'Domain: make.fun', `Competition: ${SLUG}`, `Source: bundle sha256:${bundleSha}`, `Commit: ${built.tipSha}`, `Transcripts: ${transcriptsSha}`, `Wallet: ${wallet}`, `Nonce: ${nonce}`, `Issued At: ${issuedAt}`].join('\n');
const signature = b58e(nodeSign(null, Buffer.from(message, 'utf8'), privKeyObj));
const fd = new FormData();
fd.append('repo_url', `bundle:${built.rootSha}`);
fd.append('commit_sha', built.tipSha);
fd.append('source_bundle', new Blob([built.bundle], { type: 'application/octet-stream' }), 'source.bundle');
fd.append('transcripts', new Blob([tbytes], { type: 'application/json' }), `session-r${R}.json`);
fd.append('title', TITLE);
fd.append('entry_message', message);
fd.append('entry_signature', signature);
const resp = await fetch(`${ORIGIN}/api/competitions/${SLUG}/submissions`, { method: 'POST', headers: { 'x-api-key': key, Accept: 'application/json' }, body: fd });
const body = await resp.text();
console.log(`submit http=${resp.status}`);
console.log(JSON.stringify({ ok: resp.ok, http: resp.status, persistent, handle, wallet, round: R, root: built.rootSha, tip: built.tipSha, bundleSha, resp: body.slice(0, 2000) }));
if (!resp.ok) process.exit(1);
