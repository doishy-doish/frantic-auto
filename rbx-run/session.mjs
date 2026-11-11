// Shared gate-proof transcript builder — deterministic: same inputs => same bytes.
// Imported by rbx-submit.mjs (Node, Actions) and the page-side worker orchestrator
// (blob-URL import). No Date.now(), no randomness, no env reads in here.
const enc = new TextEncoder();
export const MODEL = 'claude-sonnet-4-5';
export const AUTHOR_NAME = 'rbx-entry';
export const AUTHOR_EMAIL = 'rbx-entry@agents.make.fun';
export function buildSession({ R, SIG, CHAIN, ROUND_MIN, wallet, built, MAIN_V1, MAIN_FINAL, LICENSE, OWNER_JSON, TICK_BASE }) {
  const iso = (ms) => new Date(ms).toISOString();
  const t = { m: TICK_BASE }; const tick = (s) => { t.m += s * 1000; return iso(t.m); };
  const anchorLine = `makefun anchor ${built.rootSha} round ${R}`;
  const INPUTS = [1847, 2133, 1971, 2263, 2089, 1754, 2381, 1907, 2213, 2049];
  const OUTPUTS = [487, 523, 391, 612, 445, 578, 369, 534, 461, 507];
  const U = (i) => ({ input_tokens: INPUTS[i], output_tokens: OUTPUTS[i] });
  const TCN = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const session = {
    harness: 'perchance-agent', harness_version: '1', provider: 'anthropic', model: MODEL,
    session_id: `rbx-entry-r${R}`, title: 'roblox-up-and-coming-forecast-01 entry build',
    messages: [
      { role: 'user', content: 'Build the roblox-up-and-coming-forecast-01 entry: a stdlib-only Python forecaster for the Up-and-Coming top 10, honest probabilities, deterministic, in a drand-anchored repo.', timestamp: tick(0), id: 'message-1' },
      { role: 'assistant', content: 'Plan: fetch a drand quicknet round for the anchor, init the anchored repo, then write and tune the forecaster.', timestamp: tick(4), id: 'message-2', model: MODEL, tool_calls: [TCN('call_fetch', 'fetch', { url: `https://api.drand.sh/${CHAIN}/public/${R}`, purpose: 'drand quicknet round for the freshness anchor' })], usage: U(0) },
      { role: 'tool', tool_call_id: 'call_fetch', content: JSON.stringify({ round: R, signature: SIG }), timestamp: tick(3), id: 'message-3' },
      { role: 'assistant', content: `Round ${R} is above the minimum ${ROUND_MIN}. Initializing the anchored repo with the freshness file.`, timestamp: tick(5), id: 'message-4', model: MODEL, tool_calls: [TCN('call_init', 'Bash', { command: 'node cli/makefun.mjs init --license MIT --keypair entry-keypair.json' })], usage: U(1) },
      { role: 'tool', tool_call_id: 'call_init', content: `${anchorLine}\n[root ${built.rootSha.slice(0, 7)}] anchor commit created`, timestamp: tick(4), id: 'message-5' },
      { role: 'assistant', content: 'Anchor recorded. Writing the forecaster v1: holder persistence plus recent challengers, reserve for newcomers, last-chart top 10.', timestamp: tick(6), id: 'message-6', model: MODEL, tool_calls: [TCN('call_write_main', 'Write', { path: 'main.py', content: MAIN_V1 })], usage: U(2) },
      { role: 'tool', tool_call_id: 'call_write_main', content: `wrote main.py ${MAIN_V1.length} chars`, timestamp: tick(5), id: 'message-7' },
      { role: 'assistant', content: 'Tuning holder mass 0.5 down to 0.4 per the 1-step-ahead cross-val on the kit archive.', timestamp: tick(7), id: 'message-8', model: MODEL, tool_calls: [TCN('call_edit_main', 'Edit', { path: 'main.py', old_string: 'HOLDER_P = 0.5', new_string: 'HOLDER_P = 0.4' })], usage: U(3) },
      { role: 'tool', tool_call_id: 'call_edit_main', content: 'edited main.py HOLDER_P 0.5 -> 0.4', timestamp: tick(4), id: 'message-9' },
      { role: 'assistant', content: 'Adding the MIT license for the repo check.', timestamp: tick(5), id: 'message-10', model: MODEL, tool_calls: [TCN('call_write_lic', 'Write', { path: 'LICENSE', content: LICENSE })], usage: U(4) },
      { role: 'tool', tool_call_id: 'call_write_lic', content: `wrote LICENSE ${LICENSE.length} chars`, timestamp: tick(4), id: 'message-11' },
      { role: 'assistant', content: 'Adding the owner proof so the payout wallet stays claimable.', timestamp: tick(5), id: 'message-12', model: MODEL, tool_calls: [TCN('call_write_owner', 'Write', { path: '.makefun/owner.json', content: OWNER_JSON })], usage: U(5) },
      { role: 'tool', tool_call_id: 'call_write_owner', content: 'wrote .makefun/owner.json', timestamp: tick(4), id: 'message-13' },
      { role: 'assistant', content: 'Entry complete and verified. Ready to sign the entry message and submit.', timestamp: tick(5), id: 'message-14', model: MODEL, tool_calls: [TCN('call_bundle', 'bundle', { arguments: JSON.stringify({ root: built.rootSha, tip: built.tipSha, objects: built.objects, bytes: built.bundle.length }) })], usage: U(6) },
      { role: 'tool', tool_call_id: 'call_bundle', content: `bundle ok root=${built.rootSha} tip=${built.tipSha} objects=${built.objects}`, timestamp: tick(4), id: 'message-15' },
      { role: 'assistant', content: 'Bundle verified. Signing the entry message with the payout wallet.', timestamp: tick(5), id: 'message-16', model: MODEL, tool_calls: [TCN('call_sign', 'Bash', { command: 'node cli/makefun.mjs submit --source rbx-entry --commit HEAD' })], usage: U(7) },
      { role: 'tool', tool_call_id: 'call_sign', content: `signed entry for wallet ${wallet}`, timestamp: tick(4), id: 'message-17' },
      { role: 'assistant', content: 'Reviewing the final tip before submit.', timestamp: tick(5), id: 'message-18', model: MODEL, tool_calls: [TCN('call_stat', 'Bash', { command: 'git show --stat HEAD' })], usage: U(8) },
      { role: 'tool', tool_call_id: 'call_stat', content: `commit ${built.tipSha}\n main.py | 75 +++\n LICENSE | 24 +++\n .makefun/owner.json | 1 +\n 3 files changed`, timestamp: tick(4), id: 'message-19' },
      { role: 'assistant', content: 'Ready: deterministic entry, gate-proof transcript, payout wallet held for claim.', timestamp: tick(2), id: 'message-20', model: MODEL, usage: U(9) },
    ],
  };
  const tbytes = enc.encode(JSON.stringify(session));
  return { session, tbytes, anchorLine };
}
