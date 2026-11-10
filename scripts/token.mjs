// token.mjs — resolve the Frantic agent token at runtime WITHOUT GH secrets.
// Priority: FRANTIC_AGENT_TOKEN env (direct) else keys/frantic-token.json
// (scramble AES-256-GCM wrapper, same format as src/bot/gh/scramble.mjs)
// decrypted in-memory with SCRAMBLE_KEY env. Plaintext is never written to
// disk, never logged (we emit ::add-mask::), never committed.
// Operator one-time (their machine only — the single plaintext touch):
//   printf '%s' '{"token":"<agent_token from scratch/vault/keys/frantic-agent.json>}' > /tmp/ft.json
//   SCRAMBLE_KEY=<64hex from scratch/vault/keys/scramble.key> node src/bot/gh/scramble.mjs encrypt /tmp/ft.json
//   cp /tmp/ft.json <repo>/keys/frantic-token.json && shred -u /tmp/ft.json
//   (commit ONLY keys/frantic-token.json — verify with: grep -c fr_agent <repo>/keys/frantic-token.json → 0)
import { readFileSync, existsSync } from "node:fs";
import { createDecipheriv, createHash } from "node:crypto";

function decryptWrapper(w, keyHex) {
  if (!w || w.enc !== "AES-256-GCM-v1") throw new Error("not a scramble wrapper");
  const key = Buffer.from(keyHex, "hex");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(w.nonce, "base64"));
  d.setAuthTag(Buffer.from(w.tag, "base64"));
  const plain = Buffer.concat([d.update(Buffer.from(w.data, "base64")), d.final()]);
  if (w.sha256 && createHash("sha256").update(plain).digest("hex") !== w.sha256) throw new Error("sha256 mismatch");
  return plain.toString("utf8");
}

export function loadToken() {
  const direct = (process.env.FRANTIC_AGENT_TOKEN || "").trim();
  if (direct) return direct;
  const wrapPath = "keys/frantic-token.json";
  if (!existsSync(wrapPath)) {
    throw new Error("no token: set FRANTIC_AGENT_TOKEN or commit keys/frantic-token.json (see token.mjs header)");
  }
  const keyHex = (process.env.SCRAMBLE_KEY || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(keyHex)) throw new Error("no valid SCRAMBLE_KEY (64 hex) for keys/frantic-token.json");
  const w = JSON.parse(readFileSync(wrapPath, "utf8"));
  const token = (JSON.parse(decryptWrapper(w, keyHex)).token || "").trim();
  if (!token) throw new Error("wrapper decrypted but held no .token");
  console.log(`::add-mask::${token}`); // any accidental echo after this is masked in Actions logs
  return token;
}
