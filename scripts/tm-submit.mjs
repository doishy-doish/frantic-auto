// tm-submit: relay-replacement TM writer. Phase-split because keys-msg needs artifactKey.
// Phase=upload: POST request-upload-url (signed upload-msg) -> PUT bytes -> print artifactKey.
// Phase=submit: POST from-keys (signed keys-msg) -> print submissionId.
// Sigs are message-bound + short-lived (page-signed, key never leaves operator page).
// Inputs pass via dispatch (never committed). Quiet logs: counts/ids only, no bodies.
const API = 'https://api.taskmarket.dev';
const TASK = process.env.TASK;
const PHASE = process.env.PHASE || 'upload';
const WORKER = (process.env.WORKER || '').trim();
const IDEM = process.env.IDEMKEY || '';
const j = (o) => JSON.stringify(o);
async function post(path, body, idem) {
  const r = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Taskmarket-Idempotency-Key': idem }, body: j(body) });
  const t = await r.text();
  return { status: r.status, body: t };
}
if (PHASE === 'upload') {
  const exp = parseInt(process.env.EXP || '0', 10);
  const content = Buffer.from(process.env.FILEB64 || '', 'base64');
  const r = await post(`/api/tasks/${TASK}/submissions/request-upload-url`, {
    workerAddress: WORKER, signature: process.env.UPSIG, fileName: process.env.FILENAME,
    mimeType: process.env.MIMETYPE, sizeBytes: content.length, expiresAt: exp,
  }, IDEM);
  console.log('upload-req status=' + r.status);
  if (r.status !== 200) { console.log(r.body.slice(0, 300)); process.exit(1); }
  const u = JSON.parse(r.body);
  const putUrl = u.uploadUrl || u.url;
  const artKey = u.artifactKey || u.key;
  if (!putUrl || !artKey) { console.log('missing uploadUrl/artifactKey'); process.exit(1); }
  const rp = await fetch(putUrl, { method: 'PUT', headers: { 'Content-Type': process.env.MIMETYPE }, body: content });
  console.log('r2-put status=' + rp.status + ' artifactKey=' + String(artKey).slice(0, 24) + '...');
  if (!rp.ok) process.exit(1);
  console.log('ARTIFACTKEY=' + artKey);
} else {
  const artKey = process.env.ARTKEY;
  const meta = JSON.parse(process.env.ARTMETA || '{}');
  const r = await post(`/api/tasks/${TASK}/submissions/from-keys`, {
    workerAddress: WORKER,
    artifacts: [{ artifactKey: artKey, fileName: process.env.FILENAME, mimeType: process.env.MIMETYPE, role: 'final', sizeBytes: meta.size, sha256Hash: meta.sha256, keccak256Hash: meta.keccak }],
    signature: process.env.KEYSIG,
  }, IDEM);
  console.log('fromkeys status=' + r.status);
  console.log(r.body.slice(0, 500));
}
