// Real browser checks against the published app, with no document uploads.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { compactSignedPDF } from '../src/signed.js';
const folder = 'tmp/qa/dsc/';
const url = process.argv[2] || 'https://yashveeeeeeer.github.io/under10/?v=6ca6738';
const cases = JSON.parse(await readFile(folder + 'manifest.json', 'utf8'));
try {
  const data = await readFile(folder + 'emudhra-public-cps.pdf');
  cases.push({ name: 'emudhra-public-cps', input_bytes: data.length, expected: 'unchanged',
    source: 'https://emudhradigital.com/Downloads/e-Mudhra_CPS.pdf' });
} catch { /* Public provider sample is optional; never committed to the repo. */ }
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
const page = await context.newPage(), requests = [], errors = [], results = [];
page.on('pageerror', e => errors.push(e.message));
await page.addInitScript(() => {
  window.storageWrites = [];
  Storage.prototype.setItem = function () { window.storageWrites.push('Storage'); throw new Error('Storage forbidden'); };
  IDBFactory.prototype.open = function () { window.storageWrites.push('IndexedDB'); throw new Error('Storage forbidden'); };
});
try {
  await page.goto(url); await expect(page.locator('#status')).toHaveText('Ready.');
  page.on('request', req => requests.push(req.url())); await context.setOffline(true);
  await page.locator('#check-mode').click();
  for (const c of cases) {
    const original = await readFile(folder + c.name + '.pdf'); let local;
    try { const out = await compactSignedPDF(new Uint8Array(original), 10_000_000); local = { outcome: 'compressed', bytes: out.bytes.length }; }
    catch (e) { local = { outcome: c.expected === 'blocked' ? 'blocked' : 'unchanged', reason: e.message }; }
    assert.equal(local.outcome, c.expected, c.name + ': local compressor outcome');
    await page.locator('#clear').click();
    await expect(page.locator('#status')).toHaveText('Session cleared.');
    await page.locator('#files').setInputFiles({ name: c.name + '.pdf', mimeType: 'application/pdf', buffer: original });
    await expect(page.locator('#process')).toBeEnabled(); await page.locator('#process').click();
    if (c.expected === 'blocked') {
      await expect(page.locator('#status')).toContainText('not strictly below');
      await expect(page.locator('#result')).toBeHidden();
      results.push({ ...c, local, outcome: 'blocked', message: await page.locator('#status').textContent() }); continue;
    }
    await expect(page.locator('#result')).toBeVisible();
    if (c.expected === 'compressed') {
      await expect(page.locator('#result-warning')).toContainText('Signature integrity checked');
      await expect(page.locator('#page-label')).toHaveText('1 / 1'); await page.locator('#reviewed').check();
    } else await expect(page.locator('#download')).toContainText('unchanged original');
    const waiting = page.waitForEvent('download'); await page.locator('#download').click();
    const d = await waiting, output = await readFile(await d.path());
    if (c.expected === 'unchanged') assert.deepEqual(output, original);
    else {
      const prefix = await readFile(folder + c.prefix_file);
      assert.deepEqual(output.subarray(0, prefix.length), prefix); assert.ok(output.length < original.length);
    }
    await d.saveAs(folder + c.name + '-download.pdf');
    results.push({ ...c, local, outcome: c.expected, output_bytes: output.length, saved: original.length - output.length,
      output_sha256: createHash('sha256').update(output).digest('hex'), message: await page.locator('#result-warning').textContent() });
    console.log(c.name, c.expected, original.length, output.length);
    if (c.name === 'rsa2048-cms-certs') await page.screenshot({ path: folder + 'live-compressed.png' });
    await page.locator('#back-to-files').click();
  }
  assert.deepEqual(requests, []); assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.storageWrites), []);
  const report = { url, cases: results, document_network_requests: 0, storage_writes: 0, page_errors: 0 };
  await writeFile(folder + 'browser-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
