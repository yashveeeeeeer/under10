import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gunzipSync, deflateSync } from 'node:zlib';
import { PDFDocument, PDFName, decodePDFRawStream } from 'pdf-lib';
import { compactSignedPDF } from '../src/signed.js';

const fixture = new Uint8Array(gunzipSync(await readFile('tests/data/signed-certificates.pdf.gz')));
const original = new Uint8Array(await readFile('tests/data/signed-synthetic.pdf'));
const LIMIT = 10_000_000;
const text = bytes => Buffer.from(bytes).toString('latin1');
const bytes = s => new Uint8Array(Buffer.from(s, 'latin1'));
// Rebuild only an unsigned xref so mutations are structurally readable, not
// rejected just because a test accidentally left byte offsets out of date.
function mutateSuffix(fn) {
  const src = text(fixture), at = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(src)[1]);
  const prefix = src.slice(0, original.length), tail = src.slice(original.length, at);
  const updated = fn(tail), result = prefix + updated;
  const entries = [...updated.matchAll(/(?:^|\n)(\d+) 0 obj\n/g)].map(m => [Number(m[1]), original.length + m.index + (m[0].startsWith('\n') ? 1 : 0)]);
  const trailer = src.slice(at).match(/trailer\s*(<<[\s\S]+?>>)\s*startxref/)[1];
  return bytes(result + 'xref\n0 1\n0000000000 65535 f \n' + entries.map(([id, off]) => `${id} 1\n${String(off).padStart(10, '0')} 00000 n \n`).join('') + `trailer\n${trailer}\nstartxref\n${result.length}\n%%EOF\n`);
}
async function certs(data) {
  const pdf = await PDFDocument.load(data, { updateMetadata: false, throwOnInvalidObject: true });
  return pdf.catalog.lookup(PDFName.of('DSS')).lookup(PDFName.of('Certs')).asArray().map(r => Buffer.from(decodePDFRawStream(pdf.context.lookup(r)).decode()).toString('hex'));
}

test('certificate suffix compaction preserves the signed prefix and every decoded certificate', async () => {
  const result = await compactSignedPDF(fixture, LIMIT);
  assert.ok(result.bytes.length < LIMIT && result.bytes.length < fixture.length);
  assert.equal(result.signedBytes, original.length);
  assert.deepEqual(result.bytes.subarray(0, original.length), original);
  assert.equal(result.certificates, 14_000);
  assert.deepEqual(await certs(result.bytes), await certs(fixture));
  const before = await PDFDocument.load(fixture), after = await PDFDocument.load(result.bytes);
  assert.equal(before.getPageCount(), after.getPageCount());
  assert.equal(before.getModificationDate().getTime(), after.getModificationDate().getTime());
  assert.equal(before.getProducer(), after.getProducer());
  await mkdir('tmp/qa', { recursive: true }); await writeFile('tmp/qa/signed-compressed-node.pdf', result.bytes);
});

test('signed compression enforces the exact output boundary', async () => {
  const result = await compactSignedPDF(fixture, LIMIT);
  await assert.rejects(compactSignedPDF(fixture, result.bytes.length), /still reaches/);
  assert.equal((await compactSignedPDF(fixture, result.bytes.length + 1)).bytes.length, result.bytes.length);
});

test('a fully signed file and an oversized signed prefix cannot be compressed', async () => {
  await assert.rejects(compactSignedPDF(original, LIMIT), /no unsigned certificate/);
  await assert.rejects(compactSignedPDF(fixture, original.length), /signed portion/);
  const large = new Uint8Array(gunzipSync(await readFile('tests/data/signed-over-limit-synthetic.pdf.gz')));
  await assert.rejects(compactSignedPDF(large, LIMIT), /no unsigned certificate/);
});

