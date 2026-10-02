/*
 * docx-xml.mjs — the instruments that check a written .docx without trusting the writer.
 * ============================================================================
 * Shared by scripts/docx-gate.mjs and tests/core/docx-*.test.mjs. Pure (no fs, no deps):
 *
 *   xmlProblems(text)        -> string[]   well-formedness: tags balance, attributes quoted,
 *                                          entities legal, no illegal characters, every
 *                                          namespace prefix declared, one root
 *   packageProblems(files)   -> string[]   OPC integrity over { path: Uint8Array|string }:
 *                                          every part has a content type, every Override and
 *                                          every relationship target exists, rIds in
 *                                          document.xml resolve, rel ids are unique
 *
 * WHY a second checker besides xmllint (which the gate also runs): xmllint is the independent
 * witness, but it is not installed everywhere (CI, other laptops) and it exits 0 on a namespace
 * error (it only prints it), so this one is the one the core tests can always run. Neither is
 * "Word will open it": that needs LibreOffice's render as the second witness (the gate does
 * that), and a human opening it in Word as the last.
 */

const NAME = '[A-Za-z_][\\w.-]*(?::[A-Za-z_][\\w.-]*)?';
// eslint-disable-next-line no-control-regex
const BAD_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;
const ENTITY_OK = /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;

const decode = (u8) => (typeof u8 === 'string' ? u8 : new TextDecoder().decode(u8));

export function xmlProblems(input) {
  const text = decode(input);
  const bad = [];
  const note = (m) => { if (bad.length < 20) bad.push(m); };
  if (BAD_CHAR.test(text)) note('illegal control character');
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) note('lone surrogate');
  const re = new RegExp(`<!--[\\s\\S]*?-->|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>|<\\?[\\s\\S]*?\\?>|<(/?)(${NAME})((?:\\s+${NAME}\\s*=\\s*(?:"[^"<]*"|'[^'<]*'))*)\\s*(/?)>|<|[^<]+`, 'g');
  const stack = [];
  const scopes = [new Map([['xml', 'xml']])];
  let roots = 0;
  let m;
  while ((m = re.exec(text))) {
    const tok = m[0];
    if (tok === '<') { note(`stray "<" at ${m.index}`); continue; }
    if (tok[0] !== '<') {
      if (tok.replace(ENTITY_OK, '').includes('&')) note(`bad entity near "${tok.slice(0, 30).replace(/\s+/g, ' ')}"`);
      if (!stack.length && tok.trim()) note('text outside the root element');
      continue;
    }
    if (tok.startsWith('<!--') || tok.startsWith('<![CDATA[') || tok.startsWith('<?')) continue;
    const [, closing, name, attrs, selfClose] = m;
    if (closing) {
      const open = stack.pop();
      if (open !== name) { note(`</${name}> closes <${open || 'nothing'}>`); break; }
      scopes.pop();
      continue;
    }
    const scope = new Map(scopes[scopes.length - 1]);
    const seen = new Set();
    for (const a of attrs.matchAll(new RegExp(`(${NAME})\\s*=\\s*("([^"<]*)"|'([^'<]*)')`, 'g'))) {
      if (seen.has(a[1])) note(`duplicate attribute ${a[1]} on <${name}>`);
      seen.add(a[1]);
      const val = a[3] !== undefined ? a[3] : a[4];
      if (val.replace(ENTITY_OK, '').includes('&')) note(`bad entity in attribute ${a[1]} of <${name}>`);
      if (a[1] === 'xmlns') scope.set('', val);
      else if (a[1].startsWith('xmlns:')) scope.set(a[1].slice(6), val);
    }
    const prefixOf = (n) => (n.includes(':') ? n.split(':')[0] : null);
    const p = prefixOf(name);
    if (p && !scope.has(p)) note(`namespace prefix ${p} not declared on <${name}>`);
    for (const k of seen) { const ap = prefixOf(k); if (ap && ap !== 'xmlns' && !scope.has(ap)) note(`namespace prefix ${ap} not declared on attribute ${k}`); }
    if (!stack.length) roots += 1;
    if (!selfClose) { stack.push(name); scopes.push(scope); }
  }
  if (stack.length) note(`unclosed <${stack[stack.length - 1]}>`);
  if (roots !== 1) note(`${roots} root elements`);
  return bad;
}

const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
function resolveTarget(fromPart, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = dirOf(fromPart).split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

export function packageProblems(files) {
  const bad = [];
  const note = (m) => { if (bad.length < 30) bad.push(m); };
  const names = Object.keys(files);
  const has = (p) => Object.prototype.hasOwnProperty.call(files, p);
  if (!has('[Content_Types].xml')) { note('no [Content_Types].xml'); return bad; }
  const ct = decode(files['[Content_Types].xml']);
  const defaults = new Map([...ct.matchAll(/<Default\s+Extension="([^"]+)"\s+ContentType="([^"]+)"/g)].map((m) => [m[1].toLowerCase(), m[2]]));
  const overrides = new Map([...ct.matchAll(/<Override\s+PartName="([^"]+)"\s+ContentType="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  for (const p of overrides.keys()) if (!has(p.slice(1))) note(`Override for missing part ${p}`);
  for (const n of names) {
    if (n === '[Content_Types].xml') continue;
    const ext = n.includes('.') ? n.slice(n.lastIndexOf('.') + 1).toLowerCase() : '';
    if (!overrides.has(`/${n}`) && !defaults.has(ext)) note(`part ${n} has no content type`);
  }
  const relFiles = names.filter((n) => n.endsWith('.rels'));
  const relIdsByOwner = new Map();
  for (const rf of relFiles) {
    const xml = decode(files[rf]);
    const rm = rf.match(/^(?:(.*)\/)?_rels\/(.*)\.rels$/);
    const dir = (rm && rm[1]) || '';
    const ownerPath = rf === '_rels/.rels' ? '' : `${dir ? `${dir}/` : ''}${rm ? rm[2] : ''}`;
    const ids = new Set();
    const idMap = new Map();
    for (const r of xml.matchAll(/<Relationship\s+([^>]*?)\/>/g)) {
      const attr = (k) => (r[1].match(new RegExp(`${k}="([^"]*)"`)) || [])[1];
      const id = attr('Id');
      const target = attr('Target');
      if (ids.has(id)) note(`${rf}: duplicate relationship id ${id}`);
      ids.add(id);
      if (attr('TargetMode') === 'External') continue;
      const abs = resolveTarget(`${dir ? `${dir}/` : ''}x`, target);
      if (!has(abs)) note(`${rf}: ${id} targets missing part ${abs}`);
      idMap.set(id, abs);
    }
    relIdsByOwner.set(ownerPath, idMap);
  }
  const doc = has('word/document.xml') ? decode(files['word/document.xml']) : '';
  const docRels = relIdsByOwner.get('word/document.xml') || new Map();
  for (const m of doc.matchAll(/\br:(?:embed|id|link)="([^"]+)"/g)) if (!docRels.has(m[1])) note(`document.xml references unknown relationship ${m[1]}`);
  const referenced = new Set([...docRels.values()]);
  for (const n of names) if (n.startsWith('word/media/') && !referenced.has(n)) note(`orphan media ${n}`);
  return bad;
}
