// Actions-runner dogfood driver. Runs on ubuntu-latest with Playwright Chromium.
// Flow: claim (starts fuse) -> resolve extension -> headful Chromium under xvfb
// with --load-extension -> scripted tasks + screenshots/console capture ->
// commit evidence (workflow step) -> preflight -> deliver.
// Env: FRANTIC_BASE, FRANTIC_AGENT_KID, FRANTIC_AGENT_TOKEN, BOUNTY, EXT, TASKS.
// EXT forms: "cws:<32-char-store-id>" | "crx:<https-url>" | "dir:<repo-path>".
// TASKS: JSON array of steps: {url} | {action:"shot"} | {action:"click"|"fill", selector, value?} | {action:"wait", ms}.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { auditExtension, summarizeNet } from "./ext-audit.js";

const BASE = process.env.FRANTIC_BASE || "https://gofrantic.com";
const KID = process.env.FRANTIC_AGENT_KID || "agent-4bc19b"; // public id, safe to default
import { loadToken } from "./token.mjs";
const TOKEN = loadToken(); // env direct, else scramble-wrapped keys/frantic-token.json (memory only)
const BOUNTY = Number(process.env.BOUNTY || 147);
const EXT = process.env.EXT || "";
const TASKS = JSON.parse(process.env.TASKS || "[]");
if (!KID || !TOKEN) throw new Error("missing FRANTIC_AGENT_KID/TOKEN secrets");
const UA = "frantic-auto-actions/1.0";

async function api(p, body) {
  const r = await fetch(BASE + p, {
    method: body ? "POST" : "GET",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": UA },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${p} -> ${r.status}: ${t.slice(0, 300)}`);
  return JSON.parse(t);
}

// 1. claim (fuse starts here — everything after must fit inside it)
const claim = await api("/v1/claims", { bounty: BOUNTY, agent_kid: KID, agent_token: TOKEN });
const claimId = claim.claim_id || claim?.claim?.id;
const brief = claim.brief || claim?.claim?.brief || null;
console.log(JSON.stringify({ claimed: true, claimId, fuse: claim.fuse_expires_at || claim?.claim?.fuse_expires_at || null, brief }));
if (brief && /recruit|bring \d+ users|prove clients|referrals/i.test(JSON.stringify(brief))) {
  throw new Error("MARKETING TRIPWIRE: brief demands users/clients/referrals — release the claim and walk, do not deliver");
}

// 2. resolve extension to an unpacked dir
const extDir = "evidence/ext";
fs.mkdirSync(extDir, { recursive: true });
if (EXT.startsWith("cws:")) {
  const id = EXT.slice(4);
  execSync(`curl -sL "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=120.0&acceptformat=crx2,crx3&x=id%3D${id}%26installsource%3Dondemand%26uc" -o evidence/ext.crx`, { stdio: "inherit" });
  fs.mkdirSync("evidence/crx", { recursive: true });
  execSync(`node -e "require('child_process').execSync('unzip -q -o evidence/ext.crx -d evidence/crx')"`);
  fs.renameSync("evidence/crx", extDir + "-dl");
} else if (EXT.startsWith("crx:")) {
  execSync(`curl -sL "${EXT.slice(4)}" -o evidence/ext.crx`, { stdio: "inherit" });
  throw new Error("crx downloaded — add unzip-to-dir step matching this package layout before launch");
} else if (EXT.startsWith("dir:")) {
  console.log(JSON.stringify({ extDir: EXT.slice(4) }));
} else {
  throw new Error("EXT must be cws:<id> | crx:<url> | dir:<path>");
}
const loadDir = EXT.startsWith("dir:") ? EXT.slice(4) : extDir + "-dl";
const manifest = JSON.parse(fs.readFileSync(path.join(loadDir, "manifest.json"), "utf8"));
console.log(JSON.stringify({ extName: manifest.name, version: manifest.version, permissions: manifest.permissions || [] }));
// static audit FIRST (cheap, runs even if the browser half fails)
const fullAudit = auditExtension(loadDir, manifest);

// 3. drive it: headful Chromium under xvfb, extension loaded
const evDir = `evidence/bounty-${BOUNTY}`;
fs.mkdirSync(evDir, { recursive: true });
const log = { extension: { name: manifest.name, version: manifest.version }, steps: [], console: [], started: new Date().toISOString() };
const ctx = await chromium.launchPersistentContext("", {
  headless: false,
  args: [`--load-extension=${path.resolve(loadDir)}`, "--no-sandbox"],
});
const page = ctx.pages()[0] || (await ctx.newPage());
page.on("console", (m) => log.console.push(`${m.type()}: ${m.text()}`.slice(0, 300)));
page.on("pageerror", (e) => log.console.push(`pageerror: ${String(e).slice(0, 300)}`));
const net = []; // every request: exfiltration evidence, not just console noise
page.on("request", (q) => {
  try { net.push({ method: q.method(), host: new URL(q.url()).host, url: q.url().slice(0, 160), post: (q.postData() || "").length }); } catch {}
});
page.on("response", (s) => { if (s.status() >= 400) log.console.push(`http ${s.status()} ${s.url().slice(0, 120)}`); });
let shots = 0;
for (const s of TASKS) {
  if (s.url) { await page.goto(s.url, { waitUntil: "networkidle", timeout: 45000 }); log.steps.push(`goto ${s.url} -> ${page.url()}`); }
  if (s.action === "wait") await page.waitForTimeout(s.ms || 2000);
  if (s.action === "click") { await page.click(s.selector, { timeout: 15000 }); log.steps.push(`click ${s.selector}`); }
  if (s.action === "fill") { await page.fill(s.selector, s.value || "", { timeout: 15000 }); log.steps.push(`fill ${s.selector}`); }
  if (!s.action || s.action === "shot") { shots++; await page.screenshot({ path: `${evDir}/shot-${shots}.png`, fullPage: false }); log.steps.push(`shot-${shots}.png @ ${page.url()}`); }
}
log.network = summarizeNet(net);
log.audit = { score: fullAudit.score, findings: fullAudit.findings, secrets: fullAudit.secrets };
fs.writeFileSync(`${evDir}/audit.json`, JSON.stringify(fullAudit, null, 1));
log.finished = new Date().toISOString();
fs.writeFileSync(`${evDir}/run.json`, JSON.stringify(log, null, 1));
await ctx.close();

// 4. preflight + deliver (report binds run.json + shots by raw repo URL — fill REPO param at dispatch)
const refs = { report: "see run.json", evidence_json: "see run.json" };
console.log(JSON.stringify({ log, refs, note: "bind raw-file refs to deliver in the follow-up once repo path is fixed" }));
const pre = await api("/v1/deliveries/preflight", { claim_id: claimId, agent_token: TOKEN });
console.log(JSON.stringify({ preflight: pre }));
