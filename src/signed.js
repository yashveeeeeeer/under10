import { fromBER } from 'asn1js';
import { Certificate, ContentInfo, SignedData } from 'pkijs';

// Deliberately a subset reader, not a repairing/general PDF optimizer. Signed
// bytes are never serialized. Only a proven certificate-only suffix is rebuilt.
const WS = /[\x00\t\n\f\r ]/;
const DELIM = /[\x00\t\n\f\r ()<>\[\]{}/%]/;
const MAX_OBJECTS = 30_000;
const require = (condition, reason = 'This PDF structure is not supported for signed compression.') => { if (!condition) throw new Error(reason); };
const binary = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192)); return s; };
const encode = s => Uint8Array.from(s, c => c.charCodeAt(0));
const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const join = parts => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const dict = node => { require(node?.t === 'dict'); return node.v; };
const integer = node => { require(node?.t === 'number' && Number.isSafeInteger(node.v) && node.v >= 0); return node.v; };
const ref = node => { require(node?.t === 'ref' && node.v[1] === 0); return node.v[0]; };
const name = node => node?.t === 'name' ? node.v : undefined;
const equivalent = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function canonical(n) {
  if (!n) return null;
  if (n.t === 'dict') return ['dict', [...n.v].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])];
  return [n.t, n.t === 'array' ? n.v.map(canonical) : n.v];
}

