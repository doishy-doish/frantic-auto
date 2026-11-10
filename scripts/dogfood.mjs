// Actions-runner dogfood driver, phase 1: claim -> drive -> evidence packet.
// Runs on ubuntu-latest with Playwright Chromium. Phase 2 (deliver.mjs) runs
// AFTER the workflow commits evidence, so raw URLs exist before delivery.
// Env: FRANTIC_BASE, FRANTIC_AGENT_KID, FRANTIC_AGENT_TOKEN, SCRAMBLE_KEY,
//   BOUNTY, EXT (optional: "cws:<id>" | "crx:<url>" | "dir:<path>"; empty =
//   derive from the sealed brief), TASKS (optional JSON array).
// Secrecy: the sealed brief is NEVER printed or committed (hash only). The
// agent token is NEVER printed (in-memory only, ::add-mask:: in token.mjs).
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import { auditExtension, summarizeNet } from "./ext-audit.js";
const require = createRequire(import.meta.url);
let pwVersion = null;
try { pwVersion = require("playwright/package.json").version; } catch {}

const BASE = process.env.FRANTIC_BASE || "https://gofrantic.com";
const KID = process.env.FRANTIC_AGENT_KID || "agent-4bc19b"; // public id, safe to default
import { loadToken } from "./token.mjs";
const TOKEN = loadToken(); // env direct, else scramble-wrapped keys/frantic-token.json (memory only)
const BOUNTY = Number(process.env.BOUNTY || 147);
const EXT = (process.env.EXT || "").trim();
const TASKS = JSON.parse(process.env.TASKS || "[]");
if (!KID || !TOKEN) throw new Error("missing FRANTIC_AGENT_KID/TOKEN secrets");
const UA = "frantic-auto-actions/1.0";

