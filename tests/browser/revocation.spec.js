import { test, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { manifest, fixture, snapshot } from '../revocation-helpers.mjs';
const target = process.env.UNDER10_TEST_URL || '/';
const suffix = process.env.UNDER10_TEST_URL ? 'live' : 'browser';

for (const [index, c] of manifest.entries()) test(`${c.name}: actual offline worker, review and download`, async ({ page, context }) => {
  if (index === 1) await page.setViewportSize({ width: 390, height: 844 });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    window.storageWrites = [];
    Storage.prototype.setItem = function () { window.storageWrites.push('storage'); throw new Error('No storage'); };
    IDBFactory.prototype.open = function () { window.storageWrites.push('idb'); throw new Error('No storage'); };
  });
  await page.goto(target); await expect(page.locator('#status')).toHaveText('Ready.');
  // Context-level monitoring includes workers. Edge's own downloads panel uses
  // edge:// resources; those are local browser UI, not document network traffic.
  const requests = []; context.on('request', r => { if (/^(https?|wss?):/.test(r.url())) requests.push(r.url()); }); await context.setOffline(true);
  const input = Buffer.from(await fixture(c.name));
  await page.locator('#check-mode').click();
  await page.locator('#files').setInputFiles({ name: 'signed.pdf', mimeType: 'application/pdf', buffer: input });
  await expect(page.locator('#process')).toBeEnabled(); await page.locator('#process').click();
  await expect(page.locator('#result-warning')).toContainText('Signature integrity checked', { timeout: 40_000 });
  await expect(page.locator('#page-label')).toHaveText('1 / 1');
  await expect(page.locator('#download')).toBeDisabled(); await page.locator('#reviewed').check();
  const waiting = page.waitForEvent('download'); await page.locator('#download').click();
  const download = await waiting, output = await readFile(await download.path());
  expect(output.length).toBeLessThan(input.length); expect(output.length).toBeLessThan(10_000_000);
  expect(output.subarray(0, c.signed_bytes)).toEqual(input.subarray(0, c.signed_bytes));
  expect(await snapshot(output)).toEqual(await snapshot(input));
  await mkdir('tmp/qa/revocation', { recursive: true });
  await download.saveAs(`tmp/qa/revocation/${c.name}-${suffix}.pdf`);
  await page.screenshot({ path: `tmp/qa/revocation/${c.name}-${suffix}.png` });
  expect(requests).toEqual([]); expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.storageWrites)).toEqual([]);
  expect(await context.cookies()).toEqual([]);
});

test('fully signed oversized file gets a verified byte diagnosis and no transformed download', async ({ page }) => {
  await page.goto(target); await expect(page.locator('#status')).toHaveText('Ready.');
  const bytes = Buffer.from(await fixture('signed-over-limit-synthetic'));
  await page.locator('#check-mode').click();
  await page.locator('#files').setInputFiles({ name: 'signed.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.locator('#process')).toBeEnabled(); await page.locator('#process').click();
  await expect(page.locator('#status')).toContainText(`The signature protects ${bytes.length.toLocaleString('en-US')} bytes`);
  await expect(page.locator('#status')).toContainText('sign it again');
  await expect(page.locator('#result')).toBeHidden(); await expect(page.locator('#download')).toBeDisabled();
  await page.locator('#size-limit').fill('20'); await page.locator('#process').click();
  await expect(page.locator('#result-warning')).toContainText('no unsigned validation data');
  const waiting = page.waitForEvent('download'); await page.locator('#download').click();
  expect(await readFile(await (await waiting).path())).toEqual(bytes);
});
