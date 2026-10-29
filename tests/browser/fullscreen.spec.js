import { test, expect } from '@playwright/test';
import { pdfFixture } from '../fixtures.mjs';

async function inScreen(page, selector) {
  const visible = await page.locator(selector).evaluate(el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
  });
  expect(visible, `${selector} must stay within the screen`).toBe(true);
}
async function noPageScroll(page) {
  expect(await page.evaluate(() => ({
    vertical: document.documentElement.scrollHeight <= innerHeight + 1,
    horizontal: document.documentElement.scrollWidth <= innerWidth + 1
  }))).toEqual({ vertical: true, horizontal: true });
}

for (const [width, height] of [[320, 480], [320, 568], [360, 640], [390, 844], [430, 932], [568, 320], [844, 390], [768, 1024], [1024, 600], [1366, 768], [2560, 1440]]) {
  test(`all primary controls fit ${width}x${height} before and after preparation`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('./'); await expect(page.locator('#status')).toHaveText('Ready.');
    await noPageScroll(page);
    expect(await page.locator('#action-hint').evaluate(el => innerHeight - el.getBoundingClientRect().bottom)).toBeLessThan(40);
    for (const id of ['dropzone', 'process', 'size-limit', 'reserve', 'signature-count', 'options-open']) await inScreen(page, `#${id}`);
    await page.locator('#options-open').click();
    await inScreen(page, '#options-close'); await expect(page.locator('#scan-empty')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#options-open')).toBeFocused();
    await page.locator('#files').setInputFiles({ name: 'pages.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdfFixture({ pages: 2 })) });
    await expect(page.locator('#process')).toBeEnabled(); await inScreen(page, '#process');
    await page.locator('#process').click(); await expect(page.locator('#page-label')).toHaveText('1 / 2');
    await noPageScroll(page);
    for (const id of ['back-to-files', 'next', 'zoom', 'reviewed', 'download', 'details-open']) await inScreen(page, `#${id}`);
    const fits = await page.locator('.canvas-wrap').evaluate(el => el.querySelector('canvas').height <= el.clientHeight && el.querySelector('canvas').width <= el.clientWidth);
    expect(fits).toBe(true);
    await page.locator('#details-open').click();
    await page.locator('#hash-details > summary').click();
    await expect(page.locator('#hash')).toBeVisible();
    await page.locator('#details-close').click();
    await expect(page.locator('#details-open')).toBeFocused();
    await page.locator('#next').click(); await expect(page.locator('#page-label')).toHaveText('2 / 2');
    await page.locator('#reviewed').check(); await expect(page.locator('#download')).toBeEnabled();
    await page.locator('#back-to-files').click();
    await expect(page.locator('#file-count')).toHaveText('1 file, 2 pages');
    await inScreen(page, '#process'); await noPageScroll(page);
  });
}

test('a long file list scrolls independently and keeps Prepare reachable', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('./'); await expect(page.locator('#status')).toHaveText('Ready.');
  const bytes = Buffer.from(await pdfFixture());
  await page.locator('#files').setInputFiles(Array.from({ length: 20 }, (_, i) => ({ name: `document-${i}.pdf`, mimeType: 'application/pdf', buffer: bytes })));
  await expect(page.locator('#file-count')).toHaveText('20 files, 20 pages');
  await noPageScroll(page); await inScreen(page, '#process');
  expect(await page.locator('#file-list').evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await page.getByRole('button', { name: 'Remove document-19.pdf', exact: true }).click();
  await expect(page.locator('#file-count')).toHaveText('19 files, 19 pages');
  await inScreen(page, '#process'); await noPageScroll(page);
});

test('a shorter viewport and enlarged text keep controls reachable', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('./'); await expect(page.locator('#status')).toHaveText('Ready.');
  await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
  await page.locator('#options-open').click(); await expect(page.locator('#scan-empty')).toBeVisible();
  await page.locator('#options-close').click(); await noPageScroll(page); await inScreen(page, '#process');
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  await page.setViewportSize({ width: 390, height: 420 });
  await page.locator('#size-limit').fill('3'); await expect(page.locator('#target')).toHaveText('2.8 MB');
  await inScreen(page, '#process'); await noPageScroll(page);
});
