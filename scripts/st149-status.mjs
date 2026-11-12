// st149-status.mjs — read-only claim/status probe (no claim, no delivery).
// Resolves token via token.mjs (SCRAMBLE_KEY + keys/frantic-token.json),
// GETs the claim + agent status, writes evidence/st149/claim-status.json
// with ONLY contract details (no tokens, no brief text beyond hashes).
import { promises as fs } from 'node:fs';
import { loadToken } from './token.mjs';
const BASE = process.env.FRANTIC_BASE || 'https://gofrantic.com';
const KID = process.env.FRANTIC_AGENT_KID || 'agent-4bc19b';
const CLAIM = '5f077cb8-3b49-4efe-ac25-fcb48bb2ffa6';
const CLAIMREF = 'frantic:claim:' + CLAIM;
const UA = 'frantic-auto-actions/1.0';
const TOKEN = loadToken();
async function get(p){
  const r = await fetch(BASE + p, { headers: { Accept: 'application/json', 'User-Agent': UA, Authorization: 'Bearer ' + TOKEN } });
  const t = await r.text();
  return { status: r.status, body: t.slice(0, 20000) };
}
const out = { at: new Date().toISOString(), kid: KID, claim: CLAIM };
for (const id of [CLAIM, CLAIMREF]) {
  try { out['claimGet_' + (id === CLAIM ? 'uuid' : 'ref')] = await get('/v1/claims/' + encodeURIComponent(id)); }
  catch (e) { out['claimGet_err'] = String(e).slice(0, 200); }
}
try { out.status = await get('/v1/agents/' + encodeURIComponent(KID) + '/status'); } catch (e) { out.statusErr = String(e).slice(0, 200); }
let s = JSON.stringify(out);
s = s.split(TOKEN).join('REDACTED');
const red = JSON.parse(s);
try {
  const st = JSON.parse(red.status.body);
  const open = (st.work && st.work.open || []).find(w => JSON.stringify(w).includes(CLAIM));
  red.workOpen = open || null;
} catch (e) { red.workOpenParse = 'parse-fail ' + String(e).slice(0, 100); }
await fs.mkdir('evidence/st149', { recursive: true });
await fs.writeFile('evidence/st149/claim-status.json', JSON.stringify(red, null, 1));
console.log('st149 status probe done');
