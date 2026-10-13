import { test, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { PDFDocument, PDFArray, decodePDFRawStream, pushGraphicsState, concatTransformationMatrix, drawObject, popGraphicsState, rgb } from 'pdf-lib';
import { pdfFixture } from '../fixtures.mjs';

const upload = (name, bytes) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
async function ready(page) {
  await page.goto(process.env.UNDER10_TEST_URL || '/');
  await expect(page.locator('#status')).toHaveText('Ready.');
}
async function scannedPDF() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const pixels = new Uint8Array(1200 * 1600 * 3).fill(244);
  const ref = doc.context.register(doc.context.stream(pixels, {
    Type: 'XObject', Subtype: 'Image', Width: 1200, Height: 1600,
    ColorSpace: 'DeviceRGB', BitsPerComponent: 8
  }));
  const name = page.node.newXObject('Scan', ref);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(595, 0, 0, 842, 0, 0), drawObject(name), popGraphicsState());
  page.drawText('SCAN DOCUMENT', { x: 42, y: 780, size: 24 });
  page.drawText('Fine print: 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ', { x: 42, y: 744, size: 9 });
  page.drawRectangle({ x: 42, y: 630, width: 90, height: 75, borderColor: rgb(.1, .4, .3), borderWidth: 1.2 });
  page.drawText('TEST SEAL', { x: 53, y: 660, size: 10 });
  return doc.save();
}
async function extractedText(bytes) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map(page => {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map(ref => doc.context.lookup(ref)) : [contents];
    return streams.flatMap(stream => [...new TextDecoder().decode(decodePDFRawStream(stream).decode()).matchAll(/<([0-9a-f]+)>/gi)]
      .map(match => Buffer.from(match[1], 'hex').toString())).join(' ');
  });
}
async function download(page) {
  await page.locator('#reviewed').check();
  const waiting = page.waitForEvent('download');
  await page.locator('#download').click();
  return waiting;
}

test('compresses only the selected scan, retaining other PDF text and page order offline', async ({ page, context }) => {
  await page.addInitScript(() => {
    window.storageAttempts = [];
    Storage.prototype.setItem = function () { window.storageAttempts.push('Storage'); throw new Error('Storage forbidden'); };
    IDBFactory.prototype.open = function () { window.storageAttempts.push('IndexedDB'); throw new Error('IDB forbidden'); };
  });
  await ready(page);
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => requests.push(req.url()));
  await context.setOffline(true);
  const scan = await scannedPDF(), text = await pdfFixture({ label: 'NATIVE TEXT DOCUMENT', pages: 2 });
  await page.locator('#files').setInputFiles([upload('text.pdf', text), upload('scan.pdf', scan)]);
  await expect(page.locator('#process')).toBeEnabled();
  await page.locator('#size-limit').fill('1');
  await page.locator('#process').click();
  await expect(page.locator('#status')).toContainText('Choose scanned PDFs for compression in Options');
  await expect(page.locator('#result')).toBeHidden();
  await page.locator('#options-open').click();
  const choices = page.locator('#scan-files input');
  await expect(choices).toHaveCount(2);
  await expect(choices.first()).toHaveAttribute('aria-label', 'Compress scan.pdf');
  for (const choice of await choices.all()) await expect(choice).not.toBeChecked();
  // Selecting the small text PDF cannot authorize compression of the large scan.
  await page.getByRole('checkbox', { name: 'Compress text.pdf', exact: true }).check();
  await page.locator('#options-close').click();
  await page.locator('#process').click();
  await expect(page.locator('#status')).toContainText('Cannot meet');
  await expect(page.locator('#result')).toBeHidden();
  await page.locator('#options-open').click();
  await page.getByRole('checkbox', { name: 'Compress text.pdf', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Compress scan.pdf', exact: true }).check();
  await mkdir('tmp/qa', { recursive: true });
  await page.screenshot({ path: 'tmp/qa/selective-options-desktop.png', fullPage: true });
  await page.locator('#options-close').click();
  await page.getByRole('button', { name: 'Move up scan.pdf', exact: true }).click();
  await expect(page.locator('#options-open')).toHaveText('Options (1)');
  await page.locator('#process').click();
  await expect(page.locator('#page-label')).toHaveText('1 / 3');
  await expect(page.locator('#result-detail')).toContainText('1 selected PDF file converted to colour images');
  await page.screenshot({ path: 'tmp/qa/selective-result.png', fullPage: true });
  await expect(page.locator('#download')).toBeDisabled();
  for (const number of [2, 3]) {
    await page.locator('#next').click();
    await expect(page.locator('#page-label')).toHaveText(`${number} / 3`);
  }
  const file = await download(page), bytes = await readFile(await file.path());
  expect(bytes.length).toBeLessThanOrEqual(900_000);
  const texts = await extractedText(bytes);
  expect(texts).toHaveLength(3);
  expect(texts[0]).toBe('');
  expect(texts[1]).toContain('NATIVE TEXT DOCUMENT - page 1');
  expect(texts[2]).toContain('NATIVE TEXT DOCUMENT - page 2');
  expect(await extractedText(text)).toEqual(texts.slice(1));
  await file.saveAs('tmp/qa/selective-prepared.pdf');
  console.info(JSON.stringify({ selectiveCompression: { inputBytes: scan.length + text.length, outputBytes: bytes.length, pages: texts.length, nativeTextPages: 2 } }));
  expect(requests).toEqual([]); expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.storageAttempts)).toEqual([]);
});

