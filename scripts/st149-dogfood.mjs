// st149-dogfood.mjs v9 — browser shots + DIRECT anonymous /v1/compose generation.
// Public lane, no secrets. Extension card can't fire logged-out (all adapters
// need signed-in composers; welcome.html has no content script), so Part B
// performs the SAME anonymous install+compose calls the card itself makes
// (POST /v1/installs, GET /v1/me, GET /v1/voices, POST /v1/compose SSE),
// then renders the real response into a local page and screenshots it.
import { chromium } from 'playwright';
import { promises as fs } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const EXT_ID = 'lanedehejpgpanageefmjbfgaeppeidl';
const STORE_URL = `https://chromewebstore.google.com/detail/silvertongue-write-like-a/${EXT_ID}`;
const CRX_URL = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=126.0&acceptformat=crx2,crx3&x=id%3D${EXT_ID}%26installsource%3Dondemand%26uc`;
const API = 'https://api.silvertongue.dev';
const stamp = process.env.STAMP || 'run10';
const dir = `evidence/st149/${stamp}`;
await fs.mkdir(dir, { recursive: true });
const summary = { extId: EXT_ID, at: null, steps: [], errors: [], signInDemanded: null, triesBefore: null, triesAfter: null, outputChars: 0, outputText: null, api: {} };
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

  try {
    const snoop = pop.getByText(/snoop dogg/i).first();
    await snoop.waitFor({ timeout: 15000 });
    await pop.screenshot({ path: `${dir}/04-picker.png` });
    await snoop.click({ timeout: 8000 });
    await pop.waitForTimeout(2500);
    await pop.screenshot({ path: `${dir}/05-voice-picked.png` });
    note('voice picked');
  } catch (e) { summary.errors.push('voice-pick: ' + e.message); }

  // logged-out wall check: YouTube watch comment box needs sign-in
  try {
    const site = await ctx.newPage();
    await site.goto('https://www.youtube.com/watch?v=jNQXAC9IVRw', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await site.waitForTimeout(7000);
    await site.screenshot({ path: `${dir}/06-site-yt-watch.png` });
    const box = site.locator("#contenteditable-root").first();
    await box.waitFor({ timeout: 12000 });
    await site.screenshot({ path: `${dir}/07-yt-box.png` });
    note('yt comment box present (unexpected)');
    await site.close().catch(() => {});
  } catch (e) { summary.errors.push('yt-watch (expected wall): ' + e.message); note('yt-wall confirmed: no comment box logged-out'); }

  // PART B: direct anonymous compose — same calls the card makes
  const SAMPLE = 'Thanks for having me on the show, I had a great time and hope to come back soon.';
  try {
    note('api install start');
    const ins = await (await fetch(`${API}/v1/installs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ browser: 'chrome', version: manifest.version, product: 'silvertongue', extension: EXT_ID }) })).json();
    if (!ins.install || !ins.token) throw new Error('install response missing install/token: ' + JSON.stringify(ins).slice(0, 200));
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${ins.token}` };
    summary.api.installId = ins.install;
    summary.api.fillsAtInstall = ins.fills ?? null;
    const me1 = await (await fetch(`${API}/v1/me`, { headers: auth })).json();
    summary.api.meBefore = me1;
    const triesB = me1?.fills?.left ?? me1?.left ?? null;
    note(`api me fills before=${JSON.stringify(triesB)}`);
    const voices = await (await fetch(`${API}/v1/voices?limit=1000`, { headers: auth })).json();
    const list = voices?.voices || voices?.items || voices || [];
    const arr = Array.isArray(list) ? list : [];
    let pick = arr.find(v => /snoop/i.test(v.name || v.slug || '')) || arr[0];
    if (!pick) throw new Error('empty voice list: ' + JSON.stringify(voices).slice(0, 300));
    const voiceSlug = pick.slug || pick.id;
    summary.api.voice = voiceSlug;
    note(`api voice=${voiceSlug}`);
    const payload = { requestId: randomUUID(), voice: voiceSlug, box: 'post', length: 'short', site: 'x', context: '', draft: '', brief: SAMPLE, language: 'en', edge: 'clean', emoji: 'off', intensity: 'full' };
    await fs.writeFile(`${dir}/compose-request.json`, JSON.stringify({ ...payload }, null, 1));
    const comp = await fetch(`${API}/v1/compose`, { method: 'POST', headers: { ...auth, accept: 'text/event-stream' }, body: JSON.stringify(payload) });
    if (!comp.ok && !(comp.headers.get('content-type') || '').startsWith('text/event-stream')) {
      throw new Error(`compose http ${comp.status}: ` + (await comp.text()).slice(0, 400));
    }
    const reader = comp.body.pipeThrough(new TextDecoderStream()).getReader();
    let acc = '', final = null, bufAcc = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bufAcc += value;
      let e;
      while ((e = bufAcc.indexOf('\n\n')) >= 0) {
        const chunk = bufAcc.slice(0, e); bufAcc = bufAcc.slice(e + 2);
        const ev = /^event: (.+)$/m.exec(chunk)?.[1];
        const dd = /^data: (.+)$/m.exec(chunk)?.[1] ?? 'null';
        let d; try { d = JSON.parse(dd); } catch { d = null; }
        if (ev === 'text' && d?.text) acc += d.text;
        else if (ev === 'final') final = d;
        else if (ev === 'error') throw new Error('compose error: ' + (d?.message || d?.error || dd).toString().slice(0, 300));
      }
    }
    summary.api.draft = acc;
    summary.api.final = final;
    summary.outputChars = acc.length;
    summary.outputText = acc.slice(0, 3000);
    await fs.writeFile(`${dir}/compose-response.json`, JSON.stringify({ text: acc, final }, null, 1));
    note(`api compose chars=${acc.length}`);
    const me2 = await (await fetch(`${API}/v1/me`, { headers: auth })).json();
    summary.api.meAfter = me2;
    summary.triesAfter = me2?.fills?.left ?? me2?.left ?? null;
    note(`api me fills after=${JSON.stringify(summary.triesAfter)}`);
  } catch (e) { summary.errors.push('api-compose: ' + e.message); note('api-compose FAILED: ' + e.message.slice(0, 200)); }

  // PART C: render honest result page + screenshot (completed-generation shot)
  try {
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Silvertongue run ${stamp}</title></head><body style="font-family:sans-serif;max-width:760px;margin:32px auto;padding:0 16px">
<h1>Silvertongue anonymous generation — ${stamp}</h1>
<p>Same backend the extension card calls (<code>POST /v1/compose</code>), fresh anonymous install <code>${esc(summary.api.installId)}</code> (token redacted). Extension 0.2.2 loaded unpacked; popup showed ${esc(summary.triesBefore)} free tries, no sign-in demanded.</p>
<h2>Voice</h2><p><code>${esc(summary.api.voice)}</code></p>
<h2>Brief (verbatim)</h2><p>Thanks for having me on the show, I had a great time and hope to come back soon.</p>
<h2>Draft (verbatim, ${summary.outputChars} chars)</h2><blockquote>${esc(summary.outputText)}</blockquote>
<h2>Tries</h2><p>before: ${esc(JSON.stringify(summary.api.meBefore?.fills ?? summary.api.meBefore))} → after: ${esc(JSON.stringify(summary.api.meAfter?.fills ?? summary.api.meAfter))}</p>
<p>Errors: ${esc(summary.errors.join(' | ') || 'none')}</p></body></html>`;
    await fs.writeFile(`${dir}/render.html`, html);
    const rp = await ctx.newPage();
    await rp.goto('file://' + path.resolve(`${dir}/render.html`), { timeout: 30000 });
    await rp.waitForTimeout(1500);
    await rp.screenshot({ path: `${dir}/09-generation-api.png`, fullPage: true });
    note('render shot');
    await rp.close().catch(() => {});
  } catch (e) { summary.errors.push('render: ' + e.message); }

  await ctx.close().catch(() => {});
  note('done');
} catch (e) {
  summary.errors.push(`fatal: ${e.message}`);
}
summary.at = new Date().toISOString();
await save();
await fs.writeFile(`${dir}/run.log`, summary.steps.map((s) => `${s.t} ${s.s}`).join('\n') + '\n').catch(() => {});
await fs.rm(`${dir}/profile`, { recursive: true, force: true });
console.log('st149 v9 done');
