import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { sniff, inspectPDF, transformIssue, fits, byteLimit, targetBytes, signingReserve, signatureCount, SIGNING, assemble, imageDimensions } from '../src/core.js';
import { pdfFixture, file } from './fixtures.mjs';

test('decimal limit is strict at byte boundary', () => {
  assert.equal(byteLimit('10'), 10_000_000);
  assert.equal(fits(9_999_999, byteLimit(10)), true);
  assert.equal(fits(10_000_000, byteLimit(10)), false);
  assert.equal(fits(10_000_001, byteLimit(10)), false);
  assert.equal(fits(0, 10_000_000), false);
  assert.equal(targetBytes(10_000_000, true), 9_000_000);
  assert.equal(targetBytes(10_000_000, false), 9_800_000);
  assert.equal(byteLimit('25'), 25_000_000);
  assert.equal(byteLimit('100'), 100_000_000);
  assert.equal(fits(25_000_000, byteLimit(25)), false);
  assert.equal(fits(24_999_999, byteLimit(25)), true);
  assert.equal(targetBytes(byteLimit(25), true), 24_000_000);
  assert.equal(targetBytes(byteLimit(25), false), 24_500_000);
});
test('signing reserve scales with the number of signatures', () => {
  assert.equal(signingReserve(1), 100_000);
  assert.equal(signingReserve(10), 1_000_000);
  // One or two signatures are held at the same ceiling as an unsigned target.
  assert.equal(targetBytes(10_000_000, true, 1), 9_800_000);
  assert.equal(targetBytes(10_000_000, true, 2), 9_800_000);
  assert.equal(targetBytes(10_000_000, true, 3), 9_700_000);
  assert.equal(targetBytes(10_000_000, true, 10), 9_000_000);
  // The default matches the widest reserve, so an omitted count is never the loosest choice.
  assert.equal(targetBytes(10_000_000, true), targetBytes(10_000_000, true, SIGNING.maxSignatures));
  for (const limit of [byteLimit(0.5), byteLimit(6), byteLimit(10), byteLimit(100)]) {
    let previous = Infinity;
    for (let n = 1; n <= SIGNING.maxSignatures; n++) {
      const target = targetBytes(limit, true, n);
      assert.ok(target <= previous, `target rose from ${previous} to ${target} at ${n} signatures`);
      assert.ok(target <= targetBytes(limit, false), 'signing target exceeded the unsigned ceiling');
      // Where the 98% ceiling binds first the app holds back more than asked, never less.
      assert.ok(limit - target >= signingReserve(n), 'reserve was narrower than requested');
      previous = target;
    }
  }
  // A reserve wider than the limit yields no usable target; the app blocks the run.
  assert.ok(targetBytes(byteLimit(0.1), true, 10) <= 0);
});
test('reject invalid signature counts', () => {
  for (const value of [0, -1, 11, 1.5, '', 'x', null, NaN, Infinity]) assert.throws(() => signatureCount(value));
  for (const value of [1, 10, '2', '10']) assert.equal(signatureCount(value), Number(value));
});
test('reject invalid size settings', () => {
  for (const value of ['', 'x', 0, 0.09, -1, 100.1, Infinity, NaN]) assert.throws(() => byteLimit(value));
});
test('file recognition uses bytes rather than filenames', async () => {
  assert.equal(sniff(await pdfFixture()), 'pdf');
  assert.throws(() => sniff(new TextEncoder().encode('not a pdf file')));
  assert.throws(() => sniff(new Uint8Array()));
});
test('reject oversized and malformed image headers before decoding', () => {
  const data = new Uint8Array(24); new DataView(data.buffer).setUint32(16, 100000); new DataView(data.buffer).setUint32(20, 100000);
  assert.throws(() => imageDimensions(data, 'png'), /too large/);
  assert.throws(() => imageDimensions(new Uint8Array(24), 'jpg'), /Invalid|dimensions/);
});
test('ordinary static PDF can be prepared', async () => {
  const info = await inspectPDF(await pdfFixture({ pages: 2 }));
  assert.equal(info.pages, 2); assert.equal(transformIssue(info), null);
});
for (const compressed of [false, true]) test(`signature dictionaries are blocked with object streams ${compressed}`, async () => {
  const info = await inspectPDF(await pdfFixture({ signature: true, compressed }));
  assert.equal(info.signature, true); assert.match(transformIssue(info), /Choose Signed/);
});
test('blank signature fields are conservatively blocked', async () => {
  assert.equal((await inspectPDF(await pdfFixture({ blankSignature: true }))).signature, true);
});
for (const [option, match] of [['form', /Interactive/], ['active', /actions/], ['attachment', /embedded/], ['annotation', /annotations/]]) test(`protect ${option} PDFs`, async () => {
  assert.match(transformIssue(await inspectPDF(await pdfFixture({ [option]: true }))), match);
});
test('escaped raw historical signature marker is protected', async () => {
  const source = await pdfFixture({ compressed: false });
  const encoded = new TextDecoder().decode(source).replace('%%EOF', '% /B#79teRange [0 1 2 3]\n%%EOF');
  assert.equal((await inspectPDF(new TextEncoder().encode(encoded))).signature, true);
});
test('truncated, corrupt and encrypted-marked PDFs fail closed', async () => {
  const bytes = await pdfFixture();
  await assert.rejects(inspectPDF(bytes.slice(0, -8)), /end-of-file/);
  await assert.rejects(inspectPDF(new TextEncoder().encode('%PDF-1.7\nonsense\n%%EOF')), /could not/);
  const encrypted = new TextDecoder().decode(bytes).replace('%%EOF', '% /Encrypt\n%%EOF');
  await assert.rejects(inspectPDF(new TextEncoder().encode(encrypted)), /encrypted/);
});
test('merge retains source page count and order', async () => {
  const a = await pdfFixture({ pages: 2 }), b = await pdfFixture({ pages: 1 });
  const doc = await PDFDocument.load(a); doc.getPages()[0].setSize(300, 400); const resized = await doc.save();
  const merged = await assemble([
    { kind: 'pdf', file: file(resized), info: { pages: 2 } }, { kind: 'pdf', file: file(b), info: { pages: 1 } }
  ], () => { throw new Error('Unexpected rasterization'); });
  const out = await PDFDocument.load(merged);
  assert.equal(out.getPageCount(), 3); assert.equal(out.getPages()[0].getWidth(), 300); assert.equal(out.getPages()[2].getWidth(), 595.28);
});
test('assembly independently refuses signed inputs', async () => {
  const bytes = await pdfFixture({ signature: true });
  await assert.rejects(assemble([{ kind: 'pdf', file: file(bytes), info: { pages: 1 } }], () => {}), /Signature/);
});
test('page safety cap is enforced', async () => {
  await assert.rejects(inspectPDF(await pdfFixture({ pages: 201 })), /1–200/);
});
