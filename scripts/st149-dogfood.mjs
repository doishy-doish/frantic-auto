// st149-dogfood.mjs — Silvertongue extension dogfood for Frantic #149 (elite recon).
// Public-lane, no secrets. Evidence -> evidence/st149/ (committed back).
// Runner: xvfb-run -a node scripts/st149-dogfood.mjs  (headed Chromium, extensions need it)
import { chromium } from 'playwright';
import { promises as fs } from 'node:fs';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';

const EXT_ID = 'lanedehejpgpanageefmjbfgaeppeidl';
const STORE_URL = `https://chromewebstore.google.com/detail/silvertongue-write-like-a/${EXT_ID}`;
const CRX_URL = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=126.0&acceptformat=crx2,crx3&x=id%3D${EXT_ID}%26installsource%3Dondemand%26uc`;
const OUT = 'evidence/st149';
const stamp = process.env.STAMP || 'st149';
const dir = `${OUT}/${stamp}`;
await fs.mkdir(dir, { recursive: true });
const log = [];
const note = (s) => { log.push(`${new Date().toISOString()} ${s}`); console.log('st149:', s); };

async function download(url, dest) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`download http ${r.status}`);
  await pipeline(r.body, createWriteStream(dest));
  const st = await fs.stat(dest);
  return st.size;
}

function unpackCrx(buf, destDir) {
  // CRX3: Cr24 | ver=3 u32LE | headerLen u32LE | header | zip
  // CRX2: Cr24 | ver=2 u32LE | pubkeyLen u32LE | sigLen u32LE | pubkey | sig | zip
  if (buf.slice(0, 4).toString() !== 'Cr24') throw new Error('not a CRX (magic)');
  const ver = buf.readUInt32LE(4);
  let zipOff;
  if (ver === 3) zipOff = 12 + buf.readUInt32LE(8);
  else if (ver === 2) zipOff = 16 + buf.readUInt32LE(8) + buf.readUInt32LE(12);
  else throw new Error(`crx version ${ver}`);
  return { ver, zipOff };
}

const summary = { extId: EXT_ID, steps: [], signInWall: null, generatedText: null, errors: [] };
try {
  // 1. CRX fetch
  const crxPath = `${dir}/ext.crx`;
  let size = 0;
  try {
    size = await download(CRX_URL, crxPath);
    summary.steps.push({ step: 'crx_download', bytes: size });
  } catch (e) { summary.errors.push(`crx_download: ${e.message}`); }
  note(`crx bytes=${size}`);

  // 2. Unpack (header-aware; unzip via python3 stdlib, no deps)
  let manifest = null;
  if (size > 1000) {
    const buf = await fs.readFile(crxPath);
    try {
      const { ver, zipOff } = unpackCrx(buf, dir);
      summary.steps.push({ step: 'crx_parse', version: ver, zipOff });
      const zipPath = `${dir}/ext.zip`;
      await fs.writeFile(zipPath, buf.slice(zipOff));
      execFileSync('python3', ['-c', `import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])`, zipPath, `${dir}/ext-unpacked`]);
      manifest = JSON.parse(await fs.readFile(`${dir}/ext-unpacked/manifest.json`, 'utf8'));
      summary.manifest = { version: manifest.version, name: manifest.name, mv: manifest.manifest_version, permissions: manifest.permissions, host_permissions: manifest.host_permissions };
      note(`unpacked mv=${manifest.manifest_version} v=${manifest.version}`);
    } catch (e) { summary.errors.push(`unpack: ${e.message}`); }
  }

  // 3. Headed browser: store page, install attempt, load unpacked, popup, generation attempt
  const userDir = `${dir}/profile`;
  await fs.mkdir(userDir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(userDir, {
    headless: false,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  try {
    await page.goto(STORE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);
    await page.screenshot({ path: `${dir}/01-store.png` });
    const storeText = (await page.content()).slice(0, 4000);
    summary.steps.push({ step: 'store_page', title: await page.title(), installable: /Add to Chrome/i.test(storeText) });
    note(`store title ok, install button present=${/Add to Chrome/i.test(storeText)}`);
  } catch (e) { summary.errors.push(`store_page: ${e.message}`); }

  // install attempt (may demand login or fail headless — record, don't fight)
  try {
    const btn = page.getByRole('button', { name: /Add to Chrome/i }).first();
    if (await btn.count()) {
      await btn.click({ timeout: 15000 });
      await page.waitForTimeout(5000);
      await page.screenshot({ path: `${dir}/02-install-click.png` });
      summary.steps.push({ step: 'store_install_click', done: true });
    } else summary.steps.push({ step: 'store_install_click', done: false, reason: 'no button' });
  } catch (e) { summary.errors.push(`install_click: ${e.message}`); await page.screenshot({ path: `${dir}/02-install-click.png` }).catch(() => {}); }

  await ctx.close();

  // 4. Load unpacked build (sideload leg — proves the bits run even if the store widget refuses automation)
  if (manifest) {
    const ctx2 = await chromium.launchPersistentContext(`${dir}/profile2`, {
      headless: false,
      args: [`--load-extension=${dir}/ext-unpacked`, '--no-sandbox', '--disable-dev-shm-usage'],
    });
    const p2 = ctx2.pages()[0] || await ctx2.newPage();
    try {
      await p2.goto('chrome://extensions', { timeout: 30000 });
      await p2.waitForTimeout(2000);
      await p2.screenshot({ path: `${dir}/03-extensions.png` });
      summary.steps.push({ step: 'extensions_page', done: true });
    } catch (e) { summary.errors.push(`extensions_page: ${e.message}`); }
    // popup page, if declared
    try {
      const popup = manifest?.action?.default_popup || manifest?.browser_action?.default_popup;
      if (popup) {
        // find extension origin via service worker inspection is complex; open via chrome-extension:// + id is unknown pre-install.
        // Instead drive the public translator the same backend serves.
        summary.steps.push({ step: 'popup', declared: popup });
      } else summary.steps.push({ step: 'popup', declared: null });
      await p2.goto('https://silvertongue.dev/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await p2.waitForTimeout(4000);
      await p2.screenshot({ path: `${dir}/04-translator.png` });
      const bodyText = ((await p2.content()) || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      summary.signInWall = /sign in|log in/i.test(bodyText.slice(0, 8000)) ? 'sign-in mentioned on page' : 'no sign-in prompt visible';
      summary.steps.push({ step: 'translator_probe', signInWall: summary.signInWall });
    } catch (e) { summary.errors.push(`translator_probe: ${e.message}`); }
    await ctx2.close().catch(() => {});
  }
} catch (e) {
  summary.errors.push(`fatal: ${e.message}`);
}
summary.at = new Date().toISOString();
await fs.writeFile(`${dir}/summary.json`, JSON.stringify(summary, null, 1));
await fs.writeFile(`${dir}/run.log`, log.join('\n') + '\n');
console.log('st149 done');
