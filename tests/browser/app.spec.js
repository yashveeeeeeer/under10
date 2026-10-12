import { test, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { PDFDocument, PDFArray, decodePDFRawStream } from 'pdf-lib';
import { pdfFixture } from '../fixtures.mjs';

const upload = (page, bytes, name = 'synthetic.pdf') => page.locator('#files').setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
async function ready(page) { await page.goto('/'); await expect(page.locator('#status')).toContainText('Ready.'); }
async function prepare(page) { await expect(page.locator('#process')).toBeEnabled(); await page.locator('#process').click(); await expect(page.locator('#result')).toBeVisible(); }
async function download(page) { const waiting = page.waitForEvent('download'); await page.locator('#download').click(); return waiting; }
async function allowScans(page) {
  if (await page.locator('#build-settings').getAttribute('open') === null) await page.locator('#build-settings > summary').click();
  await page.locator('#raster').check();
}
async function image(page, noisy = false) {
  const data = await page.evaluate(noisy => {
    const c = document.createElement('canvas'); c.width = 1600; c.height = 2200; const ctx = c.getContext('2d');
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, c.width, c.height);
    if (noisy) { const d = ctx.createImageData(c.width, c.height); let seed = 1; for (let i = 0; i < d.data.length; i += 4) { seed = (seed * 1664525 + 1013904223) >>> 0; d.data[i] = seed & 255; d.data[i + 1] = seed >>> 8 & 255; d.data[i + 2] = seed >>> 16 & 255; d.data[i + 3] = 255; } ctx.putImageData(d, 0, 0); }
    ctx.fillStyle = '#24563c'; ctx.fillRect(60, 60, 1480, 200); ctx.fillStyle = 'white'; ctx.font = '48px Arial'; ctx.fillText('SYNTHETIC IMAGE — READABILITY TEST', 90, 180);
    ctx.fillStyle = 'black'; ctx.font = '24px Arial'; ctx.fillText('0123456789 | This is a test, not a real passport.', 60, 350);
    return c.toDataURL('image/png').split(',')[1];
  }, noisy);
  return Buffer.from(data, 'base64');
}
test('clean desktop, keyboard access and mobile layout', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await ready(page); await mkdir('tmp/qa', { recursive: true });
  await page.screenshot({ path: 'tmp/qa/desktop.png', fullPage: true });
  await page.keyboard.press('Tab'); await expect(page.getByText('Skip to PDF tool')).toBeFocused();
  await page.locator('h1').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'tmp/qa/mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
test('merge preserves all pages, order, extracted text and requires review', async ({ page }) => {
  await ready(page);
  await page.locator('#files').setInputFiles([
    { name: 'first.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdfFixture({ pages: 2, label: 'FIRST DOCUMENT' })) },
    { name: 'second.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdfFixture({ label: 'SECOND DOCUMENT' })) }
  ]);
  await expect(page.locator('#file-count')).toContainText('3 pages');
  await page.getByRole('button', { name: 'Move up second.pdf' }).click();
  await prepare(page);
  await expect(page.locator('#download')).toBeDisabled();
  await expect(page.locator('#reviewed')).toBeDisabled();
  for (const number of [2, 3]) { await page.locator('#next').click(); await expect(page.locator('#page-label')).toHaveText(`${number} / 3`); }
  await page.locator('#reviewed').check(); const d = await download(page); const bytes = await readFile(await d.path());
  expect(bytes.length).toBeLessThan(9_000_001); expect((await PDFDocument.load(bytes)).getPageCount()).toBe(3);
  const out = await PDFDocument.load(bytes);
  const texts = out.getPages().map(p => {
    const contents = p.node.Contents(); const streams = contents instanceof PDFArray ? contents.asArray().map(ref => out.context.lookup(ref)) : [contents];
    return streams.flatMap(stream => [...new TextDecoder().decode(decodePDFRawStream(stream).decode()).matchAll(/<([0-9a-f]+)>/gi)].map(m => Buffer.from(m[1], 'hex').toString())).join(' ');
  });
  expect(texts[0]).toContain('SECOND DOCUMENT'); expect(texts[1]).toContain('FIRST DOCUMENT'); expect(texts[2]).toContain('page 2');
  await d.saveAs('tmp/qa/merged.pdf'); await page.screenshot({ path: 'tmp/qa/result.png', fullPage: true });
  await page.locator('#clear').click(); await expect(page.locator('#result')).toBeHidden(); await expect(page.locator('#file-list')).toBeEmpty();
});
test('signature markers block merge and unchanged mode preserves SHA-256', async ({ page }) => {
  await ready(page); const bytes = await pdfFixture({ signature: true });
  await upload(page, bytes, 'signed-marker-test.pdf');
  await expect(page.locator('.file-issue')).toContainText('check-only'); await expect(page.locator('#process')).toBeDisabled();
  await page.locator('#check-mode').click(); await prepare(page);
  await expect(page.locator('#result-warning')).toContainText('have not been verified');
  const d = await download(page); const returned = await readFile(await d.path());
  expect(createHash('sha256').update(returned).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
});
test('a genuine synthetic digital signature survives unchanged download', async ({ page }) => {
  await ready(page); const bytes = await readFile('tests/data/signed-synthetic.pdf');
  await allowScans(page);
  await upload(page, bytes, 'signed-synthetic.pdf'); await expect(page.locator('.file-issue')).toContainText('check-only'); await expect(page.locator('#process')).toBeDisabled();
  await page.locator('#check-mode').click(); await prepare(page); const d = await download(page); await d.saveAs('tmp/qa/signed-returned.pdf');
  const returned = await readFile(await d.path()); expect(Buffer.compare(returned, bytes)).toBe(0);
  expect(await page.locator('#hash').textContent()).toBe(createHash('sha256').update(bytes).digest('hex'));
  await page.locator('#build-mode').click();
  await upload(page, await pdfFixture(), 'unsigned.pdf');
  await expect(page.locator('#file-count')).toContainText('2 files');
  await expect(page.locator('#raster')).toBeChecked();
  await expect(page.locator('#process')).toBeDisabled();
  await expect(page.locator('#result')).toBeHidden();
});
test('over-10-MB genuinely signed PDF stays blocked with compression enabled', async ({ page }) => {
  await ready(page);
  const bytes = gunzipSync(await readFile('tests/data/signed-over-limit-synthetic.pdf.gz'));
  expect(bytes.length).toBeGreaterThan(10_000_000);
  await allowScans(page);
  await upload(page, bytes, 'signed-over-10mb.pdf');
  await expect(page.locator('.file-issue')).toContainText('check-only');
  await expect(page.locator('#process')).toBeDisabled();
  await page.locator('#check-mode').click();
  await expect(page.locator('#process')).toBeEnabled();
  await page.locator('#process').click();
  await expect(page.locator('#status')).toContainText('not strictly below');
  await expect(page.locator('#status')).toContainText('It was not changed');
  await expect(page.locator('#result')).toBeHidden();
  await expect(page.locator('#download')).toBeDisabled();
});
test('a genuinely encrypted PDF is rejected', async ({ page }) => {
  await ready(page); await upload(page, await readFile('tests/data/encrypted-synthetic.pdf'));
  await expect(page.locator('.file-issue')).toContainText('encrypted'); await expect(page.locator('#process')).toBeDisabled();
});
test('images and PDFs combine entirely offline with no storage writes', async ({ page, context }) => {
  await page.addInitScript(() => {
    window.storageAttempts = [];
    Storage.prototype.setItem = function () { window.storageAttempts.push('Storage'); throw new Error('Storage forbidden'); };
    IDBFactory.prototype.open = function () { window.storageAttempts.push('IndexedDB'); throw new Error('IDB forbidden'); };
  });
  await ready(page); const png = await image(page);
  const requests = []; page.on('request', req => requests.push(req.url()));
  await context.setOffline(true);
  await page.locator('#files').setInputFiles([{ name: 'scan.png', mimeType: 'image/png', buffer: png }, { name: 'text.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdfFixture()) }]);
  await prepare(page); await page.locator('#next').click(); await expect(page.locator('#page-label')).toHaveText('2 / 2'); await page.locator('#reviewed').check();
  const d = await download(page); const bytes = await readFile(await d.path()); expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2);
  expect(requests).toEqual([]); expect(await page.evaluate(() => window.storageAttempts)).toEqual([]); expect(await context.cookies()).toEqual([]);
  await context.setOffline(false); await page.reload(); await expect(page.locator('#file-list')).toBeEmpty();
});
test('reject fake PDF and hostile filename is text', async ({ page }) => {
  await ready(page); await upload(page, new TextEncoder().encode('this is not a PDF'), '<img src=x onerror=alert(1)>.pdf');
  await expect(page.locator('.file-issue')).toContainText('Unsupported'); await expect(page.locator('#process')).toBeDisabled(); expect(await page.locator('#file-list img').count()).toBe(0);
});
test('annotations, forms and embedded attachments are protected', async ({ page }) => {
  await ready(page);
  for (const option of ['annotation', 'form', 'attachment', 'blankSignature', 'active']) {
    await upload(page, await pdfFixture({ [option]: true })); await expect(page.locator('#process')).toBeDisabled(); await expect(page.locator('.file-issue')).toBeVisible(); await page.locator('#clear').click();
  }
});
test('over-limit original cannot be downloaded; changing settings invalidates output', async ({ page }) => {
  await ready(page); await upload(page, await pdfFixture()); await prepare(page); await page.locator('#size-limit').fill('0'); await expect(page.locator('#result')).toBeHidden(); await expect(page.locator('#process')).toBeDisabled();
  await page.locator('#clear').click(); await page.locator('#size-limit').fill('0.1'); await page.locator('#check-mode').click();
  const small = await pdfFixture({ compressed: false }); const body = Buffer.from(small).toString('latin1'); const big = Buffer.from(body.replace('%%EOF', '% ' + 'x'.repeat(120000) + '\n%%EOF'), 'latin1');
  await upload(page, big); await page.locator('#process').click(); await expect(page.locator('#status')).toContainText('not strictly below'); await expect(page.locator('#result')).toBeHidden();
});
test('scan compression is explicit and stops at quality floor', async ({ page }) => {
  await ready(page); const png = await image(page, true); const pdf = await PDFDocument.create(); const img = await pdf.embedPng(png); pdf.addPage([595, 842]).drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
  await upload(page, await pdf.save()); await page.locator('#size-limit').fill('3'); await page.locator('#process').click(); await expect(page.locator('#status')).toContainText('Cannot meet'); await expect(page.locator('#result')).toBeHidden();
  await allowScans(page); await prepare(page); await expect(page.locator('#result-detail')).toContainText('converted to colour images');
  await page.locator('#reviewed').check(); const d = await download(page); expect((await readFile(await d.path())).length).toBeLessThanOrEqual(2700000);
  await page.locator('#size-limit').fill('0.1'); await page.locator('#process').click(); await expect(page.locator('#status')).toContainText('Cannot meet'); await expect(page.locator('#result')).toBeHidden();
});
test('clear while processing prevents stale output', async ({ page }) => {
  await ready(page); await upload(page, await pdfFixture({ pages: 30 })); await page.locator('#process').click(); await page.locator('#clear').click(); await expect(page.locator('#file-list')).toBeEmpty(); await expect(page.locator('#result')).toBeHidden(); await expect(page.locator('#status')).toContainText('Session cleared');
  await upload(page, await pdfFixture()); await prepare(page); await expect(page.locator('#result-detail')).toContainText('1 page');
});