function sha8(s) {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

async function api(p, body, bearer) {
  const h = { Accept: "application/json", "Content-Type": "application/json", "User-Agent": UA };
  if (bearer) h.Authorization = "Bearer " + TOKEN;
  const r = await fetch(BASE + p, {
    method: body ? "POST" : "GET",
    headers: h,
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${p} -> ${r.status}: ${t.slice(0, 300)}`);
  return JSON.parse(t);
}

async function releaseClaim(claimId, why) {
  try {
    const rel = await api(`/v1/claims/${claimId}/release`, {}, true);
    console.log(JSON.stringify({ released: true, why, marked: rel.marked ?? null, status: rel.status ?? null }));
  } catch (e) {
    console.log(JSON.stringify({ released: false, why, error: String(e).slice(0, 160) }));
  }
}

// 1. claim (fuse starts here — everything must fit inside it)
const claim = await api("/v1/claims", { bounty: BOUNTY, agent_kid: KID, agent_token: TOKEN });
const claimId = claim.claim_id || claim?.claim?.id;
const fuse = claim.fuse_expires_at || claim?.claim?.fuse_expires_at || null;
const brief = claim.brief ?? claim?.claim?.brief ?? null;
const eligibility = claim.eligibility ?? claim?.claim?.eligibility ?? null;
const verification = claim.verification ?? claim?.claim?.verification ?? null;
const briefText = typeof brief === "string" ? brief : JSON.stringify(brief ?? "");
console.log(JSON.stringify({
  claimed: true, claimId,
  fuse,
  brief_present: briefText.length > 0,
  brief_len: briefText.length,
  brief_hash: briefText ? sha8(briefText) : null,
  eligibility_missing: eligibility?.missing ?? null,
}));
if (!claimId) throw new Error("claim response carried no claim_id — not driving blind");
if (brief && /recruit|bring \d+ users|prove clients|referrals|buy followers/i.test(briefText)) {
  await releaseClaim(claimId, "MARKETING_TRIPWIRE");
  throw new Error("MARKETING TRIPWIRE: brief demands users/clients/referrals — claim released, walking free");
}

// 2. resolve the extension: explicit input wins, else derive from the brief
function resolveExt() {
  if (EXT.startsWith("cws:") || EXT.startsWith("crx:") || EXT.startsWith("dir:")) {
    return { spec: EXT, from: "dispatch-input" };
  }
  if (briefText) {
    const cws = briefText.match(/chromewebstore\.google\.com\/detail(?:\/[^/\s]*)?\/([a-p]{32})/)
      || briefText.match(/\b([a-p]{32})\b/);
    if (cws) return { spec: "cws:" + cws[1], from: "brief" };
    const crx = briefText.match(/https?:\/\/\S+\.(crx|zip)(\?\S*)?/);
    if (crx) return { spec: "crx:" + crx[0], from: "brief" };
  }
  return { spec: "", from: "none" };
}
const { spec: EXT_SPEC, from: EXT_FROM } = resolveExt();
console.log(JSON.stringify({ ext_from: EXT_FROM, ext_form: EXT_SPEC.split(":")[0] || "none" }));
if (!EXT_SPEC) {
  await releaseClaim(claimId, "no-machine-resolvable-extension");
  throw new Error("no CWS id / CRX url / repo dir in dispatch input or brief — claim released, re-dispatch with EXT set");
}

// 3. fetch/unpack to a load dir (brief text itself is never written to disk)
const evDir = `evidence/bounty-${BOUNTY}`;
fs.mkdirSync(evDir, { recursive: true });
const extDir = "evidence/ext";
fs.mkdirSync(extDir, { recursive: true });
if (EXT_SPEC.startsWith("cws:")) {
  const id = EXT_SPEC.slice(4);
  if (!/^[a-p]{32}$/.test(id)) throw new Error("bad CWS id shape — refusing before download");
  execSync(`curl -sL "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=120.0&acceptformat=crx2,crx3&x=id%3D${id}%26installsource%3Dondemand%26uc" -o evidence/ext.crx`, { stdio: "inherit" });
  fs.mkdirSync("evidence/crx", { recursive: true });
  execSync(`node -e "require('child_process').execSync('unzip -q -o evidence/ext.crx -d evidence/crx')"`);
  fs.renameSync("evidence/crx", extDir + "-dl");
} else if (EXT_SPEC.startsWith("crx:")) {
  execSync(`curl -sL "${EXT_SPEC.slice(4)}" -o evidence/ext.crx`, { stdio: "inherit" });
  throw new Error("crx downloaded — add unzip-to-dir step matching this package layout before launch");
} else {
  console.log(JSON.stringify({ extDir: EXT_SPEC.slice(4) }));
}
const loadDir = EXT_SPEC.startsWith("dir:") ? EXT_SPEC.slice(4) : extDir + "-dl";
const manifest = JSON.parse(fs.readFileSync(path.join(loadDir, "manifest.json"), "utf8"));
console.log(JSON.stringify({ extName: manifest.name, version: manifest.version, permissions: manifest.permissions || [] }));
// static audit FIRST (cheap, runs even if the browser half fails)
const fullAudit = auditExtension(loadDir, manifest);

// 4. drive it: headful Chromium under xvfb, extension loaded
const steps = TASKS.length ? TASKS : [{ url: "https://example.com", action: "shot" }];
const log = { playwright: pwVersion, extension: { name: manifest.name, version: manifest.version }, steps: [], console: [], started: new Date().toISOString() };
const ctx = await chromium.launchPersistentContext("", {
  headless: false,
  args: [`--load-extension=${path.resolve(loadDir)}`, "--no-sandbox"],
});
const page = ctx.pages()[0] || (await ctx.newPage());
page.on("console", (m) => log.console.push(`${m.type()}: ${m.text()}`.slice(0, 300)));
page.on("pageerror", (e) => log.console.push(`pageerror: ${String(e).slice(0, 300)}`));
const net = [];
page.on("request", (q) => {
  try { net.push({ method: q.method(), host: new URL(q.url()).host, url: q.url().slice(0, 160), post: (q.postData() || "").length }); } catch {}
});
page.on("response", (s) => { if (s.status() >= 400) log.console.push(`http ${s.status()} ${s.url().slice(0, 120)}`); });
let shots = 0;
for (const s of steps) {
  if (s.url) { await page.goto(s.url, { waitUntil: "networkidle", timeout: 45000 }); log.steps.push(`goto ${s.url} -> ${page.url()}`); }
  if (s.action === "wait") await page.waitForTimeout(s.ms || 2000);
  if (s.action === "click") { await page.click(s.selector, { timeout: 15000 }); log.steps.push(`click ${s.selector}`); }
  if (s.action === "fill") { await page.fill(s.selector, s.value || "", { timeout: 15000 }); log.steps.push(`fill ${s.selector}`); }
  if (!s.action || s.action === "shot") { shots++; await page.screenshot({ path: `${evDir}/shot-${shots}.png`, fullPage: false }); log.steps.push(`shot-${shots}.png @ ${page.url()}`); }
}
// guarantee the required screenshot slot: at least one real capture per run
if (shots === 0) { shots++; await page.screenshot({ path: `${evDir}/shot-${shots}.png`, fullPage: false }); log.steps.push(`shot-${shots}.png @ ${page.url()} (guaranteed)`); }
log.network = summarizeNet(net);
log.audit = { score: fullAudit.score, findings: fullAudit.findings, secrets: fullAudit.secrets };
fs.writeFileSync(`${evDir}/audit.json`, JSON.stringify(fullAudit, null, 1));
log.finished = new Date().toISOString();
fs.writeFileSync(`${evDir}/run.json`, JSON.stringify(log, null, 1));

// 5. machine + human evidence (public-safe: no brief text, no tokens)
const observations = [
  `extension ${manifest.name} v${manifest.version} installed from ${EXT_FROM}, launched under headful Chromium`,
  `manifest audit score ${fullAudit.score}; top findings: ${fullAudit.findings.slice(0, 3).join(" | ") || "none"}`,
  `drove ${log.steps.length} steps, captured ${shots} screenshots, ${log.console.length} console lines, ${net.length} requests`,
  `no exfiltration verdict: see audit.json + network table in run.json`,
];
const summary = `Dogfooded ${manifest.name} v${manifest.version}: installed, launched, exercised, captured. Claim ${claimId}.`;
fs.writeFileSync(`${evDir}/evidence.json`, JSON.stringify({ summary, observations }, null, 1));
const bullets = [
  `Installed ${manifest.name} v${manifest.version} from ${EXT_FROM} and launched it in headful Chromium with --load-extension.`,
  `Manifest audit: score ${fullAudit.score}; findings: ${fullAudit.findings.join("; ") || "none"}. Full audit in audit.json.`,
  `Exercised: ${log.steps.join(" / ") || "launch only"}. Screenshots: ${shots} in this directory.`,
  `Console (${log.console.length}) and network (${net.length} requests) captured in run.json; no page errors: ${log.console.filter((c) => c.startsWith("pageerror")).length === 0}.`,
  `Limitation: brief-derived flows beyond install/launch/shot were out of scope for this run; revision can extend TASKS while the fuse lives.`,
];
fs.writeFileSync(`${evDir}/report.md`, bullets.map((b) => `- ${b}`).join("\n") + "\n");
fs.writeFileSync(`${evDir}/delivery.json`, JSON.stringify({
  claim_id: claimId, bounty: BOUNTY, fuse_expires_at: fuse, brief_hash: briefText ? sha8(briefText) : null,
  files: ["run.json", "audit.json", "evidence.json", "report.md"].concat(Array.from({ length: shots }, (_, i) => `shot-${i + 1}.png`)),
  verification: verification ? { scheduled: verification.scheduled ?? null } : null,
}, null, 1));
console.log(JSON.stringify({ packet: true, claimId, shots, brief_hash: briefText ? sha8(briefText) : null, note: "evidence on disk; workflow commits, deliver.mjs sends after raw URLs exist" }));