test('selection is file-specific, invalidates results, and does not rasterize when the original fits', async ({ page }) => {
  await ready(page);
  const text = await pdfFixture({ label: 'KEEP SELECTABLE TEXT' });
  await page.locator('#files').setInputFiles(upload('first.pdf', text));
  await expect(page.locator('#process')).toBeEnabled();
  await page.locator('#options-open').click();
  await page.getByRole('checkbox', { name: 'Compress first.pdf' }).check();
  await page.locator('#options-close').click();
  await page.locator('#process').click();
  await expect(page.locator('#page-label')).toHaveText('1 / 1');
  await expect(page.locator('#result-detail')).toContainText('PDF text and vectors retained');
  const file = await download(page);
  expect((await extractedText(await readFile(await file.path())))[0]).toContain('KEEP SELECTABLE TEXT');
  await page.locator('#back-to-files').click();
  await page.locator('#options-open').click();
  await page.getByRole('checkbox', { name: 'Compress first.pdf' }).uncheck();
  await expect(page.locator('#result')).toBeHidden();
  await expect(page.locator('#download')).toBeDisabled();
  await expect(page.locator('#hash')).toBeEmpty();
  await page.getByRole('checkbox', { name: 'Compress first.pdf' }).check();
  await page.locator('#options-close').click();
  await page.locator('#files').setInputFiles(upload('second.pdf', text));
  await expect(page.locator('#process')).toBeEnabled();
  await expect(page.locator('#scan-files input').nth(1)).not.toBeChecked();
  await page.getByRole('button', { name: 'Move up second.pdf', exact: true }).click();
  await expect(page.locator('#scan-files input').first()).not.toBeChecked();
  await expect(page.locator('#scan-files input').nth(1)).toBeChecked();
  await page.getByRole('button', { name: 'Remove first.pdf', exact: true }).click();
  await expect(page.locator('#options-open')).toHaveText('Options');
  await page.locator('#clear').click();
  await expect(page.locator('#scan-files')).toBeEmpty();
});

test('scan choices exclude signatures and protected PDFs even with another scan selected', async ({ page }) => {
  await ready(page);
  await page.locator('#files').setInputFiles(upload('unsigned.pdf', await pdfFixture()));
  await expect(page.locator('#process')).toBeEnabled();
  await page.locator('#options-open').click();
  await page.getByRole('checkbox', { name: 'Compress unsigned.pdf' }).check();
  await page.locator('#options-close').click();
  await page.locator('#files').setInputFiles([
    upload('signed.pdf', await readFile('tests/data/signed-synthetic.pdf')),
    upload('blank-signature.pdf', await pdfFixture({ blankSignature: true })),
    upload('form.pdf', await pdfFixture({ form: true })),
    upload('annotations.pdf', await pdfFixture({ annotation: true }))
  ]);
  await expect(page.locator('#file-count')).toContainText('5 files');
  await expect(page.locator('#process')).toBeDisabled();
  await page.locator('#options-open').click();
  await expect(page.locator('#scan-files input')).toHaveCount(1);
  await expect(page.locator('#scan-files input')).toBeChecked();
  await page.locator('#options-close').click();
  await page.locator('#check-mode').click();
  await expect(page.locator('#options-open')).toBeHidden();
  await expect(page.locator('#process')).toBeDisabled();
  await page.locator('#build-mode').click();
  await expect(page.locator('#process')).toBeDisabled();
});

test('long scan choices stay reachable on a small phone with enlarged text', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await ready(page);
  const bytes = await pdfFixture();
  const name = 'Long-document-name-'.repeat(8) + '.pdf';
  await page.locator('#files').setInputFiles(Array.from({ length: 12 }, (_, index) => upload(`${index}-${name}`, bytes)));
  await expect(page.locator('#process')).toBeEnabled();
  await page.locator('#options-open').click();
  await page.locator('#scan-files input').last().check();
  await expect(page.locator('#scan-files input').last()).toBeChecked();
  await page.locator('#scan-files input').first().scrollIntoViewIfNeeded();
  await mkdir('tmp/qa', { recursive: true });
  await page.screenshot({ path: 'tmp/qa/selective-options-phone.png', fullPage: true });
  await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
  await page.locator('#scan-files input').last().uncheck();
  expect(await page.locator('#options-dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('#options-open')).toBeFocused();
  await page.locator('#process').scrollIntoViewIfNeeded();
  expect(await page.locator('#process').evaluate(el => el.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
  await page.screenshot({ path: 'tmp/qa/selective-enlarged-phone.png', fullPage: true });
});
