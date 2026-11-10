// Hourly public bounty radar — all endpoints public, no secrets, quiet logs.
// Polls: dailydollar feed, Frantic feed, Taskmarket Base open, DeskCrew,
// Go-Hybrid triage issues (passive watch: #4073 + rival #4075 + #3933).
const out = { t: new Date().toISOString(), sources: {} };
async function get(name, url, pick) {
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'bounty-watch/1.0' } });
    const t = await r.text();
    let summary = { status: r.status, bytes: t.length };
    try {
      const j = JSON.parse(t);
      if (pick) summary.pick = pick(j);
      else {
        const items = j.items || j.data || j.tasks || j.bounties || j.contests || [];
        summary.count = j.count ?? (Array.isArray(items) ? items.length : undefined);
        summary.ids = (Array.isArray(items) ? items : []).slice(0, 20).map((x) => x.id || x.number || x.referenceCode || x.ticketId);
      }
    } catch { summary.note = 'non-json-or-truncated'; }
    out.sources[name] = summary;
  } catch (e) { out.sources[name] = { error: String(e).slice(0, 120) }; }
}
await get('ddb', 'https://agent-bounty-feed.dailydollar.workers.dev/feed.json');
await get('frantic', 'https://gofrantic.com/feed.json');
await get('tm_base', 'https://api.taskmarket.dev/api/tasks?status=open&mode=bounty&chainId=8453&limit=50');
await get('deskcrew', 'https://deskcrew.io/api/arena/contests');
const gh = (j) => ({ state: j.state, merged: j.merged ?? null, labels: (j.labels || []).map((l) => l.name), comments: j.comments });
await get('gohybrid_4073', 'https://api.github.com/repos/limitlessprojects/Go-Hybrid/issues/4073', gh);
await get('gohybrid_4075', 'https://api.github.com/repos/limitlessprojects/Go-Hybrid/pulls/4075', gh);
await get('gohybrid_3933', 'https://api.github.com/repos/limitlessprojects/Go-Hybrid/issues/3933', gh);
// CoW gasless-route liveness (gas bought JUST-IN-TIME only: convert only as part of
// executing a named +EV gas-gated play, never speculatively — see CURRENT_TASK ironman note)
try {
  const r = await fetch('https://api.cow.fi/base/api/v1/quote', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'bounty-watch/1.0' },
    body: JSON.stringify({ sellToken: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', buyToken: '0x4200000000000000000000000000000000000006', sellAmountBeforeFee: '1000000', kind: 'sell', from: '0x0000000000000000000000000000000000000000', appData: '{"version":"1.1.0","metadata":{}}' }) });
  const t = await r.text();
  let pick = { status: r.status };
  try { const q = JSON.parse(t).quote; if (q) pick = { status: r.status, sellAmount: q.sellAmount, buyAmount: q.buyAmount, feeAmount: q.feeAmount }; }
  catch { pick.note = t.slice(0, 120); }
  out.sources.cow_native1 = pick;
} catch (e) { out.sources.cow_native1 = { error: String(e).slice(0, 120) }; }
await (await import('node:fs/promises')).writeFile('watch-out.json', JSON.stringify(out, null, 1));
console.log('watch ok', JSON.stringify(Object.fromEntries(Object.entries(out.sources).map(([k, v]) => [k, v.status ?? v.error]))));
