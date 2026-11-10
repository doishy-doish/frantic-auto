// Extension-audit kit: manifest risk score + secret sweep + network summary.
// Pure node, no deps. Input: unpacked extension dir + parsed manifest.
// Output: { score, findings[], secrets[], files } — written to audit.json
// and merged into the dogfood run log as machine-checkable evidence.
import fs from "node:fs";
import path from "node:path";

const PERM_RISK = {
  debugger: "high", management: "high", nativeMessaging: "high", proxy: "high",
  privacy: "high", browsingData: "high", history: "high", cookies: "high",
  clipboardRead: "high", geolocation: "medium", identity: "medium",
  tabs: "medium", activeTab: "low", storage: "low", alarms: "low",
  webRequest: "medium", webRequestBlocking: "high", declarativeNetRequest: "low",
  downloads: "medium", topSites: "low", bookmarks: "low", unlimitedStorage: "low",
};

const SECRET_RES = [
  [/AKIA[0-9A-Z]{16}/, "aws-key"], [/ghp_[A-Za-z0-9]{20,}/, "github-pat"],
  [/xox[bap]-[A-Za-z0-9-]{10,}/, "slack-token"], [/AIza[0-9A-Za-z_-]{20,}/, "gcp-key"],
  [/sk-[A-Za-z0-9]{20,}/, "openai-style-key"], [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/, "private-key"],
  [/discord(app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+/, "discord-webhook"],
  [/hooks\.slack\.com\/services\/[A-Z0-9/]+/, "slack-webhook"],
  [/["'](api[_-]?key|apikey|client[_-]?secret|auth[_-]?token)["']\s*[:=]\s*["'][^"']{8,}["']/i, "hardcoded-secret"],
  [/eval\s*\(/, "eval-use"], [/new\s+Function\s*\(/, "function-ctor"],
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if ([".git", "node_modules"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|html|json|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

export function auditExtension(dir, manifest) {
  const findings = [];
  const push = (sev, id, detail) => findings.push({ sev, id, detail });

  const perms = [...(manifest.permissions || []), ...(manifest.host_permissions || [])];
  for (const p of perms) {
    const key = String(p).split(".").pop();
    const r = PERM_RISK[key] || (/^(https?|\*|<all_urls>)/.test(p) ? "medium" : "low");
    if (r !== "low") push(r, "perm:" + p, `permission/host pattern carries ${r} risk`);
  }
  if (perms.some((p) => String(p).includes("<all_urls>"))) push("high", "host:all-urls", "extension requests all URLs");
  if (perms.some((p) => /^http:\/\//.test(String(p)))) push("medium", "host:http", "unencrypted http host pattern");

  for (const cs of manifest.content_scripts || []) {
    const m = (cs.matches || []).join(",");
    if (/all_urls|\*:\/\/\*\/\*/.test(m)) push("high", "cs:broad-match", `content script matches ${m}`);
    if (cs.world === "MAIN") push("medium", "cs:main-world", "content script runs in page MAIN world");
    if (cs.run_at === "document_start" && cs.all_frames) push("medium", "cs:early-all-frames", "document_start + all_frames");
  }
  if (manifest.externally_connectable?.matches?.some((m) => /\*/.test(m))) push("medium", "ext:connectable", "wildcard externally_connectable");
  if (manifest.update_url && !/google\.com/.test(manifest.update_url)) push("high", "ext:update-url", "non-store update_url: " + manifest.update_url);
  if (manifest.background?.persistent === true) push("low", "ext:persistent-bg", "MV2 persistent background page");
  if ((manifest.manifest_version || 0) < 3) push("low", "ext:mv2", "manifest v2 (remotely-hosted code possible)");

  // remotely-loaded code in packaged HTML
  const files = walk(dir).filter((f) => f.endsWith(".html"));
  for (const f of files) {
    const html = fs.readFileSync(f, "utf8");
    const m = html.match(/<script[^>]+src=["'](https?:[^"']+)["']/ig) || [];
    for (const s of m.slice(0, 5)) push("high", "ext:remote-script", `${path.basename(f)}: ${s.slice(0, 120)}`);
  }

  // secret sweep over code files
  const secrets = [];
  for (const f of walk(dir)) {
    let src = "";
    try { src = fs.readFileSync(f, "utf8"); } catch { continue; }
    if (src.length > 500000) continue;
    for (const [re, label] of SECRET_RES) {
      const hit = src.match(re);
      if (hit) secrets.push({ label, file: path.relative(dir, f), sample: hit[0].slice(0, 24) + "…(redacted)" });
    }
    if (secrets.length > 60) break;
  }

  const score = findings.filter((f) => f.sev === "high").length * 10
    + findings.filter((f) => f.sev === "medium").length * 3
    + Math.min(secrets.length, 10) * 2;
  return { files: walk(dir).length, score, findings: findings.slice(0, 40), secrets: secrets.slice(0, 40) };
}

export function summarizeNet(net) {
  const hosts = {};
  for (const q of net) {
    const h = hosts[q.host] || (hosts[q.host] = { requests: 0, posts: 0, postBytes: 0 });
    h.requests++;
    if (q.method === "POST" || q.post > 0) { h.posts++; h.postBytes += q.post; }
  }
  const rows = Object.entries(hosts).map(([host, h]) => ({ host, ...h }));
  rows.sort((a, b) => b.postBytes - a.postBytes || b.requests - a.requests);
  return {
    distinctHosts: rows.length,
    topPosts: rows.filter((r) => r.posts > 0).slice(0, 15),
    all: rows.slice(0, 40),
  };
}
