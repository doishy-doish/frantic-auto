// Hourly public bounty radar — all endpoints public, no secrets, quiet logs.
// Polls: dailydollar feed, Frantic feed, Taskmarket Base open, DeskCrew arena.
const out = { t: new Date().toISOString(), sources: {} };
async function get(name, url) {
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'bounty-watch/1.0' } });
    const t = await r.text();
    let summary = { status: r.status, bytes: t.length };
    try {
      const j = JSON.parse(t);
      const items = j.items || j.data || j.tasks || j.bounties || j.contests || [];
      summary.count = j.count ?? (Array.isArray(items) ? items.length : undefined);
      summary.ids = (Array.isArray(items) ? items : []).slice(0, 20).map((x) => x.id || x.number || x.referenceCode || x.ticketId);
    } catch { summary.note = 'non-json-or-truncated'; }
    out.sources[name] = summary;
  } catch (e) { out.sources[name] = { error: String(e).slice(0, 120) }; }
}
await get('ddb', 'https://agent-bounty-feed.dailydollar.workers.dev/feed.json');
await get('frantic', 'https://gofrantic.com/feed.json');
await get('tm_base', 'https://api.taskmarket.dev/api/tasks?status=open&mode=bounty&chainId=8453&limit=50');
await get('deskcrew', 'https://deskcrew.io/api/arena/contests');
await (await import('node:fs/promises')).writeFile('watch-out.json', JSON.stringify(out, null, 1));
console.log('watch ok', JSON.stringify(Object.fromEntries(Object.entries(out.sources).map(([k, v]) => [k, v.status ?? v.error]))));
