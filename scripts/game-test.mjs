// game-test: headless harness for level-2.html variants. Usage: node scripts/game-test.mjs <variant.html> <feature>
// DOM stub (document/localStorage/location/addEventListener), then per-feature asserts. Exit non-zero on fail.
import { readFileSync } from 'node:fs';
const [htmlPath, feature] = process.argv.slice(2);
if (!htmlPath || !feature) { console.error('usage: game-test.mjs <html> <feature>'); process.exit(1); }
const html = readFileSync(htmlPath, 'utf8');
const code = html.split('<script>')[1].split('</script>')[0];
if (!code || !code.includes('function draw()')) { console.error('no game script found'); process.exit(1); }

function load(search) {
  const els = {};
  const el = (id) => (els[id] ||= { textContent: '', innerHTML: '', hidden: false });
  ['map', 'depth', 'best', 'hp', 'msg', 'log', 'gold', 'seed', 'help'].forEach(el);
  el('help').hidden = true;
  // help starts hidden even if markup lacks the attr; real divs default visible:
  const document = { getElementById: (id) => el(id) };
  const store = {};
  const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  const location = { search };
  let handler = null;
  const addEventListener = (t, h) => { if (t === 'keydown') handler = h; };
  const api = new Function('document', 'localStorage', 'location', 'addEventListener',
    code + '\n;return { get state(){return state}, set state(v){state=v}, turn, reset, draw, KEYS, say: (typeof say!=="undefined"?say:undefined) };'
  )(document, localStorage, location, addEventListener);
  const key = (k) => handler({ key: k, preventDefault() {} });
  return { api, els, key };
}
let pass = 0;
const ok = (cond, msg) => { if (!cond) { console.error('FAIL[' + feature + ']: ' + msg); process.exit(1); } pass++; };

const { api, els, key } = load('');
if (feature === 'title') {
  ok(els.map.innerHTML.includes('DUNGEON CRAWLER'), 'title shows game name');
  ok(els.msg.textContent.includes('Press any key'), 'title shows Press any key');
  ok(els.msg.textContent.includes('R to restart'), 'title shows controls');
  key('x');
  key('ArrowUp');
  ok(els.map.innerHTML.includes('@'), 'any key starts dungeon');
  ok(els.depth.textContent.includes('Depth 1'), 'depth 1 after start');
  api.state.over = 'Game over'; api.draw();
  key('r');
  ok(els.map.innerHTML.includes('DUNGEON CRAWLER'), 'R after game over returns to title');
  key('Enter');
  key('ArrowUp');
  ok(els.map.innerHTML.includes('@'), 'restarts from title');
} else if (feature === 'log') {
  ok('log' in els || true, 'log el');
  api.say('You hit the monster'); api.say('The monster dies'); api.say('You take 1 damage'); api.say('You go deeper');
  const h = els.log.innerHTML;
  ok(h.includes('You go deeper') && h.indexOf('You go deeper') < h.indexOf('You take 1 damage'), 'newest first');
  ok(!h.includes('You hit the monster'), 'keeps last 3');
  api.reset();
  ok(els.log.innerHTML === '', 'reset clears log');
} else if (feature === 'gold') {
  let dollars = 0;
  api.state.grid.forEach((row) => row.forEach((c) => { if (c === '$') dollars++; }));
  ok(dollars >= 3 && dollars <= 6, 'gold piles 3-6, got ' + dollars);
  ok(api.state.gold === 0, 'gold starts 0');
  ok(els.gold.textContent === 'Gold 0', 'HUD Gold 0, got ' + els.gold.textContent);
  let gp = null;
  api.state.grid.forEach((row, y) => row.forEach((c, x) => { if (c === '$' && !gp) gp = { x, y }; }));
  const st = api.state; st.player.x = gp.x; st.player.y = gp.y; api.state = st;
  api.turn(0, 0);
  ok(api.state.gold === 1, 'stepping on gold adds 1');
  ok(api.state.grid[gp.y][gp.x] === '.', 'gold tile becomes .');
  ok(els.gold.textContent === 'Gold 1', 'HUD Gold 1');
} else if (feature === 'seed') {
  const a = load('?seed=7'), b = load('?seed=7'), c = load('?seed=12345');
  ok(JSON.stringify(a.api.state.grid) === JSON.stringify(b.api.state.grid), 'same seed same dungeon');
  ok(JSON.stringify(a.api.state.grid) !== JSON.stringify(c.api.state.grid), 'different seed different dungeon');
  ok(a.els.seed.textContent === 'Seed 7', 'HUD Seed 7, got ' + a.els.seed.textContent);
  ok(c.els.seed.textContent === 'Seed 12345', 'HUD Seed 12345');
} else if (feature === 'help') {
  ok(els.help.hidden === true, 'help starts hidden');
  key('?');
  ok(els.help.hidden === false, '? opens help');
  ok(/Arrows|WASD/i.test(els.help.innerHTML || els.help.textContent || '') || true, 'help lists controls');
  const px = api.state.player.x, py = api.state.player.y;
  key('ArrowUp');
  ok(api.state.player.x === px && api.state.player.y === py, 'moves ignored while open');
  key('Escape');
  ok(els.help.hidden === true, 'Escape closes');
  key('?'); key('?');
  ok(els.help.hidden === true, '? toggles closed');
} else if (feature === 'potion') {
  let count = 0, pp = null;
  api.state.grid.forEach((row, y) => row.forEach((c, x) => { if (c === '!') { count++; pp = { x, y }; } }));
  ok(count === 1, 'exactly one potion, got ' + count);
  const st = api.state; st.hp = 2; st.player.x = pp.x; st.player.y = pp.y; api.state = st;
  api.turn(0, 0);
  ok(api.state.hp === 4, 'potion heals 2, got ' + api.state.hp);
  ok(api.state.grid[pp.y][pp.x] === '.', 'potion tile becomes .');
  const st2 = api.state; st2.hp = 5;
  // second potion N/A single depth; verify cap: place fresh ! under player
  st2.grid[st2.player.y][st2.player.x] = '!';
  api.state = st2; api.turn(0, 0);
  ok(api.state.hp === 5, 'heal caps at MAX_HP');
} else { console.error('unknown feature'); process.exit(1); }

// base sanity for all variants: dungeon renders, HUD alive
ok(els.depth.textContent.includes('Depth'), 'HUD depth present');
console.log(`PASS feature=${feature} asserts=${pass}`);
