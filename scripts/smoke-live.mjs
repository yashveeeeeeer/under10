import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { pdfFixture } from '../tests/fixtures.mjs';

const url = process.argv[2];
if (!url) throw new Error('Pass the published website URL. Only synthetic fixtures are used.');
const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const response = await page.goto(url);
  assert.equal(response.status(), 200);
  await page.locator('#status').filter({ hasText: 'Ready.' }).waitFor();
  await mkdir('tmp/qa', { recursive: true });
  await page.screenshot({ path: 'tmp/qa/live.png', fullPage: true });
  const requests = [];
  page.on('request', r => requests.push({ method: r.method(), url: r.url() }));
  const signed = await readFile('tests/data/signed-synthetic.pdf');
  await page.locator('#files').setInputFiles({ name: 'synthetic-signed-test.pdf', mimeType: 'application/pdf', buffer: signed });
  await page.locator('.file-issue').filter({ hasText: 'check-only' }).waitFor();
  assert.equal(await page.locator('#process').isDisabled(), true);
  await page.locator('#check-mode').click(); await page.locator('#process').click();
  await page.locator('#result').waitFor();
  const waiting = page.waitForEvent('download'); await page.locator('#download').click();
  const download = await waiting;
  assert.deepEqual(await readFile(await download.path()), signed);
  await page.locator('#clear').click(); await page.locator('#build-mode').click();
  await page.locator('#files').setInputFiles({ name: 'synthetic-unsigned-test.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdfFixture()) });
  await page.locator('#process:not(:disabled)').waitFor(); await page.locator('#process').click(); await page.locator('#result').waitFor();
  await page.locator('#reviewed:not(:disabled)').waitFor(); await page.locator('#reviewed').check();
  assert.equal(await page.locator('#download').isDisabled(), false);
  assert.deepEqual(requests, []);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ url, status: 200, signatureBlockedFromMerge: true, signedDownloadByteIdentical: true, unsignedPreparation: true, documentNetworkRequests: 0, pageErrors: 0 }, null, 2));
} finally { await browser.close(); }
