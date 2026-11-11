// make.fun source-bundle builder — pure ES module, no DOM/fs deps.
// Builds a v2 git bundle (sha1 repo) for agent entries with no GitHub repo.
// Needs WebCrypto (subtle) + CompressionStream/DecompressionStream('deflate').
const enc = new TextEncoder();
const dec = new TextDecoder();

export async function sha1Hex(data) {
  const d = await crypto.subtle.digest('SHA-1', data);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function sha256Hex(data) {
  const d = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function zlibDeflate(data) {
  const cs = new CompressionStream('deflate');
  const buf = await new Response(new Blob([data]).stream().pipeThrough(cs)).arrayBuffer();
  return new Uint8Array(buf);
}
export async function zlibInflateExact(zdata) {
  const ds = new DecompressionStream('deflate');
  const buf = await new Response(new Blob([zdata]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(buf);
}
function concat(parts) {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function objBytes(kind, content) {
  const head = enc.encode(`${kind} ${content.length}\0`);
  return concat([head, content]);
}
// pack object entry: varint header + zlib(object bytes). typeNum: 1 commit, 2 tree, 3 blob.
// Returns {bytes, packLen}.
async function packObject(typeNum, raw) {
  const z = await zlibDeflate(raw);
  let size = raw.length;
  const hdr = [(typeNum << 4) | (size & 15)]; size >>>= 4;
  while (size > 0) { hdr[0] |= 0x80; hdr.push(size & 0x7f); size >>>= 7; }
  for (let i = 1; i < hdr.length; i++) if (i < hdr.length - 1) hdr[i] |= 0x80;
  return { bytes: concat([new Uint8Array(hdr), z]), zLen: z.length };
}
function treeBytes(entries) {
  const parts = [];
  for (const e of entries) {
    parts.push(enc.encode(`${e.mode} ${e.name}\0`));
    const raw = new Uint8Array(20);
    for (let i = 0; i < 20; i++) raw[i] = parseInt(e.shaHex.slice(i * 2, i * 2 + 2), 16);
    parts.push(raw);
  }
  return concat(parts);
}
function commitBytes({ tree, parent, name, email, ts, message }) {
  const lines = [`tree ${tree}`];
  if (parent) lines.push(`parent ${parent}`);
  lines.push(`author ${name} <${email}> ${ts} +0000`);
  lines.push(`committer ${name} <${email}> ${ts} +0000`);
  lines.push('', message, '');
  return enc.encode(lines.join('\n'));
}
const gitSort = (a, b) => {
  const aa = a.mode === '40000' ? a.name + '/' : a.name;
  const bb = b.mode === '40000' ? b.name + '/' : b.name;
  return aa < bb ? -1 : aa > bb ? 1 : 0;
};
// files: [{path, content}]. freshnessText: canonical string w/ trailing LF.
// Root commit holds ONLY .makefun/freshness.json; tip commit adds the rest.
export async function buildSourceBundle({ freshnessText, files, name, email, rootTs, tipTs, rootMessage, tipMessage, ref }) {
  const fbytes = typeof freshnessText === 'string' ? enc.encode(freshnessText) : freshnessText;
  const objects = []; // {type, raw, sha, packBytes, zLen}
  const addObj = async (type, raw) => {
    const sha = await sha1Hex(raw);
    const { bytes, zLen } = await packObject(type, raw);
    const o = { type, raw, sha, packBytes: bytes, zLen };
    objects.push(o);
    return o;
  };
  const fblob = await addObj(3, objBytes('blob', fbytes));
  // root tree: .makefun/ -> freshness.json only
  const mfRootTree = await addObj(2, objBytes('tree', treeBytes([{ mode: '100644', name: 'freshness.json', shaHex: fblob.sha }])));
  const rootTree = await addObj(2, objBytes('tree', treeBytes([{ mode: '40000', name: '.makefun', shaHex: mfRootTree.sha }])));
  const rootCommit = await addObj(1, commitBytes({ tree: rootTree.sha, parent: null, name, email, ts: rootTs, message: rootMessage }));
  // tip: blob per file, trees bottom-up
  const blobOf = { '.makefun/freshness.json': fblob.sha };
  for (const f of files) {
    if (f.path === '.makefun/freshness.json') continue;
    const content = typeof f.content === 'string' ? enc.encode(f.content) : f.content;
    const b = await addObj(3, objBytes('blob', content));
    blobOf[f.path] = b.sha;
  }
  const dirs = new Map(); // dir -> [{mode,name,shaHex}]
  const ensure = (d) => { if (!dirs.has(d)) dirs.set(d, []); return dirs.get(d); };
  ensure('');
  for (const p of Object.keys(blobOf)) {
    const parts = p.split('/'); const fname = parts.pop(); const dir = parts.join('/');
    ensure(dir).push({ mode: '100644', name: fname, shaHex: blobOf[p] });
  }
  const ordered = [...dirs.keys()].sort((a, b) => b.split('/').length - a.split('/').length || (a < b ? 1 : -1));
  for (const d of ordered) {
    if (d === '') continue;
    const t = await addObj(2, objBytes('tree', treeBytes(dirs.get(d).sort(gitSort))));
    const parts = d.split('/'); const nm = parts.pop(); const parent = parts.join('/');
    ensure(parent).push({ mode: '40000', name: nm, shaHex: t.sha });
  }
  const tipTree = await addObj(2, objBytes('tree', treeBytes(ensure('').sort(gitSort))));
  const tipCommit = await addObj(1, commitBytes({ tree: tipTree.sha, parent: rootCommit.sha, name, email, ts: tipTs, message: tipMessage }));
  // pack
  const parts = [enc.encode('PACK'), new Uint8Array([0, 0, 0, 2])];
  const n = new Uint8Array(4); new DataView(n.buffer).setUint32(0, objects.length);
  parts.push(n);
  for (const o of objects) parts.push(o.packBytes);
  const packSoFar = concat(parts);
  const trailer = new Uint8Array(await crypto.subtle.digest('SHA-1', packSoFar));
  const pack = concat([packSoFar, trailer]);
  const header = enc.encode(`# v2 git bundle\n${tipCommit.sha} ${ref || 'refs/heads/submission'}\n\n`);
  const bundle = concat([header, pack]);
  // offsets for exact verification
  let off = header.length + 12;
  const map = objects.map(o => {
    const e = { type: o.type, sha: o.sha, rawLen: o.raw.length, offset: off, zLen: o.zLen, total: o.packBytes.length };
    off += o.packBytes.length;
    return e;
  });
  return { bundle, rootSha: rootCommit.sha, tipSha: tipCommit.sha, packOffset: header.length, objects: objects.length, map, packLen: pack.length };
}
// Verify a bundle built by buildSourceBundle (exact walk via map).
export async function verifyBundle(bundle, map, { freshnessText, roundMin } = {}) {
  const errors = [];
  const sig = '# v2 git bundle\n';
  if (dec.decode(bundle.slice(0, sig.length)) !== sig) errors.push('bad signature');
  let at = sig.length;
  const refs = [];
  for (let line = 2; ; line++) {
    const end = bundle.indexOf(10, at);
    if (end < 0 || end > 65536) { errors.push('header not terminated in 64KiB'); break; }
    const text = dec.decode(bundle.slice(at, end)); at = end + 1;
    if (text === '') break;
    if (text.startsWith('-') || text.startsWith('@')) { errors.push('prereq/capability: ' + text); continue; }
    const m = text.match(/^([0-9a-f]{40}) (\S+)$/);
    if (!m) errors.push('bad ref line: ' + text); else refs.push({ sha: m[1], ref: m[2] });
  }
  if (!refs.length) errors.push('no refs');
  if (dec.decode(bundle.slice(at, at + 4)) !== 'PACK') errors.push('no PACK at ' + at);
  const dv = new DataView(bundle.buffer, bundle.byteOffset + at);
  if (dv.getUint32(4) !== 2) errors.push('pack version != 2');
  const num = dv.getUint32(8);
  if (map && map.length !== num) errors.push(`map ${map.length} != pack ${num}`);
  if (map) {
    let p = at + 12;
    for (const e of map) {
      if (e.offset !== p) errors.push(`offset drift at type ${e.type}`);
      // parse varint
      let b = bundle[p++]; const type = (b >> 4) & 7; let size = b & 15; let shift = 4;
      while (b & 0x80) { b = bundle[p++]; size |= (b & 0x7f) << shift; shift += 7; }
      if (type !== e.type) errors.push(`type ${type} != ${e.type}`);
      if (size !== e.rawLen) errors.push(`size ${size} != ${e.rawLen}`);
      const z = bundle.slice(p, p + e.zLen);
      let raw;
      try { raw = await zlibInflateExact(z); }
      catch (err) { errors.push('inflate fail type ' + type); break; }
      if (raw.length !== e.rawLen) errors.push('inflated len mismatch');
      const sha = await sha1Hex(raw);
      if (sha !== e.sha) errors.push(`sha ${sha} != ${e.sha}`);
      p += e.zLen;
    }
    const packStart = at;
    const body = bundle.slice(packStart, bundle.length - 20);
    const tail = bundle.slice(bundle.length - 20);
    const dh = new Uint8Array(await crypto.subtle.digest('SHA-1', body));
    for (let i = 0; i < 20; i++) if (dh[i] !== tail[i]) { errors.push('trailer mismatch'); break; }
  }
  if (at > 65536) errors.push('pack starts past 64KiB');
  if (freshnessText !== undefined) {
    // root commit's tree must hold only .makefun/freshness.json with exact bytes — checked by caller via map
  }
  return { ok: errors.length === 0, errors, refs, packOffset: at, numObjects: num };
}
