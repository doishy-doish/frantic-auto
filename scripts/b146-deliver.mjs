import { readFileSync } from 'node:fs';
import { createDecipheriv, createHash } from 'node:crypto';
const BASE = process.env.FRANTIC_BASE || 'https://gofrantic.com';
const KID = process.env.FRANTIC_AGENT_KID || 'agent-4bc19b';
const WRAP = process.env.WRAP_PATH || 'keys/frantic-token-rot.json';
const CLAIM_ID = (process.env.CLAIM_ID || '').trim();
const RECEIPT_REF = (process.env.RECEIPT_REF || '').trim();
const REPORT_URL = (process.env.REPORT_URL || '').trim();
if (!CLAIM_ID) throw new Error('missing CLAIM_ID');
if (!RECEIPT_REF) throw new Error('missing RECEIPT_REF');
if (!REPORT_URL) throw new Error('missing REPORT_URL');
function dec(w, keyHex) {
  const d = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(w.nonce, 'base64'));
  d.setAuthTag(Buffer.from(w.tag, 'base64'));
  const plain = Buffer.concat([d.update(Buffer.from(w.data, 'base64')), d.final()]);
  if (w.sha256 && createHash('sha256').update(plain).digest('hex') !== w.sha256) throw new Error('sha256 mismatch');
  return plain.toString('utf8');
}
const keyHex = (process.env.SCRAMBLE_KEY || '').trim().toLowerCase();
const token = (JSON.parse(dec(JSON.parse(readFileSync(WRAP, 'utf8')), keyHex)).token || '').trim();
if (!token) throw new Error('no token');
console.log('::add-mask::' + token);
async function api(p, body) {
  const h = { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'frantic-auto-actions/1.0', Authorization: 'Bearer ' + token };
  const r = await fetch(BASE + p, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(p + ' -> ' + r.status + ': ' + t.slice(0, 400));
  return JSON.parse(t);
}
const refs = ['receipt_ref=' + RECEIPT_REF, 'report=' + REPORT_URL].slice(0, 20);
console.log(JSON.stringify({ claimId: CLAIM_ID, refs: refs.length }));
const pre = await api('/v1/deliveries/preflight', { claim_id: CLAIM_ID, agent_token: token, artifact_refs: refs });
console.log(JSON.stringify({ preflight_ok: pre.ok, errors: (pre.errors || pre.blockers || []).slice(0, 5), warnings: (pre.warnings || []).slice(0, 5) }));
if (pre.ok === false) throw new Error('preflight refused: ' + JSON.stringify(pre.errors || pre.blockers || pre.missing || pre).slice(0, 300));
const d = await api('/v1/deliveries', { claim_id: CLAIM_ID, agent_kid: KID, agent_token: token, artifact_refs: refs });
console.log(JSON.stringify({ delivered: true, delivery: d.delivery_id || d.id || null }));
