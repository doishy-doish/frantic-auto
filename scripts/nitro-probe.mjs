// nitro-probe: READ-ONLY Nitrosend key + sender check. Never sends.
import { readFileSync, writeFileSync } from "node:fs";
import { createDecipheriv, createHash } from "node:crypto";
function dec(w, keyHex) {
  const d = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), Buffer.from(w.nonce, "base64"));
  d.setAuthTag(Buffer.from(w.tag, "base64"));
  const plain = Buffer.concat([d.update(Buffer.from(w.data, "base64")), d.final()]);
  if (w.sha256 && createHash("sha256").update(plain).digest("hex") !== w.sha256) throw new Error("sha256 mismatch");
  return plain.toString("utf8");
}
const keyHex = (process.env.SCRAMBLE_KEY || "").trim().toLowerCase();
const nskey = (JSON.parse(dec(JSON.parse(readFileSync("keys/nitrosend-key.json", "utf8")), keyHex)).nskey || "").trim();
if (!nskey) throw new Error("wrapper held no .nskey");
console.log("::add-mask::" + nskey);
const out = {};
try {
  const r = await fetch("https://api.nitrosend.com/v1/my/brands", { headers: { Accept: "application/json", "User-Agent": "frantic-auto-actions/1.0", Authorization: "Bearer " + nskey } });
  const t = await r.text();
  out.brands = { http: r.status };
  if (r.ok) { try { const b = JSON.parse(t); const arr = b.brands || b.data || b; out.brands.count = Array.isArray(arr) ? arr.length : null; out.brands.ready = Array.isArray(arr) ? arr.map(x => ({ sending: x.sending_ready ?? x.prepared ?? x.status ?? null })) : null; } catch { out.brands.note = t.slice(0, 120); } }
  else out.brands.note = t.slice(0, 160);
} catch (e) { out.brands = { err: String(e).slice(0, 100) }; }
writeFileSync("nitro-probe-out.json", JSON.stringify(out, null, 1));
console.log(JSON.stringify(out));