test('tampering with a signed byte is rejected by cryptographic verification', async () => {
  const altered = bytes(text(fixture).replace('/Author (anonymous)', '/Author (Anonymous)'));
  await assert.rejects(compactSignedPDF(altered, LIMIT), /Signature integrity check failed/);
});

for (const [label, change, message] of [
  ['other catalog changes', s => s.replace('/Type /Catalog', '/Type /Catalog /Lang (en)'), /catalog|document|certificate store/i],
  ['extra DSS keys', s => s.replace('/Certs [', '/VRI << >> /Certs ['), /OCSP, CRL and VRI/],
  ['duplicate keys', s => s.replace('/Certs [', '/Certs [] /Certs ['), /Duplicate/],
  ['signed page update', s => s + '\n3 0 obj\n<< /Type /Page >>\nendobj\n', /other document objects/],
  ['unknown new object', s => s + '\n8 0 obj\n<< /Anything (else) >>\nendobj\n', /other document objects/],
  ['new DSS alias to signed object', s => s.replace(/\/DSS \d+ 0 R/, '/DSS 7 0 R'), /not supported/],
  ['invalid certificate', s => s.replace('stream\n0', 'stream\n1'), /certificate|schema|ASN|Object/i],
  ['extra bytes outside objects', s => s + 'garbage\n', /Unindexed/],
]) test(`rejects ${label}`, async () => { await assert.rejects(compactSignedPDF(mutateSuffix(change), LIMIT), message); });

test('malformed xref and a trailing untracked revision are rejected', async () => {
  const src = text(fixture);
  await assert.rejects(compactSignedPDF(bytes(src.replace(/startxref\s+\d+\s+%%EOF\s*$/, 'startxref\n0\n%%EOF\n')), LIMIT));
  await assert.rejects(compactSignedPDF(bytes(src + '12 0 obj\nnull\nendobj\n'), LIMIT));
});

test('certificate decompression stops above the decoded size cap', async () => {
  const compressed = deflateSync(Buffer.alloc(65_537));
  const bomb = mutateSuffix(s => s.replace(/12 0 obj\n[\s\S]*?endobj/, `12 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n${compressed.toString('latin1')}\nendstream\nendobj`));
  await assert.rejects(compactSignedPDF(bomb, LIMIT), /Certificate data exceeds/);
});

test('document timestamps, certification permissions and multiple signatures are outside the supported profile', async () => {
  for (const [from, to, pattern] of [
    ['/Type /Sig\n', '/Type /DocTimeStamp\n', /not supported|Unindexed/],
    ['/Type /Sig\n', '/Type /Sig /DocMDP 1\n', /not supported|Unindexed/],
  ]) await assert.rejects(compactSignedPDF(bytes(text(fixture).replace(from, to)), LIMIT), pattern);
  const multi = mutateSuffix(s => s + '\n8 0 obj\n<< /Type /Sig >>\nendobj\n');
  await assert.rejects(compactSignedPDF(multi, LIMIT), /exactly one/);
});

test('compressed certificate streams can be read on a subsequent attempt', async () => {
  const result = await compactSignedPDF(fixture, LIMIT);
  // The second output is already compact. It must not grow or lose the signature.
  await assert.rejects(compactSignedPDF(result.bytes, LIMIT), /no smaller result/);
});

test('input and size limits fail closed', async () => {
  await assert.rejects(compactSignedPDF(new Uint8Array(40_000_001), LIMIT));
  for (const limit of [0, -1, NaN, 1.5]) await assert.rejects(compactSignedPDF(fixture, limit));
});

for (const [file, reason] of [
  ['signed-extra-revision', /Only one certificate update/],
  ['signed-multiple', /exactly one/],
  ['signed-timestamp', /Timestamped documents/],
]) test(`refuses the independently generated ${file} fixture`, async () => {
  const data = new Uint8Array(gunzipSync(await readFile(`tests/data/${file}.pdf.gz`)));
  await assert.rejects(compactSignedPDF(data, LIMIT), reason);
});
