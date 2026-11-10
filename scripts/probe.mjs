// probe: READ-ONLY Frantic auth check + bounty-146 contract reveal. NEVER claims.
// Env: FRANTIC_BASE, FRANTIC_AGENT_KID, SCRAMBLE_KEY, WRAP_PATH.
import { readFileSync } from "node:fs";
import { createDecipheriv, createHash } from "node:crypto";
const BASE = process.env.FRANTIC_BASE || "https://gofrantic.com";
const KID = process.env.FRANTIC_AGENT_KID || "agent-4bc19b";
const WRAP = process.env.WRAP_PATH || "keys/frantic-token-rot.json";
function dec(w, keyHex) {
  if (!w || w.enc !== "AES-256-GCM-v1") throw new Error("not a scramble wrapper");
  const key = Buffer.from(keyHex, "hex");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(w.nonce, "base64"));
  d.setAuthTag(Buffer.from(w.tag, "base64"));
  const plain = Buffer.concat([d.update(Buffer.from(w.data, "base64")), d.final()]);
  if (w.sha256 && createHash("sha256").update(plain).digest("hex") !== w.sha256) throw new Error("sha256 mismatch");
  return plain.toString("utf8");
}
const keyHex = (process.env.SCRAMBLE_KEY || "").trim().toLowerCase();
if (!/^[0-9a-f]{64}$/.test(keyHex)) throw new Error("no valid SCRAMBLE_KEY");
const token = (JSON.parse(dec(JSON.parse(readFileSync(WRAP, "utf8")), keyHex)).token || "").trim();
if (!token) throw new Error("wrapper held no .token");
console.log("::add-mask::" + token);
async function api(p) {
  const r = await fetch(BASE + p, { headers: { Accept: "application/json", "User-Agent": "frantic-auto-actions/1.0", Authorization: "Bearer " + token } });
  return { status: r.status, body: await r.text() };
}
const out = {};
const st = await api("/v1/agents/" + KID + "/status");
out.status = { http: st.status, ok: st.status === 200 };
if (st.status === 200) { try { const s = JSON.parse(st.body); out.agent = { eligible: s.eligibility ?? s.claimEligibility ?? null, paid: s.paidBounties ?? null }; } catch {} }
const b = await api("/v1/bounties/146");
out.b146http = b.status;
try {
  const x = JSON.parse(b.body).bounty;
  out.b146 = { posting: x.posting_status, work: x.work_status, slots: x.claim_progress, claimWindow: x.claim_window_minutes, artifacts: (x.delivery_contract || {}).artifacts || [], routes: x.completion_routes || [], checks: (x.delivery_contract || {}).review_checks || [] };
} catch { out.b146note = b.body.slice(0, 200); }
import { writeFileSync } from "node:fs";
writeFileSync("probe-out.json", JSON.stringify(out, null, 1));
console.log(JSON.stringify(out));
