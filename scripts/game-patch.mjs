// game-patch v2: applies ONE feature to base level-2.html. Exact anchors; fails loud on miss.
// Env: FEATURE = title|log|gold|seed|help|potion ; IN = base path ; OUT = out path.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const F = process.env.FEATURE || '';
let s = readFileSync(process.env.IN || 'evidence/game-base/level-2.html', 'utf8');
let n = 0;
const rep = (oldStr, newStr) => {
  if (!s.includes(oldStr)) { console.error('ANCHOR MISS:\n' + oldStr.slice(0, 200)); process.exit(1); }
  s = s.replace(oldStr, () => newStr);
  n++;
};
const cssGold = '  .stairs { color: #e3b341; }';
const cssPotion = '  .potion { color: #7ee787; }';
const monstersRet = '    const monsters = spawns.slice(0, monsterCount).map((spawn) => ({ ...spawn, hp: MONSTER_HP }))\n    return { grid, player: { ...start }, monsters, rooms: rooms.length }';
const wallLine = '    if (c === \'#\') return `<span class="wall${dim}">#</span>`';
const bestLine = 'document.getElementById(\'best\').textContent = `Best ${bestDepth}`';
const moveLine = '  if (!occupied(nx, ny)) { player.x = nx; player.y = ny }';

if (F === 'title') {
  rep('let newBestThisRun = false', 'let newBestThisRun = false\nlet title = true');
  rep('function draw() {\n  const vis = computeFov()',
    'function draw() {\n  if (title) {\n    document.getElementById(\'map\').innerHTML = \'<span class="stairs">DUNGEON CRAWLER</span>\'\n    document.getElementById(\'depth\').textContent = \'Depth 1\'\n    document.getElementById(\'best\').textContent = \'\'\n    document.getElementById(\'hp\').textContent = \'\'\n    document.getElementById(\'msg\').textContent = \'Arrows or WASD to move - R to restart - Press any key\'\n    return\n  }\n  const vis = computeFov()');
  rep('addEventListener(\'keydown\', (e) => {\n  if (e.key === \'r\' || e.key === \'R\') { reset(); return }',
    'addEventListener(\'keydown\', (e) => {\n  if (title) { title = false; reset(); return }\n  if (e.key === \'r\' || e.key === \'R\') {\n    if (state.over) { title = true; draw(); return }\n    reset(); return\n  }');
  rep('turn(...move)\n})\nreset()', 'turn(...move)\n})\nreset()\ntitle = true\ndraw()');
}
if (F === 'log') {
  rep('  <div id="msg"></div>', '  <div id="msg"></div>\n  <div id="log" aria-label="message log"></div>');
  rep('let newBestThisRun = false',
    'let newBestThisRun = false\nlet logMsgs = []\nfunction say(m) {\n  logMsgs.unshift(m)\n  logMsgs = logMsgs.slice(0, 3)\n  const el = document.getElementById(\'log\')\n  if (el) el.innerHTML = logMsgs.map((t) => `<div>${t}</div>`).join(\'\')\n}');
  rep('    target.hp -= 1', '    target.hp -= 1\n    say(\'You hit the monster\')');
  rep('    if (target.hp <= 0) state.monsters = state.monsters.filter((m) => m !== target)',
    '    if (target.hp <= 0) { state.monsters = state.monsters.filter((m) => m !== target); say(\'The monster dies\') }');
  rep('    if (adjacent || stepToward(m)) state.hp -= 1',
    '    if (adjacent || stepToward(m)) { state.hp -= 1; say(\'You take 1 damage\') }');
  rep('    recordDepth()\n    return draw()', '    say(\'You go deeper\')\n    recordDepth()\n    return draw()');
  rep('function reset() {\n  newBestThisRun = false', 'function reset() {\n  newBestThisRun = false\n  logMsgs = []\n  document.getElementById(\'log\').innerHTML = \'\'');
}
if (F === 'gold') {
  rep('<span id="best"></span> <span id="hp"></span>', '<span id="best"></span> <span id="gold"></span> <span id="hp"></span>');
  rep(cssGold, cssGold + '\n  .gold { color: #e3b341; }');
  rep(monstersRet,
    '    const monsters = spawns.slice(0, monsterCount).map((spawn) => ({ ...spawn, hp: MONSTER_HP }))\n    const taken = new Set(monsters.map((m) => `${m.x},${m.y}`))\n    taken.add(`${start.x},${start.y}`)\n    taken.add(`${exit.x},${exit.y}`)\n    const goldCells = []\n    grid.forEach((row, y) => row.forEach((c, x) => { if (c === \'.\' && !taken.has(`${x},${y}`)) goldCells.push({ x, y }) }))\n    for (const c of goldCells.sort(() => Math.random() - 0.5).slice(0, rand(3, 6))) grid[c.y][c.x] = \'$\'\n    return { grid, player: { ...start }, monsters, rooms: rooms.length }');
  rep('state = { ...generate(), depth: 1, hp: MAX_HP, over: null, seen: new Set() }',
    'state = { ...generate(), depth: 1, hp: MAX_HP, gold: 0, over: null, seen: new Set() }');
  rep('    const { hp, depth, rooms } = state', '    const { hp, depth, rooms, gold } = state');
  rep('      depth: depth + 1, hp, over: null, seen: new Set() }', '      depth: depth + 1, hp, gold, over: null, seen: new Set() }');
  rep(moveLine, moveLine + '\n  if (state.grid[player.y][player.x] === \'$\') { state.grid[player.y][player.x] = \'.\'; state.gold += 1 }');
  rep(wallLine, '    if (c === \'$\') return `<span class="gold${dim}">$</span>`\n' + wallLine);
  rep(bestLine, bestLine + '\n  document.getElementById(\'gold\').textContent = `Gold ${state.gold}`');
}
if (F === 'seed') {
  rep('<span id="best"></span> <span id="hp"></span>', '<span id="best"></span> <span id="seed"></span> <span id="hp"></span>');
  rep('const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1))',
    'const SEED_PARAM = new URLSearchParams(location.search).get(\'seed\')\nconst SEED = SEED_PARAM === null ? String(Math.floor(Math.random() * 1000000000)) : SEED_PARAM\nlet __sd = 1779033703 ^ SEED.length\nfor (let i = 0; i < SEED.length; i++) { __sd = Math.imul(__sd ^ SEED.charCodeAt(i), 3432918353); __sd = (__sd << 13) | (__sd >>> 19) }\n__sd >>>= 0\nconst rng = () => { __sd |= 0; __sd = (__sd + 0x6D2B79F5) | 0; let t = Math.imul(__sd ^ (__sd >>> 15), 1 | __sd); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }\nconst rand = (min, max) => min + Math.floor(rng() * (max - min + 1))');
  rep('  const horizontalFirst = Math.random() < 0.5', '  const horizontalFirst = rng() < 0.5');
  rep('    const spawns = floor.sort(() => Math.random() - 0.5).concat(nearby.sort(() => Math.random() - 0.5))',
    '    const shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const k = Math.floor(rng() * (i + 1)); const tmp = arr[i]; arr[i] = arr[k]; arr[k] = tmp } return arr }\n    const spawns = shuffle(floor).concat(shuffle(nearby))');
  rep(bestLine, bestLine + '\n  document.getElementById(\'seed\').textContent = `Seed ${SEED}`');
}
if (F === 'help') {
  rep('  <div id="msg"></div>', '  <div id="msg"></div>\n  <div id="help" hidden>Arrows/WASD: move - R: restart - ?: toggle this help</div>');
  rep('addEventListener(\'keydown\', (e) => {\n  if (e.key === \'r\' || e.key === \'R\') { reset(); return }',
    'addEventListener(\'keydown\', (e) => {\n  if (e.key === \'?\') { const el = document.getElementById(\'help\'); el.hidden = !el.hidden; return }\n  if (e.key === \'Escape\') { document.getElementById(\'help\').hidden = true; return }\n  if (!document.getElementById(\'help\').hidden) return\n  if (e.key === \'r\' || e.key === \'R\') { reset(); return }');
}
if (F === 'potion') {
  rep(cssGold, cssGold + '\n' + cssPotion);
  rep(monstersRet,
    '    const monsters = spawns.slice(0, monsterCount).map((spawn) => ({ ...spawn, hp: MONSTER_HP }))\n    const free = []\n    grid.forEach((row, y) => row.forEach((c, x) => { if (c === \'.\' && !(x === start.x && y === start.y) && !(x === exit.x && y === exit.y) && !monsters.some((m) => m.x === x && m.y === y)) free.push({ x, y }) }))\n    if (free.length) { const pp = free[Math.floor(Math.random() * free.length)]; grid[pp.y][pp.x] = \'!\' }\n    return { grid, player: { ...start }, monsters, rooms: rooms.length }');
  rep(moveLine, moveLine + '\n  if (state.grid[player.y][player.x] === \'!\') { state.grid[player.y][player.x] = \'.\'; state.hp = Math.min(MAX_HP, state.hp + 2) }');
  rep(wallLine, '    if (c === \'!\') return `<span class="potion${dim}">!</span>`\n' + wallLine);
}
if (!['title', 'log', 'gold', 'seed', 'help', 'potion'].includes(F)) { console.error('unknown FEATURE'); process.exit(1); }
mkdirSync(dirname(process.env.OUT || 'out/level-2.html'), { recursive: true });
writeFileSync(process.env.OUT || 'out/level-2.html', s);
console.log(`patched feature=${F} replacements=${n} bytes=${s.length}`);
