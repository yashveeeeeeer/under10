import { test, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { PDFDocument, PDFName, decodePDFRawStream } from 'pdf-lib';

const input = gunzipSync(await readFile('tests/data/signed-certificates.pdf.gz'));
const prefix = await readFile('tests/data/signed-synthetic.pdf');
async function ready(page) { await page.goto('/'); await expect(page.locator('#status')).toHaveText('Ready.'); }
async function upload(page, bytes = input) {
  await page.locator('#check-mode').click();
  await page.locator('#files').setInputFiles({ name: 'signed.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.locator('#process')).toBeEnabled();
}
async function save(page) {
  await expect(page.locator('#page-label')).toHaveText('1 / 1');
  await expect(page.locator('#download')).toBeDisabled();
  await page.locator('#reviewed').check();
  const download = page.waitForEvent('download'); await page.locator('#download').click(); return download;
}

test('signed certificate compression works offline, preserves original signature bytes and needs review', async ({ page, context }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    window.storageAttempts = [];
    Storage.prototype.setItem = function () { window.storageAttempts.push('Storage'); throw new Error('Storage forbidden'); };
    IDBFactory.prototype.open = function () { window.storageAttempts.push('IndexedDB'); throw new Error('Storage forbidden'); };
  });
  await ready(page); const requests = []; page.on('request', req => requests.push(req.url()));
  await context.setOffline(true); await upload(page);
  await page.locator('#process').click(); await expect(page.locator('#result')).toBeVisible();
  await expect(page.locator('#result-warning')).toContainText('Signature integrity checked');
  const d = await save(page); const out = await readFile(await d.path());
  expect(d.suggestedFilename()).toBe('compressed-signed-document.pdf');
  expect(out.length).toBeLessThan(10_000_000); expect(out.length).toBeLessThan(input.length);
  expect(Buffer.compare(out.subarray(0, prefix.length), prefix)).toBe(0);
  const pdf = await PDFDocument.load(out); expect(pdf.getPageCount()).toBe(1);
  const certs = pdf.catalog.lookup(PDFName.of('DSS')).lookup(PDFName.of('Certs'));
  expect(certs.size()).toBe(14_000);
  const originalCert = await readFile('tests/data/synthetic-certificate.der');
  expect(Buffer.compare(Buffer.from(decodePDFRawStream(pdf.context.lookup(certs.get(0))).decode()), originalCert)).toBe(0);
  expect(await page.locator('#hash').textContent()).toBe(createHash('sha256').update(out).digest('hex'));
  await mkdir('tmp/qa', { recursive: true }); await d.saveAs('tmp/qa/signed-compressed-browser.pdf');
  expect(requests).toEqual([]); expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.storageAttempts)).toEqual([]); expect(await context.cookies()).toEqual([]);
});

test('an eligible signed file is compressed even when the original already fits', async ({ page }) => {
  await ready(page); await upload(page); await page.locator('#size-limit').fill('20');
  await page.locator('#process').click(); await expect(page.locator('#result-warning')).toContainText('Signature integrity checked');
  const d = await save(page); expect((await readFile(await d.path())).length).toBeLessThan(input.length);
});

test('tampered signature cannot produce a compressed download', async ({ page }) => {
  await ready(page);
  const tampered = Buffer.from(input.toString('latin1').replace('/Author (anonymous)', '/Author (Anonymous)'), 'latin1');
  await upload(page, tampered); await page.locator('#process').click();
  await expect(page.locator('#status')).toContainText('Signature integrity check failed');
  await expect(page.locator('#result')).toBeHidden(); await expect(page.locator('#download')).toBeDisabled();
  await page.locator('#size-limit').fill('20'); await page.locator('#process').click();
  await expect(page.locator('#result-warning')).toContainText('Signature integrity check failed');
  const waiting = page.waitForEvent('download'); await page.locator('#download').click();
  expect(Buffer.compare(await readFile(await (await waiting).path()), tampered)).toBe(0);
});

test('impossible target blocks the compressed result and allows retry', async ({ page }) => {
  await ready(page); await upload(page); await page.locator('#size-limit').fill('0.1'); await page.locator('#process').click();
  await expect(page.locator('#status')).toContainText('compressed result still reaches'); await expect(page.locator('#result')).toBeHidden();
  await page.locator('#size-limit').fill('1'); await page.locator('#process').click();
  await expect(page.locator('#result-warning')).toContainText('Signature integrity checked');
  await page.locator('#back-to-files').click(); await page.locator('#build-mode').click();
  await expect(page.locator('#result')).toBeHidden(); await expect(page.locator('#process')).toBeDisabled();
});

test('cancelling a signature job destroys worker state and allows a fresh job', async ({ page }) => {
  await ready(page); await upload(page); await page.locator('#process').click();
  await page.locator('#cancel').click();
  await expect(page.locator('#status')).toHaveText('Session cleared.');
  await expect(page.locator('#file-list')).toBeEmpty(); await expect(page.locator('#result')).toBeHidden();
  await upload(page); await page.locator('#process').click(); await expect(page.locator('#result-warning')).toContainText('Signature integrity checked');
});

test('signature selector is labelled, keyboard operable and fits small screens', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 480 }); await ready(page);
  await expect(page.getByRole('group', { name: 'Digital signature' })).toBeVisible();
  await page.locator('#build-mode').focus(); await page.keyboard.press('Tab'); await expect(page.locator('#check-mode')).toBeFocused();
  await page.keyboard.press('Space'); await expect(page.locator('#check-mode')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#build-mode')).toHaveAttribute('aria-pressed', 'false');
  const label = await page.locator('#signature-choice-label').boundingBox(), choice = await page.locator('#check-mode').boundingBox();
  expect(label.y + label.height).toBeLessThanOrEqual(choice.y); expect(choice.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  await mkdir('tmp/qa', { recursive: true }); await page.screenshot({ path: 'tmp/qa/signed-choice-320.png' });
});

test('signed result fits a phone and keeps review and download reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await ready(page); await upload(page);
  await page.locator('#process').click(); await expect(page.locator('#page-label')).toHaveText('1 / 1');
  for (const id of ['back-to-files', 'reviewed', 'download', 'details-open']) {
    const b = await page.locator(`#${id}`).boundingBox(); expect(b.y).toBeGreaterThanOrEqual(0); expect(b.y + b.height).toBeLessThanOrEqual(844);
  }
  await page.screenshot({ path: 'tmp/qa/signed-result-phone.png' });
  const d = await save(page); expect((await readFile(await d.path())).length).toBeLessThan(10_000_000);
});
