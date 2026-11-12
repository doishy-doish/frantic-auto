// st149-dogfood.mjs v2 — deep drive: load unpacked 0.2.2, popup, anonymous
// generation with screenshots. Public lane, no secrets. Evidence -> evidence/st149/<stamp>/.
// Runner: xvfb-run -a node scripts/st149-dogfood.mjs
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
const stamp = process.env.STAMP || 'run2';
const dir = `${OUT}/${stamp}`;
await fs.mkdir(dir, { recursive: true });
const log = [];
const note = (s) => { log.push(`${new Date().toISOString()} ${s}`); console.log('st149:', s); };
const summary = { extId: EXT_ID, at: null, steps: [], errors: [], signInDemanded: null, triesBefore: null, triesAfter: null, outputText: null, outputChars: 0 };

async function shot(p, dest) {
  await p.screenshot({ path: `${dir}/${dest}` });
  summary.steps.push({ step: `shot_${dest}`, done: true });
}

try {
  // 1. package (fast, proven in run1)
  const crxPath = `${dir}/ext.crx`;
  const r = await fetch(CRX_URL, { redirect: 'follow' });
  if (!r.ok) throw new Error(`crx http ${r.status}`);
  await pipeline(r.body, createWriteStream(crxPath));
  const buf = await fs.readFile(crxPath);
  if (buf.slice(0, 4).toString() !== 'Cr24') throw new Error('not a CRX');
  const ver = buf.readUInt32LE(4);
  const zipOff = ver === 3 ? 12 + buf.readUInt32LE(8) : 16 + buf.readUInt32LE(8) + buf.readUInt32LE(12);
  await fs.writeFile(`${dir}/ext.zip`, buf.slice(zipOff));
  execFileSync('python3', ['-c', `import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])`, `${dir}/ext.zip`, `${dir}/ext-unpacked`]);
  const manifest = JSON.parse(await fs.readFile(`${dir}/ext-unpacked/manifest.json`, 'utf8'));
  summary.manifest = { version: manifest.version, mv: manifest.manifest_version, popup: manifest?.action?.default_popup };
  note(`pkg v${manifest.version} popup=${summary.manifest.popup}`);

  // 2. headed ctx with unpacked loaded
  const ctx = await chromium.launchPersistentContext(`${dir}/profile`, {
    headless: false,
    args: [`--load-extension=${dir}/ext-unpacked`, '--no-sandbox', '--disable-dev-shm-usage'],
  });

  // extension id via service worker url
  let extId = null;
  for (let i = 0; i < 30 && !extId; i++) {
    const sws = ctx.serviceWorkers();
    if (sws.length) extId = sws[0].url().split('/')[2];
    else await new Promise((rr) => setTimeout(rr, 1000));
  }
  summary.extRuntimeId = extId;
  note(`runtime id=${extId}`);

  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(STORE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  await shot(page, '01-store.png');

  await page.goto('chrome://extensions', { timeout: 30000 });
  await page.waitForTimeout(2000);
  await shot(page, '02-installed.png');

  // 3. popup drive
  if (!extId) throw new Error('no service worker — extension failed to load');
  const pop = await ctx.newPage();
  await pop.goto(`chrome-extension://${extId}/${summary.manifest.popup}`, { timeout: 30000 });
  await pop.waitForTimeout(4000);
  await shot(pop, '03-popup.png');
  const popText = ((await pop.content()) || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const mTry = popText.match(/(\d+)\s+free\s+tr/i);
  summary.triesBefore = mTry ? Number(mTry[1]) : null;
  summary.signInDemanded = /sign in to keep going|continue with google/i.test(popText) && summary.triesBefore === 0;
  summary.steps.push({ step: 'popup_probe', triesBefore: summary.triesBefore, signInDemanded: summary.signInDemanded });
  note(`popup tries=${summary.triesBefore} signInDemanded=${summary.signInDemanded}`);

  // 4. generation attempt (anonymous free try): type, pick voice, generate
  const SAMPLE = 'Thanks for having me on the show, I had a great time and hope to come back soon.';
  const VOICE = 'snoop';
  try {
    // textbox: first visible textarea / contenteditable in popup
    const box = pop.locator('textarea, [contenteditable="true"], input[type="text"]').first();
    await box.waitFor({ timeout: 15000 });
    await box.fill(SAMPLE);
    await pop.waitForTimeout(1000);
    await shot(pop, '04-input.png');
    // voice search/pick
    const voiceHit = pop.getByText(/snoop/i).first();
    if (await voiceHit.count()) {
      await voiceHit.click({ timeout: 8000 }).catch(() => {});
      await pop.waitForTimeout(1500);
    }
    // generate button: Rewrite / Reply / Write / Generate
    const go = pop.getByRole('button', { name: /rewrite|reply|write|generate/i }).first();
    if (await go.count()) {
      await go.click({ timeout: 8000 });
      // wait for streaming to settle: poll for output growth then stillness
      let last = '', still = 0;
      for (let i = 0; i < 40 && still < 3; i++) {
        await pop.waitForTimeout(3000);
        const t = ((await pop.content()) || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        if (t.length === last.length) still++;
        else { still = 0; last = t; }
      }
      await shot(pop, '05-generation.png');
      const finalText = ((await pop.content()) || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      summary.outputChars = finalText.length;
      // output = page text minus chrome; store slice around the sample for the report
      const si = finalText.indexOf('Thanks for having me');
      summary.outputText = si >= 0 ? finalText.slice(Math.max(0, si - 1500), si + 2500) : finalText.slice(-2500);
      const mAfter = finalText.match(/(\d+)\s+free\s+tr/i);
      const mLeft = finalText.match(/(\d+)\s+left/i);
      summary.triesAfter = mAfter ? Number(mAfter[1]) : mLeft ? Number(mLeft[1]) : null;
      summary.steps.push({ step: 'generation', done: true, triesAfter: summary.triesAfter });
      note(`generated chars=${summary.outputChars} triesAfter=${summary.triesAfter}`);
    } else {
      summary.errors.push('no generate button found');
      await shot(pop, '05-generation.png');
    }
  } catch (e) {
    summary.errors.push(`generation: ${e.message}`);
    await shot(pop, '05-generation.png').catch(() => {});
  }

  await ctx.close().catch(() => {});
} catch (e) {
  summary.errors.push(`fatal: ${e.message}`);
}
summary.at = new Date().toISOString();
await fs.writeFile(`${dir}/summary.json`, JSON.stringify(summary, null, 1));
await fs.writeFile(`${dir}/run.log`, log.join('\n') + '\n');
// drop profiles before commit (browser junk, MBs)
await fs.rm(`${dir}/profile`, { recursive: true, force: true });
await fs.rm(`${dir}/profile2`, { recursive: true, force: true });
console.log('st149 v2 done');