class Reader {
  constructor(bytes) { this.bytes = bytes; this.s = binary(bytes); this.at = 0; this.tokens = 0; }
  space() {
    while (this.at < this.s.length) {
      if (WS.test(this.s[this.at])) this.at++;
      else if (this.s[this.at] === '%') { while (this.at < this.s.length && !/[\r\n]/.test(this.s[this.at])) this.at++; }
      else break;
    }
  }
  match(pattern) { const m = pattern.exec(this.s.slice(this.at)); require(m); this.at += m[0].length; return m; }
  keyword(word) { require(this.s.startsWith(word, this.at) && (this.at + word.length === this.s.length || DELIM.test(this.s[this.at + word.length]))); this.at += word.length; }
  value(depth = 0) {
    require(depth < 32 && ++this.tokens <= 1_000_000, 'PDF structure exceeds the processing limit.');
    this.space(); const start = this.at; let t, v;
    const c = this.s[this.at];
    if (this.s.startsWith('<<', this.at)) {
      this.at += 2; t = 'dict'; v = new Map(); this.space();
      while (!this.s.startsWith('>>', this.at)) {
        const key = this.value(depth + 1); require(key.t === 'name' && !v.has(key.v), 'Duplicate or invalid PDF dictionary key.');
        v.set(key.v, this.value(depth + 1)); this.space();
      }
      this.at += 2;
    } else if (c === '[') {
      this.at++; t = 'array'; v = []; this.space();
      while (this.s[this.at] !== ']') { require(v.length < 20_000); v.push(this.value(depth + 1)); this.space(); }
      this.at++;
    } else if (c === '/') {
      this.at++; t = 'name'; v = '';
      while (this.at < this.s.length && !DELIM.test(this.s[this.at])) {
        if (this.s[this.at] === '#') { const m = this.match(/^#([a-f\d]{2})/i); v += String.fromCharCode(parseInt(m[1], 16)); }
        else v += this.s[this.at++];
      }
    } else if (c === '<') {
      this.at++; t = 'string'; let hex = '';
      while (this.at < this.s.length && this.s[this.at] !== '>') { const c = this.s[this.at++]; if (!WS.test(c)) { require(/[a-f\d]/i.test(c)); hex += c; } }
      require(this.s[this.at++] === '>'); if (hex.length % 2) hex += '0';
      v = hex.toLowerCase();
    } else if (c === '(') {
      this.at++; t = 'string'; let text = '', level = 1;
      while (level) {
        require(this.at < this.s.length); let ch = this.s[this.at++];
        if (ch === '\\') {
          require(this.at < this.s.length); ch = this.s[this.at++];
          if (/[0-7]/.test(ch)) { let octal = ch; while (octal.length < 3 && /[0-7]/.test(this.s[this.at] || 'x')) octal += this.s[this.at++]; text += String.fromCharCode(parseInt(octal, 8) & 255); }
          else if (ch === '\r') { if (this.s[this.at] === '\n') this.at++; }
          else if (ch !== '\n') text += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[ch] ?? ch;
        } else if (ch === '(') { require(++level < 32); text += ch; }
        else if (ch === ')') { if (--level) text += ch; }
        else if (ch === '\r') { if (this.s[this.at] === '\n') this.at++; text += '\n'; }
        else text += ch;
      }
      v = [...text].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    } else if (/[+\-\d.]/.test(c || 'x')) {
      const m = this.match(/^[+\-]?(?:\d+\.?\d*|\.\d+)/); t = 'number'; v = Number(m[0]); require(Number.isFinite(v));
      require(this.at === this.s.length || DELIM.test(this.s[this.at]));
      const reference = /^(?:[\t\r\n ]+)(\d+)[\t\r\n ]+R(?=[\s/<>()\[\]%]|$)/.exec(this.s.slice(this.at));
      if (reference) { require(Number.isSafeInteger(v) && v > 0 && v < 100_000); t = 'ref'; v = [v, Number(reference[1])]; this.at += reference[0].length; }
    } else {
      const m = this.match(/^(true|false|null)(?=[\s/<>()\[\]%]|$)/); t = 'literal'; v = m[1];
    }
    return { t, v, start, end: this.at, raw: this.s.slice(start, this.at) };
  }
  xref(offset) {
    this.at = offset; this.keyword('xref'); this.space(); const entries = new Map();
    while (!this.s.startsWith('trailer', this.at)) {
      const m = this.match(/^(\d+)[ \t]+(\d+)[ \t]*(?:\r\n|\r|\n)/);
      const first = Number(m[1]), count = Number(m[2]); require(count > 0 && first + count <= 100_000 && entries.size + count <= MAX_OBJECTS);
      for (let i = 0; i < count; i++) {
        const row = this.match(/^(\d{10}) (\d{5}) ([nf])(?: \r\n| \n|\r\n| \r)/); const id = first + i;
        require(!entries.has(id));
        if (row[3] === 'f') require(id === 0 && Number(row[1]) === 0 && row[2] === '65535', 'Freed objects are not supported.');
        else require(id > 0 && row[2] === '00000' && Number(row[1]) < offset);
        entries.set(id, row[3] === 'n' ? Number(row[1]) : null);
      }
      this.space();
    }
    this.keyword('trailer'); const trailer = this.value(); const td = dict(trailer);
    require([...td.keys()].every(k => ['Size', 'Prev', 'Root', 'Info', 'ID'].includes(k)), 'Encryption, hybrid xrefs or unknown trailer entries are not supported.');
    const size = integer(td.get('Size')); require(size > 0 && size <= 100_000 && [...entries.keys()].every(k => k < size));
    ref(td.get('Root')); if (td.has('Info')) ref(td.get('Info'));
    this.space(); this.keyword('startxref'); this.space(); const actual = this.match(/^\d+/); require(Number(actual[0]) === offset);
    this.match(/^[\t\r\n ]*%%EOF(?:\r\n|\n|\r|$)/);
    const end = this.at;
    return { offset, entries, trailer, end, prev: td.has('Prev') ? integer(td.get('Prev')) : null, size, objects: new Map() };
  }
  object(id, offset) {
    this.at = offset; const m = this.match(/^(\d+) (\d+) obj(?=[\s/<>()\[\]%]|$)/); require(Number(m[1]) === id && m[2] === '0');
    const node = this.value(); this.space(); let stream;
    if (this.s.startsWith('stream', this.at)) {
      const length = integer(dict(node).get('Length'));
      this.match(/^stream[ \t]*(?:\r\n|\n|\r)/); require(this.at + length <= this.bytes.length);
      stream = this.bytes.subarray(this.at, this.at + length); this.at += length;
      // Exactly the specified stream bytes, then an optional line ending.
      if (this.s[this.at] === '\r') this.at++;
      if (this.s[this.at] === '\n') this.at++;
      this.keyword('endstream'); this.space();
    }
    this.keyword('endobj');
    require(!['ObjStm', 'XRef'].includes(name(node.t === 'dict' && node.v.get('Type'))), 'Object and xref streams are not supported for signed compression.');
    return { id, node, stream, end: this.at };
  }
  document() {
    require(this.s.startsWith('%PDF-'));
    const tail = /startxref[\t\r\n ]+(\d+)[\t\r\n ]+%%EOF[\x00\t\n\f\r ]*$/.exec(this.s.slice(-1024)); require(tail);
    const revisions = []; let offset = Number(tail[1]);
    while (true) {
      require(revisions.length < 16 && (!revisions.length || offset < revisions.at(-1).offset));
      const rev = this.xref(offset); revisions.push(rev); if (rev.prev === null) break; offset = rev.prev;
    }
    revisions.reverse(); const objects = new Map(); let end = 0, total = 0;
    for (const rev of revisions) {
      require(!end || rev.size >= revisions[revisions.indexOf(rev) - 1].size);
      this.at = end; this.space();
      for (const [id, at] of [...rev.entries].filter(([, at]) => at !== null).sort((a, b) => a[1] - b[1])) {
        require(++total <= MAX_OBJECTS && this.at === at, 'Unindexed or overlapping PDF content.');
        const obj = this.object(id, at); require(obj.end <= rev.offset); rev.objects.set(id, obj); objects.set(id, obj); this.space();
      }
      require(this.at === rev.offset, 'Unindexed PDF content.'); end = rev.end;
    }
    require(/^[\x00\t\n\f\r ]*$/.test(this.s.slice(end)), 'Unexpected content after the last revision.');
    return { revisions, objects };
  }
}

const decodeHex = s => Uint8Array.from(s.match(/../g) || [], h => parseInt(h, 16));
function signatureIn(document) {
  const signatures = []; const prohibited = new Set(['DocMDP', 'FieldMDP', 'Perms', 'XFA', 'JavaScript', 'JS', 'OpenAction', 'AA', 'EmbeddedFiles', 'Collection']);
  const visit = n => {
    if (n.t === 'dict') {
      require(![...n.v.keys()].some(k => prohibited.has(k)), 'Certification permissions, scripts or embedded files are not supported for signed compression.');
      require(name(n.v.get('Type')) !== 'DocTimeStamp', 'Timestamped documents are not supported for signed compression.');
      if (n.v.has('ByteRange') || name(n.v.get('Type')) === 'Sig') signatures.push(n);
      for (const v of n.v.values()) visit(v);
    } else if (n.t === 'array') n.v.forEach(visit);
  };
  for (const rev of document.revisions) for (const obj of rev.objects.values()) visit(obj.node);
  require(signatures.length === 1, 'Signed compression currently requires exactly one supported signature.');
  const sig = signatures[0], fields = dict(sig);
  require(name(fields.get('Type')) === 'Sig' && !fields.has('Reference') && ['adbe.pkcs7.detached', 'ETSI.CAdES.detached'].includes(name(fields.get('SubFilter'))), 'This signature format is not supported for compression.');
  const br = fields.get('ByteRange'); require(br?.t === 'array' && br.v.length === 4);
  const ranges = br.v.map(integer), [zero, a, b, length] = ranges;
  const contents = fields.get('Contents');
  require(zero === 0 && a > 0 && b > a && length > 0 && contents?.t === 'string' && contents.raw.startsWith('<') && contents.start === a && contents.end === b, 'The signature byte range is ambiguous or invalid.');
  require(contents.v.length <= 131_072, 'Signature data exceeds the processing limit.');
  const signatureObject = [...document.objects.values()].find(o => o.node === sig && !o.stream);
  require(signatureObject, 'The signature must be a standalone object.');
  const root = dict(document.objects.get(ref(dict(document.revisions.at(-1).trailer).get('Root')))?.node);
  const form = dict(document.objects.get(ref(root.get('AcroForm')))?.node);
  require([...form.keys()].every(k => ['Fields', 'SigFlags'].includes(k)));
  const formFields = form.get('Fields'); require(formFields?.t === 'array' && formFields.v.length === 1, 'Only a single signature field is supported.');
  const field = dict(document.objects.get(ref(formFields.v[0]))?.node);
  require(name(field.get('FT')) === 'Sig' && !field.has('Kids') && ref(field.get('V')) === signatureObject.id, 'The active signature field does not match the signature.');
  return { node: sig, ranges, end: b + length, cms: decodeHex(contents.v) };
}

async function verifySignature(bytes, signature) {
  const cms = fromBER(signature.cms);
  require(cms.offset > 0 && signature.cms.subarray(cms.offset).every(b => b === 0), 'The signature data could not be read.');
  const info = new ContentInfo({ schema: cms.result }); require(info.contentType === ContentInfo.SIGNED_DATA);
  const signed = new SignedData({ schema: info.content });
  require(signed.signerInfos.length === 1 && signed.certificates?.length <= 16 && !signed.encapContentInfo.eContent && signed.encapContentInfo.eContentType === SignedData.ID_DATA, 'Unsupported detached signature.');
  require(['2.16.840.1.101.3.4.2.1', '2.16.840.1.101.3.4.2.2', '2.16.840.1.101.3.4.2.3'].includes(signed.signerInfos[0].digestAlgorithm.algorithmId), 'Only SHA-256, SHA-384 and SHA-512 signatures are supported.');
  const attrs = signed.signerInfos[0].signedAttrs?.attributes;
  require(attrs?.length && new Set(attrs.map(a => a.type)).size === attrs.length, 'Ambiguous signature attributes.');
  for (const oid of ['1.2.840.113549.1.9.3', '1.2.840.113549.1.9.4']) require(attrs.find(a => a.type === oid)?.values.length === 1, 'Ambiguous signature attributes.');
  const [, a, b, length] = signature.ranges; require(b + length <= bytes.length);
  const content = join([bytes.subarray(0, a), bytes.subarray(b, b + length)]);
  // checkChain:false verifies content digest and public-key signature, never
  // certificate trust/expiry/revocation. No online trust lookup takes place.
  try { require(await signed.verify({ signer: 0, data: content.buffer, checkChain: false })); }
  catch { throw new Error('Signature integrity check failed.'); }
}

async function flate(bytes, decompress) {
  const stream = new Blob([bytes]).stream().pipeThrough(decompress ? new DecompressionStream('deflate') : new CompressionStream('deflate'));
  const reader = stream.getReader(); const chunks = []; let total = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; total += value.length; require(total <= 65_536, 'Certificate data exceeds the processing limit.'); chunks.push(value); }
  } finally { await reader.cancel().catch(() => {}); }
  return join(chunks);
}
function certificate(bytes) {
  try { const parsed = fromBER(bytes); require(parsed.offset === bytes.length); new Certificate({ schema: parsed.result }); }
  catch { throw new Error('Invalid certificate data.'); }
}
function serializeDict(entries) { return `<<\n${[...entries].map(([k, v]) => `/${k.replace(/[^a-z\d]/gi, c => '#' + c.charCodeAt(0).toString(16).padStart(2, '0'))} ${v.raw}`).join('\n')}\n>>`; }
const rawNode = raw => ({ raw });

