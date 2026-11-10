// nitro-probe2: brand sender detail (read-only). Never sends.
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
if (!nskey) throw new Error("no nskey");
console.log("::add-mask::" + nskey);
const A = { Accept: "application/json", "User-Agent": "frantic-auto-actions/1.0", Authorization: "Bearer " + nskey };
const out = {};
const lb = await fetch("https://api.nitrosend.com/v1/my/brands", { headers: A });
out.brandsHttp = lb.status;
let sid = null;
try { const b = JSON.parse(await lb.text()); const arr = b.brands || b.data || b; if (Array.isArray(arr) && arr[0]) { sid = arr[0].sid || arr[0].id; out.count = arr.length; out.firstKeys = Object.keys(arr[0]).slice(0, 20); } } catch (e) { out.err = String(e).slice(0, 100); }
if (sid) {
  const d = await fetch("https://api.nitrosend.com/v1/my/brands/" + sid, { headers: A });
  const t = await d.text();
  out.detailHttp = d.status;
  try { const x = JSON.parse(t); const b = x.brand || x; out.sender = { sid, status: b.status ?? null, sending: b.sending_ready ?? b.prepared ?? b.sending ?? null, subdomain: b.subdomain ?? b.sender_subdomain ?? null, domain: b.domain ?? b.sender_domain ?? null, keys: Object.keys(b || {}).slice(0, 30) }; }
  catch { out.detailNote = t.slice(0, 160); }
}
writeFileSync("nitro-probe2-out.json", JSON.stringify(out, null, 1));
console.log(JSON.stringify(out));
