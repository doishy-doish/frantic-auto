// st149-dogfood.mjs v3 — hardened: every wait bounded, incremental summary,
// SIGTERM flush. Public lane, no secrets.
import { chromium } from 'playwright';
import { promises as fs } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const EXT_ID = 'lanedehejpgpanageefmjbfgaeppeidl';
const STORE_URL = `https://chromewebstore.google.com/detail/silvertongue-write-like-a/${EXT_ID}`;
const CRX_URL = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=126.0&acceptformat=crx2,crx3&x=id%3D${EXT_ID}%26installsource%3Dondemand%26uc`;
const stamp = process.env.STAMP || 'run3';
const dir = `evidence/st149/${stamp}`;
await fs.mkdir(dir, { recursive: true });
const summary = { extId: EXT_ID, at: null, steps: [], errors: [], signInDemanded: null, triesBefore: null, triesAfter: null, outputChars: 0, outputText: null };
const save = () => fs.writeFile(`${dir}/summary.json`, JSON.stringify(summary, null, 1)).catch(() => {});
const note = (s) => { summary.steps.push({ t: new Date().toISOString(), s }); console.log('st149:', s); save(); };
process.on('SIGTERM', async () => { summary.errors.push('SIGTERM (job timeout?)'); summary.at = new Date().toISOString(); await save(); process.exit(143); });

async function fetchTimeout(url, ms, dest) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: c.signal });
    if (!r.ok) throw new Error(`http ${r.status}`);
    await pipeline(r.body, createWriteStream(dest));
  } finally { clearTimeout(t); }
}

try {
  note('crx_fetch start');
  await fetchTimeout(CRX_URL, 90000, `${dir}/ext.crx`);
  const buf = await fs.readFile(`${dir}/ext.crx`);
  if (buf.slice(0, 4).toString() !== 'Cr24') throw new Error('not a CRX');
  const ver = buf.readUInt32LE(4);
  const zipOff = ver === 3 ? 12 + buf.readUInt32LE(8) : 16 + buf.readUInt32LE(8) + buf.readUInt32LE(12);
  await fs.writeFile(`${dir}/ext.zip`, buf.slice(zipOff));
  execFileSync('python3', ['-c', `import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])`, `${dir}/ext.zip`, `${dir}/ext-unpacked`], { timeout: 60000 });
  const manifest = JSON.parse(await fs.readFile(`${dir}/ext-unpacked/manifest.json`, 'utf8'));
  summary.manifest = { version: manifest.version, popup: manifest?.action?.default_popup };
  note(`unpacked v${manifest.version}`);

  note('browser_launch start');
  const absExt = path.resolve(`${dir}/ext-unpacked`);
  const absProfile = path.resolve(`${dir}/profile`);
  const ctx = await chromium.launchPersistentContext(absProfile, {
    headless: false, timeout: 90000,
    args: [`--load-extension=${absExt}`, `--disable-extensions-except=${absExt}`, '--no-sandbox', '--disable-dev-shm-usage'],
  });
  summary.loadPath = absExt;
  note('browser up');

  let extId = null;
  for (let i = 0; i < 20 && !extId; i++) {
    const sws = ctx.serviceWorkers();
    if (sws.length) extId = sws[0].url().split('/')[2];
    else await new Promise((rr) => setTimeout(rr, 1000));
  }
  summary.extRuntimeId = extId;
  note(`runtime id=${extId}`);

  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(STORE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${dir}/01-store.png` });
  note('store shot');

  await page.goto('chrome://extensions', { timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${dir}/02-installed.png` });
  note('extensions shot');

  if (!extId) throw new Error('extension failed to load (no service worker)');
  const pop = await ctx.newPage();
  await pop.goto(`chrome-extension://${extId}/${summary.manifest.popup}`, { timeout: 30000 });
  await pop.waitForTimeout(4000);
  await pop.screenshot({ path: `${dir}/03-popup.png` });
  const popText = ((await pop.content()) || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const mTry = popText.match(/(\d+)\s+free\s+tr/i);
  summary.triesBefore = mTry ? Number(mTry[1]) : null;
  summary.signInDemanded = /sign in to keep going/i.test(popText) && summary.triesBefore === 0;
  note(`popup tries=${summary.triesBefore} signInDemanded=${summary.signInDemanded}`);

  const SAMPLE = 'Thanks for having me on the show, I had a great time and hope to come back soon.';
  try {
    const box = pop.locator('textarea, [contenteditable="true"], input[type="text"]').first();
    await box.waitFor({ timeout: 15000 });
    await box.fill(SAMPLE);
    await pop.waitForTimeout(1000);
    await pop.screenshot({ path: `${dir}/04-input.png` });
    const voiceHit = pop.getByText(/snoop/i).first();
    if (await voiceHit.count()) { await voiceHit.click({ timeout: 8000 }).catch(() => {}); await pop.waitForTimeout(1500); }
    const go = pop.getByRole('button', { name: /rewrite|reply|write|generate/i }).first();
    if (await go.count()) {
      await go.click({ timeout: 8000 });
      let last = -1, still = 0;
      for (let i = 0; i < 30 && still < 3; i++) {
        await pop.waitForTimeout(3000);
        const n = ((await pop.content()) || '').length;
        if (n === last) still++;
        else { still = 0; last = n; }
      }
      await pop.screenshot({ path: `${dir}/05-generation.png` });
      const finalText = ((await pop.content()) || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      summary.outputChars = finalText.length;
      const si = finalText.indexOf('Thanks for having me');
      summary.outputText = (si >= 0 ? finalText.slice(Math.max(0, si - 1500), si + 2500) : finalText.slice(-2500)).slice(0, 3000);
      const mA = finalText.match(/(\d+)\s+free\s+tr/i) || finalText.match(/(\d+)\s+left/i);
      summary.triesAfter = mA ? Number(mA[1]) : null;
      note(`generated chars=${summary.outputChars} triesAfter=${summary.triesAfter}`);
    } else { summary.errors.push('no generate button'); await pop.screenshot({ path: `${dir}/05-generation.png` }); }
  } catch (e) { summary.errors.push(`generation: ${e.message}`); await pop.screenshot({ path: `${dir}/05-generation.png` }).catch(() => {}); }

  await ctx.close().catch(() => {});
  note('done');
} catch (e) {
  summary.errors.push(`fatal: ${e.message}`);
}
summary.at = new Date().toISOString();
await save();
await fs.writeFile(`${dir}/run.log`, summary.steps.map((s) => `${s.t} ${s.s}`).join('\n') + '\n').catch(() => {});
await fs.rm(`${dir}/profile`, { recursive: true, force: true });
console.log('st149 v3 done');
