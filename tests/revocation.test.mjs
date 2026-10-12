import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { compactSignedPDF } from '../src/signed.js';
import { manifest, fixture, snapshot, changeSuffix, streamBody } from './revocation-helpers.mjs';

const LIMIT = 10_000_000;
const large = await fixture(manifest[0].name), prefix = manifest[0].signed_bytes;
const alter = edit => changeSuffix(large, prefix, edit);
const find = (objects, regex) => [...objects].find(([, body]) => regex.test(body));
const dss = objects => find(objects, /\/Certs\s*\[/);
const evidence = (objects, kind, index = 0) => Number(dss(objects)[1].match(new RegExp('/' + kind + '\\s*\\[([^\\]]+)'))[1].match(/\d+ 0 R/g)[index].split(' ')[0]);
const vri = objects => find(objects, /\/Cert\s*\[/);

for (const c of manifest) test(`${c.name}: preserves signed bytes, validation graph, metadata and pages`, async () => {
  const input = await fixture(c.name), before = input.slice();
  const result = await compactSignedPDF(input, LIMIT);
  assert.ok(result.bytes.length < input.length && result.bytes.length < LIMIT);
  assert.deepEqual(input, before);
  assert.deepEqual(result.bytes.subarray(0, c.signed_bytes), input.subarray(0, c.signed_bytes));
  assert.deepEqual(await snapshot(result.bytes), await snapshot(input));
  assert.deepEqual(result.evidence, { Certs: c.certificates, CRLs: c.crls, OCSPs: c.ocsps });
  if (c === manifest[0]) assert.ok(input.length > LIMIT);
  await mkdir('tmp/qa/revocation', { recursive: true });
  await writeFile(`tmp/qa/revocation/${c.name}-node.pdf`, result.bytes);
});

test('exact size boundaries and protected-prefix diagnosis are verified, including a fully signed oversized file', async () => {
  const input = await fixture(manifest[1].name), result = await compactSignedPDF(input, LIMIT);
  await assert.rejects(compactSignedPDF(input, result.bytes.length), e => e.code === 'TARGET_NOT_MET' && e.diagnosis.integrityChecked);
  assert.equal((await compactSignedPDF(input, result.bytes.length + 1)).bytes.length, result.bytes.length);
  await assert.rejects(compactSignedPDF(large, prefix), e => e.code === 'SIGNED_PREFIX_LIMIT' && e.diagnosis.signedBytes === prefix);
  const fully = await fixture('signed-over-limit-synthetic');
  await assert.rejects(compactSignedPDF(fully, LIMIT), e => e.code === 'SIGNED_PREFIX_LIMIT' && e.diagnosis.unsignedBytes === 0);
  await assert.rejects(compactSignedPDF(fully, 20_000_000), e => e.code === 'NO_UNSIGNED_UPDATE');
  const tampered = fully.slice(); tampered[100] ^= 1;
  await assert.rejects(compactSignedPDF(tampered, LIMIT), e => !e.diagnosis);
});

for (const [label, edit, pattern] of [
  ['unknown DSS key', objects => { const [id, body] = dss(objects); objects.set(id, body.replace('<<', '<< /Unknown true')); }, /Unknown DSS/],
  ['unknown VRI key', objects => { const [id, body] = vri(objects); objects.set(id, body.replace('<<', '<< /Unknown true')); }, /Unknown VRI/],
  ['wrong VRI signature hash', objects => { for (const [id, body] of objects) objects.set(id, body.replace(/\/[A-F0-9]{40}\b/, '/' + '0'.repeat(40))); }, /VRI does not match/],
  ['VRI evidence outside global array', objects => { const [id, body] = dss(objects); objects.set(id, body.replace(/\/CRLs\s*\[[^\]]+\]/, '')); }, /absent from the DSS/],
  ['cyclic validation reference', objects => { const [id, body] = dss(objects); const changed = body.replace(/\/VRI\s*<<[^>]*>>/, '/VRI ' + id + ' 0 R'); assert.notEqual(changed, body); objects.set(id, changed); }, /conflicting types/],
  ['signed evidence alias', objects => { const [id, body] = dss(objects); objects.set(id, body.replace(/\/Certs\s*\[\s*\d+ 0 R/, '/Certs [1 0 R')); }, /signed object/],
  ['conflicting evidence types', objects => { const crl = evidence(objects, 'CRLs'); const [id, body] = dss(objects); objects.set(id, body.replace(/\/Certs\s*\[\s*\d+ 0 R/, '/Certs [' + crl + ' 0 R')); }, /certificate|conflicting/],
  ['invalid CRL DER', objects => objects.set(evidence(objects, 'CRLs'), streamBody(Buffer.from([0x30, 0]))), /Invalid CRL/],
  ['invalid OCSP DER', objects => objects.set(evidence(objects, 'OCSPs'), streamBody(Buffer.from([0x30, 0]))), /Invalid OCSP/],
  ['CRL decompression bomb', objects => objects.set(evidence(objects, 'CRLs'), streamBody(deflateSync(Buffer.alloc(4_000_001)), true)), /CRLs data exceeds/],
  ['OCSP decompression bomb', objects => objects.set(evidence(objects, 'OCSPs'), streamBody(deflateSync(Buffer.alloc(1_000_001)), true)), /OCSPs data exceeds/],
  ['deep ASN.1', objects => { let b = Buffer.from([0x30, 0]); for (let i = 0; i < 25; i++) b = Buffer.concat([Buffer.from([0x30, b.length]), b]); objects.set(evidence(objects, 'CRLs'), streamBody(b)); }, /ASN.1 exceeds/],
  ['indefinite BER length', objects => objects.set(evidence(objects, 'CRLs'), streamBody(Buffer.from([0x30, 0x80, 0, 0]))), /Invalid DER length/],
  ['unknown stream filter', objects => { const id = evidence(objects, 'CRLs'); objects.set(id, objects.get(id).replace('<<', '<< /Filter /LZWDecode')); }, /Unsupported validation filter/],
  ['duplicate DSS key', objects => { const [id, body] = dss(objects); objects.set(id, body.replace('<<', '<< /Certs []')); }, /Duplicate/],
  ['unrelated new object', objects => objects.set(Math.max(...objects.keys()) + 1, '<< /Other true >>'), /other document objects/],
  ['modified signed page', objects => objects.set(3, '<< /Type /Page /Rotate 90 >>'), /other document objects/],
]) test(`refuses ${label} with a valid rebuilt xref`, async () => {
  await assert.rejects(compactSignedPDF(alter(edit), LIMIT), pattern);
});

test('multiple signatures remain outside the public profile even when a lab candidate exists', async () => {
  await assert.rejects(compactSignedPDF(await fixture('revocation-multiple'), LIMIT), /exactly one/);
});

test('repeated compression never grows a file or removes evidence', async () => {
  const out = await compactSignedPDF(await fixture(manifest[1].name), LIMIT);
  await assert.rejects(compactSignedPDF(out.bytes, LIMIT), /no smaller result/);
});
