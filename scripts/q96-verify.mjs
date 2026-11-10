// Q96 independent verification — PUBLIC lane (scramble protocol).
// Runs on GitHub Actions via workflow_dispatch. Public BSC data only:
// no secrets, no encryption needed. Stdout carries counts only.
const EP = "https://bsc.publicnode.com";
const TREAS = "0x7C34E9e21eE28A49Ff0b84B61774119E6633359f";
const FJ = "0x90c8889f428F9Ebb77BB8f15CAD3a50a9aC680df";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(method, params, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(EP, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const j = await r.json();
      if (j.result !== undefined) return j.result;
      const msg = JSON.stringify(j).slice(0, 100);
      if (/limit|429|busy|rate|exceed/i.test(msg) && i < tries - 1) { await sleep(1500 * (i + 1)); continue; }
      throw new Error("RPC " + method + ": " + msg);
    } catch (e) { if (i < tries - 1) { await sleep(1200); continue; } throw e; }
  }
}
const T0 = Date.parse("2026-11-05T05:00:00Z") / 1000; // 11-05 00:00 COT
const T1 = Date.parse("2026-11-06T05:00:00Z") / 1000; // 11-06 00:00 COT
const tsOf = async (b) => parseInt((await rpc("eth_getBlockByNumber", ["0x" + b.toString(16), false])).timestamp, 16);
const head = parseInt(await rpc("eth_blockNumber", []), 16);
async function bisect(target, lo, hi) {
  let it = 0;
  while (lo < hi && it++ < 80) { const mid = (lo + hi) >> 1; (await tsOf(mid)) >= target ? hi = mid : lo = mid + 1; }
  return lo;
}
const firstBlock = await bisect(T0, head - 1500000, head);
const lastBlock = (await bisect(T1, head - 1500000, head)) - 1;
const hex = (n) => "0x" + n.toString(16);
const fromTopic = "0x000000000000000000000000" + TREAS.slice(2).toLowerCase();
const transfers = [];
let chunk = 5000, s = firstBlock, calls = 0;
while (s <= lastBlock) {
  const e = Math.min(s + chunk - 1, lastBlock);
  try {
    const logs = await rpc("eth_getLogs", [{ address: FJ, topics: [TRANSFER, fromTopic], fromBlock: hex(s), toBlock: hex(e) }]);
    for (const l of logs) transfers.push({ b: parseInt(l.blockNumber, 16), tx: l.transactionHash, to: "0x" + l.topics[2].slice(26), val: l.data });
    s = e + 1; calls++;
    await sleep(100);
  } catch (err) {
    if (/limit|exceed|429|busy|rate/i.test(String(err)) && chunk > 125) { chunk = Math.floor(chunk / 2); await sleep(1500); continue; }
    throw err;
  }
}
let tot = 0n;
for (const t of transfers) tot += BigInt(t.val);
const out = {
  day: "2026-11-05 COT (UTC-5)", t0: T0, t1: T1, firstBlock, lastBlock,
  firstTs: await tsOf(firstBlock), lastTs: await tsOf(lastBlock),
  n: transfers.length, totalFJ: (Number(tot) / 1e18).toFixed(2),
  transfers, calls, runner: "github-actions", ranAt: new Date().toISOString(),
};
await (await import("node:fs/promises")).writeFile("q96-verify.json", JSON.stringify(out, null, 1));
console.log(JSON.stringify({ firstBlock, lastBlock, n: out.n, totalFJ: out.totalFJ, calls }));
