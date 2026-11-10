// Actions-runner delivery driver, phase 2 (runs AFTER the workflow commits
// evidence, so raw URLs exist). Reads evidence/bounty-N/packet, preflights,
// then delivers. Env: BOUNTY, EVIDENCE_SHA, REPO (owner/repo, e.g. from
// ${{ github.repository }}), FRANTIC_AGENT_KID, FRANTIC_AGENT_TOKEN,
// SCRAMBLE_KEY, FRANTIC_BASE. Never prints tokens or the sealed brief.
import fs from "node:fs";
import { loadToken } from "./token.mjs";

const BASE = process.env.FRANTIC_BASE || "https://gofrantic.com";
const KID = process.env.FRANTIC_AGENT_KID || "agent-4bc19b";
const TOKEN = loadToken();
const BOUNTY = Number(process.env.BOUNTY || 147);
const SHA = (process.env.EVIDENCE_SHA || "").trim();
const REPO = (process.env.REPO || "").trim();
if (!KID || !TOKEN) throw new Error("missing FRANTIC_AGENT_KID/TOKEN");
if (!SHA) throw new Error("missing EVIDENCE_SHA (workflow must set it after the evidence commit)");
if (!REPO.includes("/")) throw new Error("missing REPO (owner/repo)");
const UA = "frantic-auto-actions/1.0";

async function api(p, body) {
  const r = await fetch(BASE + p, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${p} -> ${r.status}: ${t.slice(0, 400)}`);
  return JSON.parse(t);
}

const evDir = `evidence/bounty-${BOUNTY}`;
const packet = JSON.parse(fs.readFileSync(`${evDir}/delivery.json`, "utf8"));
const claimId = packet.claim_id;
if (!claimId) throw new Error("delivery.json carries no claim_id");
const raw = `https://raw.githubusercontent.com/${REPO}/${SHA}/${evDir}`;
const refs = [
  `evidence_json=${raw}/evidence.json`,
  `report=${raw}/report.md`,
  `source_url=https://github.com/${REPO}/tree/${SHA}/${evDir}`,
  `run_log=${raw}/run.json`,
];
for (const f of packet.files || []) {
  if (f.startsWith("shot-")) refs.push(`${f.replace(/[^A-Za-z0-9]+/g, "_")}=${raw}/${f}`);
}
const limited = refs.slice(0, 20);
console.log(JSON.stringify({ claimId, refs: limited.length, sha: SHA.slice(0, 12) }));

const pre = await api("/v1/deliveries/preflight", { claim_id: claimId, agent_token: TOKEN, artifact_refs: limited });
console.log(JSON.stringify({ preflight_ok: pre.ok, errors: (pre.errors || pre.blockers || []).slice(0, 5), warnings: (pre.warnings || []).slice(0, 5) }));
if (pre.ok === false) {
  throw new Error(`preflight refused: ${JSON.stringify(pre.errors || pre.blockers || pre.missing || pre).slice(0, 300)} — not delivering blind`);
}
const d = await api("/v1/deliveries", { claim_id: claimId, agent_kid: KID, agent_token: TOKEN, artifact_refs: limited });
console.log(JSON.stringify({ delivered: true, delivery: d.delivery_id || d.id || null, verification: d.verification?.status ?? null }));