// Throws on any unsupported feature. Callers may offer the exact unchanged
// original if it fits, but must never substitute an ordinary rewrite.
export async function compactSignedPDF(bytes, limit, progress = () => {}) {
  require(bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= 40_000_000);
  require(Number.isSafeInteger(limit) && limit > 0);
  progress('Checking signed revisions…');
  const reader = new Reader(bytes), document = reader.document(), signature = signatureIn(document);
  const revisions = document.revisions, latest = revisions.at(-1), signedRev = revisions.at(-2);
  require(signature.end < bytes.length, 'There is no unsigned certificate data to compress.');
  require(signature.end < limit, 'The signed portion alone reaches the size limit.');
  require(signedRev && signature.end === signedRev.end, 'Only one certificate update after signing is supported.');
  const prefixObjects = new Map(); for (const rev of revisions.slice(0, -1)) for (const [id, o] of rev.objects) prefixObjects.set(id, o);
  const td = dict(latest.trailer), oldTd = dict(signedRev.trailer);
  if (td.has('ID')) { const id = td.get('ID'); require(id.t === 'array' && id.v.length === 2 && id.v.every(n => n.t === 'string')); }
  const rootId = ref(td.get('Root')); require(rootId === ref(oldTd.get('Root')));
  require([...prefixObjects.keys()].every(id => id < signedRev.size));
  require(!document.objects.get(rootId)?.stream && !prefixObjects.get(rootId)?.stream);
  const root = dict(document.objects.get(rootId)?.node), oldRoot = dict(prefixObjects.get(rootId)?.node);
  require(name(root.get('Type')) === 'Catalog');
  require(!oldRoot.has('DSS') && root.size === oldRoot.size + 1 && root.has('DSS'), 'Only a newly added certificate store is supported.');
  for (const [k, v] of oldRoot) require(equivalent(v, root.get(k)), 'The unsigned revision changes document content.');
  const dssId = ref(root.get('DSS')); require(dssId >= signedRev.size);
  require(!latest.objects.get(dssId)?.stream);
  const dss = dict(latest.objects.get(dssId)?.node); require(dss.size === 1 && dss.has('Certs'), 'Only certificate data can be compressed. OCSP, CRL and VRI updates are not supported.');
  const entries = dss.get('Certs'); require(entries.t === 'array' && entries.v.length > 0 && entries.v.length <= 20_000);
  const allowed = new Set([rootId, dssId]);
  let info;
  require(td.has('Info') === oldTd.has('Info'));
  if (td.has('Info')) {
    const infoId = ref(td.get('Info')); require(infoId === ref(oldTd.get('Info'))); allowed.add(infoId);
    info = document.objects.get(infoId);
    require(!info?.stream && [...dict(prefixObjects.get(infoId)?.node).values()].every(v => ['number', 'string', 'literal', 'name'].includes(v.t)));
    require([...dict(info?.node).values()].every(v => ['number', 'string', 'literal', 'name'].includes(v.t)), 'Only plain metadata is supported.');
  }
  for (const entry of entries.v) { const id = ref(entry); require(id >= signedRev.size && id !== dssId); allowed.add(id); }
  require([...latest.objects.keys()].every(id => allowed.has(id)), 'The unsigned revision changes other document objects.');
  require(latest.objects.has(rootId));
  // All references in the signed revisions must already resolve within them.
  // This rules out a suffix resolving a dangling signed page/resource reference.
  const checkRefs = n => {
    if (n.t === 'ref') {
      require(prefixObjects.has(ref(n)), 'Unresolved reference in the signed document.');
      require(!info || ref(n) !== info.id, 'Shared metadata objects are not supported.');
    }
    else if (n.t === 'array') n.v.forEach(checkRefs);
    else if (n.t === 'dict') for (const v of n.v.values()) checkRefs(v);
  };
  for (const o of prefixObjects.values()) checkRefs(o.node);
  progress('Checking signature integrity…'); await verifySignature(bytes, signature);
  progress('Compressing extra certificate data…');
  const byObject = new Map(), byBytes = new Map(), unique = [], indexes = []; let decodedTotal = 0;
  for (const entry of entries.v) {
    const id = ref(entry);
    if (!byObject.has(id)) {
      const obj = latest.objects.get(id), fields = dict(obj?.node);
      require(obj.stream && [...fields.keys()].every(k => ['Length', 'Filter'].includes(k)) && (!fields.has('Filter') || name(fields.get('Filter')) === 'FlateDecode'));
      require(obj.stream.length > 0 && obj.stream.length <= 65_536);
      const der = fields.has('Filter') ? await flate(obj.stream, true) : obj.stream;
      decodedTotal += der.length; require(decodedTotal <= 40_000_000 && der.length > 0, 'Certificate data exceeds the processing limit.');
      const key = binary(der);
      if (!byBytes.has(key)) { require(unique.length < 256, 'Too many distinct certificates.'); certificate(der); byBytes.set(key, unique.length); unique.push(der); }
      byObject.set(id, byBytes.get(key));
    }
    indexes.push(byObject.get(id));
  }
  const first = signedRev.size, newDssId = first + unique.length;
  const outputObjects = new Map();
  for (let i = 0; i < unique.length; i++) {
    const compressed = await flate(unique[i], false), useFlate = compressed.length < unique[i].length;
    const stream = useFlate ? compressed : unique[i];
    outputObjects.set(first + i, join([encode(`<< /Length ${stream.length}${useFlate ? ' /Filter /FlateDecode' : ''} >>\nstream\n`), stream, encode('\nendstream')]));
  }
  outputObjects.set(newDssId, encode(`<< /Certs [${indexes.map(i => `${first + i} 0 R`).join(' ')}] >>`));
  const newRoot = new Map(root); newRoot.set('DSS', rawNode(`${newDssId} 0 R`)); outputObjects.set(rootId, encode(serializeDict(newRoot)));
  if (info && latest.objects.has(info.id)) outputObjects.set(info.id, encode(info.node.raw));
  const parts = [bytes.subarray(0, signature.end), encode('\n')]; let at = signature.end + 1;
  const offsets = [];
  for (const [id, body] of [...outputObjects].sort((a, b) => a[0] - b[0])) {
    offsets.push([id, at]); const part = join([encode(`${id} 0 obj\n`), body, encode('\nendobj\n')]); parts.push(part); at += part.length;
  }
  const trailer = new Map(td); trailer.set('Prev', rawNode(String(signedRev.offset))); trailer.set('Size', rawNode(String(newDssId + 1)));
  const xref = `xref\n0 1\n0000000000 65535 f \n${offsets.map(([id, pos]) => `${id} 1\n${String(pos).padStart(10, '0')} 00000 n \n`).join('')}trailer\n${serializeDict(trailer)}\nstartxref\n${at}\n%%EOF\n`;
  parts.push(encode(xref)); const candidate = join(parts);
  require(candidate.length < bytes.length, 'There is no smaller result within the supported signature rules.');
  require(candidate.length < limit, 'The compressed result still reaches the chosen size limit.');
  require(equal(candidate.subarray(0, signature.end), bytes.subarray(0, signature.end)), 'Signed bytes changed. Download blocked.');
  progress('Checking the compressed PDF…');
  const output = new Reader(candidate).document(), outSig = signatureIn(output);
  require(equivalent(outSig.node, signature.node) && outSig.end === signature.end && equal(outSig.cms, signature.cms));
  const outRoot = dict(output.objects.get(rootId)?.node);
  for (const [k, v] of root) if (k !== 'DSS') require(equivalent(v, outRoot.get(k)));
  if (info) require(equivalent(info.node, output.objects.get(info.id)?.node));
  require(equivalent(td.get('ID'), dict(output.revisions.at(-1).trailer).get('ID')));
  const outCerts = dict(output.objects.get(ref(outRoot.get('DSS')))?.node).get('Certs'); require(outCerts.t === 'array' && outCerts.v.length === indexes.length);
  const decoded = new Map();
  for (let i = 0; i < indexes.length; i++) {
    const id = ref(outCerts.v[i]);
    if (!decoded.has(id)) { const o = output.objects.get(id); decoded.set(id, dict(o.node).has('Filter') ? await flate(o.stream, true) : o.stream); }
    require(equal(unique[indexes[i]], decoded.get(id)), 'Certificate contents changed. Download blocked.');
  }
  await verifySignature(candidate, outSig);
  return { bytes: candidate, signedBytes: signature.end, certificates: indexes.length, saved: bytes.length - candidate.length };
}
