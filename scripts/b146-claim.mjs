import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createDecipheriv, createCipheriv, createHash, randomBytes } from 'node:crypto';
const BASE = process.env.FRANTIC_BASE || 'https://gofrantic.com';
const KID = process.env.FRANTIC_AGENT_KID || 'agent-4bc19b';
const WRAP = process.env.WRAP_PATH || 'keys/frantic-token-rot.json';
function dec(w, keyHex) {
  const d = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(w.nonce, 'base64'));
  d.setAuthTag(Buffer.from(w.tag, 'base64'));
  const plain = Buffer.concat([d.update(Buffer.from(w.data, 'base64')), d.final()]);
  if (w.sha256 && createHash('sha256').update(plain).digest('hex') !== w.sha256) throw new Error('sha256 mismatch');
  return plain.toString('utf8');
}
function enc(plain, keyHex) {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), nonce);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { enc: 'AES-256-GCM-v1', nonce: nonce.toString('base64'), data: ct.toString('base64'), tag: c.getAuthTag().toString('base64'), sha256: createHash('sha256').update(plain).digest('hex'), bytes: plain.length, date: new Date().toISOString().slice(0, 10) };
}
const keyHex = (process.env.SCRAMBLE_KEY || '').trim().toLowerCase();
const token = (JSON.parse(dec(JSON.parse(readFileSync(WRAP, 'utf8')), keyHex)).token || '').trim();
if (!token) throw new Error('no token');
console.log('::add-mask::' + token);
async function api(p, body) {
  const h = { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'frantic-auto-actions/1.0', Authorization: 'Bearer ' + token };
  const r = await fetch(BASE + p, { method: body ? 'POST' : 'GET', headers: h, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(p + ' -> ' + r.status + ': ' + t.slice(0, 300));
  return JSON.parse(t);
}
const claim = await api('/v1/claims', { bounty: 146, agent_kid: KID, agent_token: token });
const claimId = claim.claim_id || (claim.claim && claim.claim.id);
if (!claimId) throw new Error('no claim_id in claim response');
const sealed = enc(Buffer.from(JSON.stringify({ claimId, fuse: claim.fuse_expires_at || (claim.claim && claim.claim.fuse_expires_at) || null, brief: claim.brief ?? (claim.claim && claim.claim.brief) ?? null, eligibility: claim.eligibility ?? null, at: new Date().toISOString() })), keyHex);
mkdirSync('evidence', { recursive: true });
writeFileSync('evidence/b146-claim.json.enc', JSON.stringify(sealed, null, 1) + '\n');
console.log(JSON.stringify({ held: true, claimId }));
