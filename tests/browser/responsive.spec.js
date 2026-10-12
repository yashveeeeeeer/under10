import { test, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { pdfFixture } from '../fixtures.mjs';

async function ready(page) {
  await page.goto('/');
  await expect(page.locator('#status')).toContainText('Ready.');
}
async function noOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
}
async function outputFits(page) {
  await expect.poll(() => page.locator('.canvas-wrap').evaluate(el => {
    const style = getComputedStyle(el);
    const usable = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return el.querySelector('canvas').width <= usable + 1;
  })).toBe(true);
}

for (const width of [320, 360, 390, 430, 768, 1024, 1440, 2560]) {
  test(`layout reflows at ${width}px without page overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await ready(page);
    await noOverflow(page);
    await expect(page.locator('#build-settings')).not.toHaveAttribute('open', '');
    expect(await page.locator('#dropzone').evaluate(el => el.getBoundingClientRect().bottom)).toBeLessThan(900);
    for (const id of ['build-mode', 'check-mode', 'clear', 'process']) {
      expect((await page.locator(`#${id}`).boundingBox()).height).toBeGreaterThanOrEqual(44);
    }
    await page.locator('#privacy-link').click();
    await expect(page.locator('#privacy')).toHaveAttribute('open', '');
    await noOverflow(page);
  });
}

test('200 percent text remains usable at a narrow width', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await ready(page);
  await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
  await noOverflow(page);
  await page.locator('#build-settings > summary').click();
  await page.locator('#raster').check();
  await noOverflow(page);
  await page.locator('#check-mode').click();
  await expect(page.locator('#input-title')).toHaveText('Original PDF');
  await noOverflow(page);
});

test('fit-page preview adapts after resizing and contains explicit zoom', async ({ page }) => {
  await ready(page);
  await page.locator('#files').setInputFiles({ name: 'synthetic.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdfFixture()) });
  await expect(page.locator('#process')).toBeEnabled();
  await page.locator('#process').click();
  await expect(page.locator('#page-label')).toHaveText('1 / 1');
  for (const [width, height] of [[390, 844], [844, 390], [320, 740], [1440, 1000]]) {
    await page.setViewportSize({ width, height });
    await outputFits(page);
    await noOverflow(page);
  }
  await page.setViewportSize({ width: 320, height: 740 });
  await outputFits(page);
  await page.locator('#zoom').selectOption('2');
  await expect.poll(() => page.locator('.canvas-wrap').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await noOverflow(page);
  await page.locator('#zoom').selectOption('1');
  await outputFits(page);
  await page.locator('#reviewed').check();
  await expect(page.locator('#download')).toBeEnabled();
});

test.describe('Touch workflow', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  test('choose, reorder, prepare, review and download on a phone', async ({ page }) => {
    await ready(page);
    await mkdir('tmp/qa', { recursive: true });
    await page.screenshot({ path: 'tmp/qa/phone-home.png', fullPage: true });
    expect((await page.locator('#dropzone').boundingBox()).y).toBeLessThan(300);
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#dropzone').tap();
    const fileChooser = await chooser;
    const bytes = Buffer.from(await pdfFixture());
    const longName = 'Long-document-name-'.repeat(8) + '.pdf';
    await fileChooser.setFiles([
      { name: longName, mimeType: 'application/pdf', buffer: bytes },
      { name: 'second.pdf', mimeType: 'application/pdf', buffer: bytes }
    ]);
    await expect(page.locator('#file-count')).toContainText('2 files');
    await noOverflow(page);
    await page.getByRole('button', { name: 'Move up second.pdf' }).tap();
    await expect(page.locator('.file-name').first()).toHaveText('second.pdf');
    for (const button of await page.locator('.file-actions button').all()) {
      const rect = await button.boundingBox();
      expect(rect.width).toBeGreaterThanOrEqual(44);
      expect(rect.height).toBeGreaterThanOrEqual(44);
    }
    await expect(page.locator('#process')).toBeEnabled();
    await page.locator('#process').tap();
    await expect(page.locator('#page-label')).toHaveText('1 / 2');
    await outputFits(page);
    await page.screenshot({ path: 'tmp/qa/phone-result.png', fullPage: true });
    await page.locator('#next').tap();
    await expect(page.locator('#page-label')).toHaveText('2 / 2');
    await page.locator('#review-row').tap();
    const waiting = page.waitForEvent('download');
    await page.locator('#download').tap();
    const downloaded = await waiting;
    expect((await PDFDocument.load(await readFile(await downloaded.path()))).getPageCount()).toBe(2);
    await noOverflow(page);
  });
});
