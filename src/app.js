import { PDFWorker, GlobalWorkerOptions, getDocument } from 'pdfjs-dist/build/pdf.mjs';
import { LIMITS, PROFILES, mb, byteLimit, targetBytes, fits, sniff, imageDimensions, inspectPDF, transformIssue, assemble } from './core.js';

GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.mjs', import.meta.url).href;
const $ = id => document.getElementById(id);
let items = [], mode = 'build', busy = false, engineReady = false, generation = 0, result = null, previewDoc = null, previewPage = 1, renderTask = null;
let worker;
const tasks = new Set();
const urls = new Set();
const nextTick = () => new Promise(resolve => setTimeout(resolve, 0));
function status(text, kind = '') { $('status').textContent = text; $('status').className = `status ${kind}`; }
function checkGeneration(g) { if (g !== generation) throw new Error('Cancelled. Your original files are unchanged.'); }
function setBusy(value) {
  busy = value;
  document.querySelector('.work-grid').setAttribute('aria-busy', String(value));
  for (const id of ['files', 'size-limit', 'reserve', 'raster', 'build-mode', 'check-mode', 'check-shortcut']) $(id).disabled = value;
  document.querySelectorAll('.file-actions button').forEach(el => el.disabled = value);
  $('cancel').hidden = !value;
  updateControls();
}
function updateControls() {
  let limit;
  try { limit = byteLimit($('size-limit').value); } catch { /* Invalid field blocks the action. */ }
  const valid = items.length > 0 && items.every(i => !i.error && i.info);
  const issues = mode === 'build' && items.some(i => i.kind === 'pdf' && i.info && transformIssue(i.info));
  const pages = items.reduce((sum, i) => sum + (i.info?.pages || 0), 0);
  $('process').disabled = busy || !engineReady || !limit || !valid || issues || pages > LIMITS.pages || (mode === 'check' && (items.length !== 1 || items[0].kind !== 'pdf'));
  $('target').textContent = limit ? mb(mode === 'check' ? limit : targetBytes(limit, $('reserve').checked)) : 'Choose a limit';
  $('target-label').textContent = mode === 'check' ? 'Strictly smaller than' : 'Working target';
  $('file-count').textContent = `${items.length} ${items.length === 1 ? 'file' : 'files'}${pages ? ` · ${pages} pages` : ''}`;
  $('empty-note').hidden = items.length > 0;
}
function renderList() {
  const list = $('file-list'); list.replaceChildren();
  items.forEach((item, index) => {
    const row = document.createElement('div'); row.className = 'file-row';
    const icon = document.createElement('span'); icon.className = 'file-icon'; icon.textContent = (item.kind || '?').toUpperCase();
    const body = document.createElement('div');
    const name = document.createElement('p'); name.className = 'file-name'; name.textContent = item.file.name;
    const meta = document.createElement('p'); meta.className = 'file-meta';
    meta.textContent = `${mb(item.file.size)}${item.info ? ` · ${item.info.pages} ${item.info.pages === 1 ? 'page' : 'pages'}` : ''}${item.info?.signature ? ' · Signature marker / field' : ''}`;
    body.append(name, meta);
    const issue = item.error || (mode === 'build' && item.info && item.kind === 'pdf' && transformIssue(item.info));
    if (issue) { const p = document.createElement('p'); p.className = 'file-issue'; p.textContent = issue; body.append(p); }
    const actions = document.createElement('div'); actions.className = 'file-actions';
    for (const [label, symbol, move, disabled] of [['Move up', '↑', -1, index === 0], ['Move down', '↓', 1, index === items.length - 1], ['Remove', '×', 0, false]]) {
      const button = document.createElement('button'); button.className = 'small-button'; button.textContent = symbol; button.setAttribute('aria-label', `${label} ${item.file.name}`); button.disabled = busy || disabled;
      button.addEventListener('click', () => { clearResult(); if (move) [items[index], items[index + move]] = [items[index + move], items[index]]; else items.splice(index, 1); renderList(); status('Workspace updated. Prepare the files again to create a new result.'); });
      actions.append(button);
    }
    row.append(icon, body, actions); list.append(row);
  });
  updateControls();
}
async function loadPDF(bytes) {
  const task = getDocument({ data: bytes.slice(), worker, isEvalSupported: false, useWasm: false, useSystemFonts: true, disableFontFace: true, stopAtErrors: true, maxImageSize: LIMITS.imagePixels, verbosity: 0 });
  tasks.add(task);
  try { const doc = await task.promise; return { doc, release: async () => { tasks.delete(task); await task.destroy(); } }; }
  catch (e) { tasks.delete(task); await task.destroy().catch(() => {}); throw e; }
}
async function clearResult() {
  result = null;
  $('result').hidden = true; $('reviewed').checked = false; $('download').disabled = true;
  $('hash').textContent = ''; $('result-detail').textContent = ''; $('result-warning').textContent = '';
  if (renderTask) { renderTask.cancel(); renderTask = null; }
  const previousPreview = previewDoc; previewDoc = null;
  const canvas = $('preview'); canvas.width = canvas.height = 0;
  for (const url of urls) URL.revokeObjectURL(url);
  urls.clear();
  if (previousPreview) await previousPreview.release().catch(() => {});
}
async function reset() {
  generation++;
  setBusy(true);
  items = [];
  $('files').value = '';
  await clearResult();
  await Promise.allSettled([...tasks].map(t => t.destroy())); tasks.clear();
  setBusy(false); renderList(); status('Session cleared. The app has released its document references and previews.');
}
function setMode(next) {
  if (busy) return;
  mode = next; generation++; clearResult();
  const check = mode === 'check';
  $('build-mode').setAttribute('aria-pressed', String(!check)); $('check-mode').setAttribute('aria-pressed', String(check));
  $('input-title').textContent = check ? 'Add one original PDF' : 'Add your documents';
  $('input-help').textContent = check ? 'Check its size. Keep its exact bytes and existing signatures unchanged.' : 'Unsigned PDFs and images, in the order you want them.';
  $('formats').textContent = check ? 'One PDF · up to 40 MB · no rewriting' : 'PDF, JPG, PNG · up to 40 files · 100 MB total';
  $('files').accept = check ? '.pdf,application/pdf' : '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png';
  $('files').multiple = !check;
  $('build-settings').hidden = check;
  $('settings-title').textContent = check ? 'Your size check' : 'Your output';
  $('process').textContent = check ? 'Check PDF ↗' : 'Prepare PDF ↗';
  $('action-hint').textContent = check ? 'No compression or signature validation. A passing file is returned byte for byte.' : 'We stop if the file cannot fit within the quality floor. No pages are dropped.';
  renderList();
  status(check ? 'Select exactly one PDF. Remove extra files if needed. No document will be rewritten.' : 'Add unsigned documents to begin.');
}
async function addFiles(list) {
  if (busy || !engineReady || !list.length) return;
  const selected = Array.from(list);
  if (items.length + selected.length > LIMITS.files) { status('Too many files. The maximum is 40; nothing from this selection was added.', 'error'); return; }
  if (items.reduce((n, i) => n + i.file.size, 0) + selected.reduce((n, f) => n + f.size, 0) > LIMITS.totalBytes) { status('This selection would exceed 100 MB. Nothing from it was added.', 'error'); return; }
  await clearResult();
  const g = ++generation; setBusy(true);
  try {
    for (const file of selected) {
      checkGeneration(g); status(`Checking ${items.length + 1} selected file(s)…`);
      const item = { file };
      try {
        if (!file.size || file.size > LIMITS.fileBytes) throw new Error('Use a non-empty file smaller than or equal to 40 MB.');
        const bytes = new Uint8Array(await file.arrayBuffer()); checkGeneration(g);
        item.kind = sniff(bytes);
        if (item.kind === 'pdf') item.info = await inspectPDF(bytes);
        else { imageDimensions(bytes, item.kind); const bitmap = await createImageBitmap(file); bitmap.close(); item.info = { pages: 1 }; }
      } catch (e) { checkGeneration(g); item.error = e.message; }
      checkGeneration(g); items.push(item); renderList(); await nextTick();
    }
    const count = items.reduce((s, i) => s + (i.info?.pages || 0), 0);
    const blocked = items.some(i => i.error || (mode === 'build' && i.kind === 'pdf' && transformIssue(i.info)));
    status(count > LIMITS.pages ? 'The 200-page safety limit has been exceeded. Remove files to continue.' : blocked ? 'Some files need attention. Remove them or use Check an existing PDF where available.' : 'Files checked. Confirm the order and size limit, then continue.', blocked || count > LIMITS.pages ? 'error' : '');
  } catch (e) { if (g === generation) status(e.message, 'error'); }
  finally { if (g === generation) { setBusy(false); renderList(); } $('files').value = ''; }
}
function canvasJPEG(canvas, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? blob.arrayBuffer().then(buffer => resolve(new Uint8Array(buffer)), reject) : reject(new Error('The browser could not encode this page.')), 'image/jpeg', quality));
}
async function imagePages(item, profile, accept, g) {
  if (item.kind !== 'pdf') {
    const bitmap = await createImageBitmap(item.file, { imageOrientation: 'from-image' });
    let canvas;
    try {
      checkGeneration(g);
      const landscape = bitmap.width > bitmap.height;
      const width = landscape ? 841.89 : 595.28, height = landscape ? 595.28 : 841.89;
      canvas = document.createElement('canvas'); canvas.width = Math.ceil(width / 72 * profile.dpi); canvas.height = Math.ceil(height / 72 * profile.dpi);
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
      const w = bitmap.width * scale, h = bitmap.height * scale;
      ctx.drawImage(bitmap, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      const bytes = await canvasJPEG(canvas, profile.quality); checkGeneration(g);
      await accept({ bytes, width, height });
    } finally { bitmap.close(); if (canvas) canvas.width = canvas.height = 0; }
    return;
  }
  // Re-inspect before any irreversible representation change, even if the UI already screened the file.
  const original = new Uint8Array(await item.file.arrayBuffer());
  const issue = transformIssue(await inspectPDF(original)); if (issue) throw new Error(issue);
  const source = await loadPDF(original);
  try {
    for (let i = 1; i <= source.doc.numPages; i++) {
      checkGeneration(g); status(`Compressing PDF page ${i} of ${source.doc.numPages} · ${profile.dpi} DPI`);
      const page = await source.doc.getPage(i), base = page.getViewport({ scale: 1 });
      const view = page.getViewport({ scale: profile.dpi / 72 });
      if (Math.ceil(view.width) * Math.ceil(view.height) > LIMITS.renderPixels || Math.max(view.width, view.height) > 16000) throw new Error('A PDF page is too large to render within the safety limit. Use a smaller source page.');
      const canvas = document.createElement('canvas'); canvas.width = Math.ceil(view.width); canvas.height = Math.ceil(view.height);
      try {
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: view, background: 'rgb(255,255,255)' }).promise;
        checkGeneration(g);
        const bytes = await canvasJPEG(canvas, profile.quality);
        await accept({ bytes, width: base.width, height: base.height });
      } finally { canvas.width = canvas.height = 0; page.cleanup(); }
      await nextTick();
    }
  } finally { await source.release(); }
}
async function validateRendering(bytes, expectedPages, g) {
  const source = await loadPDF(bytes);
  try {
    if (source.doc.numPages !== expectedPages) throw new Error('Output page count changed. Download blocked.');
    for (let i = 1; i <= source.doc.numPages; i++) {
      checkGeneration(g); status(`Validating output page ${i} of ${source.doc.numPages}…`);
      const page = await source.doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(.5, 900 / Math.max(base.width, base.height)) });
      const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      try { await page.render({ canvasContext: canvas.getContext('2d'), viewport, background: 'rgb(255,255,255)' }).promise; }
      finally { canvas.width = canvas.height = 0; page.cleanup(); }
      await nextTick();
    }
  } finally { await source.release(); }
}
async function processFiles() {
  if ($('process').disabled) return;
  await clearResult();
  const g = ++generation; setBusy(true);
  try {
    const limit = byteLimit($('size-limit').value);
    let bytes, detail, warning, unchanged = mode === 'check';
    const pages = items.reduce((n, i) => n + i.info.pages, 0);
    if (unchanged) {
      bytes = new Uint8Array(await items[0].file.arrayBuffer());
      if (!fits(bytes.length, limit)) throw new Error(`This original is ${mb(bytes.length)} (${bytes.length.toLocaleString()} bytes), so it is not strictly below ${mb(limit)}. It was not changed. Obtain a smaller unsigned source before signing.`);
      detail = `${pages} pages · ${bytes.length.toLocaleString()} bytes · Original bytes unchanged`;
      warning = items[0].info.signature ? 'Signature marker / field detected. The original file is unchanged; signature validity and certificate trust have not been verified. Validate it in your trusted PDF reader.' : 'Size check only. No signature markers were detected by these checks; that is not a certificate validation. The original file is unchanged.';
    } else {
      const target = targetBytes(limit, $('reserve').checked);
      let used, raster = false;
      const run = async (profile, scans) => {
        checkGeneration(g); status(`Preparing ${scans ? 'scan' : 'text-preserving'} candidate · ${profile.dpi} DPI images…`); await nextTick();
        return assemble(items.map(i => ({ ...i, raster: scans && i.kind === 'pdf' })), (item, accept) => imagePages(item, profile, accept, g), text => status(text), () => checkGeneration(g));
      };
      for (const profile of PROFILES) {
        bytes = await run(profile, false); used = profile;
        if (bytes.length <= target) break;
        if (items.every(i => i.kind === 'pdf')) break;
      }
      if (bytes.length > target && $('raster').checked && items.some(i => i.kind === 'pdf')) {
        raster = true;
        for (const profile of PROFILES) { bytes = await run(profile, true); used = profile; if (bytes.length <= target) break; }
      }
      if (bytes.length > target || !fits(bytes.length, limit)) throw new Error(`Cannot meet the ${mb(target)} working target within the quality floor. No download created. ${!$('raster').checked ? 'You can explicitly allow scan compression for unsigned PDFs, or ' : ''}use smaller source scans or prepare separate attachments where your filing permits. No pages were removed.`);
      await validateRendering(bytes, pages, g);
      detail = `${pages} pages · ${bytes.length.toLocaleString()} bytes · ${raster ? 'PDF pages converted to colour images' : 'PDF text and vectors retained'}${raster || items.some(i => i.kind !== 'pdf') ? ` · Images: ${used.dpi} DPI, JPEG ${Math.round(used.quality * 100)}%` : ''}`;
      warning = raster ? 'Scan compression used. Selectable text, tags and bookmarks are removed. Check small text, stamps and seals on every page. Sign only after the final review, then recheck the signed file’s size.' : 'Check every page for completeness and readability. Document-level bookmarks, tags and metadata are not retained in the combined PDF. Sign afterwards if needed, then recheck the signed file’s size.';
    }
    checkGeneration(g);
    const hashBytes = await crypto.subtle.digest('SHA-256', bytes); checkGeneration(g);
    result = { bytes, limit, pages, unchanged, hash: Array.from(new Uint8Array(hashBytes), b => b.toString(16).padStart(2, '0')).join(''), name: unchanged ? items[0].file.name : 'prepared-document.pdf', visited: new Set() };
    $('result-title').textContent = unchanged ? 'Your original fits the size limit.' : 'Your PDF is ready to review.';
    $('result-kicker').textContent = unchanged ? 'SIZE CHECK · ORIGINAL UNCHANGED' : 'PREPARED ON YOUR DEVICE';
    $('result-size').textContent = mb(bytes.length); $('result-detail').textContent = detail; $('result-warning').textContent = warning; $('hash').textContent = result.hash;
    $('preview-area').hidden = unchanged; $('review-row').hidden = unchanged; $('download').textContent = unchanged ? 'Download unchanged original ↓' : 'Download PDF ↓';
    $('result').hidden = false;
    if (!unchanged) { previewDoc = await loadPDF(bytes); checkGeneration(g); previewPage = 1; $('zoom').value = '1'; await showPage(g); }
    refreshDownload();
    status(unchanged ? 'Size check passed. Original bytes preserved; signature validity is unverified.' : 'Size and page-count checks passed. Review every page before downloading.', 'success');
    $('result').scrollIntoView({ behavior: 'instant', block: 'start' });
  } catch (e) { if (g === generation) { await clearResult(); status(e.message || 'The file could not be safely prepared. No download created.', 'error'); } }
  finally { if (g === generation) { setBusy(false); renderList(); } }
}
let previewSerial = 0;
async function showPage(g = generation) {
  const serial = ++previewSerial;
  if (!previewDoc || !result) return;
  if (renderTask) { renderTask.cancel(); try { await renderTask.promise; } catch {} }
  const page = await previewDoc.doc.getPage(previewPage); checkGeneration(g);
  if (serial !== previewSerial) return;
  const base = page.getViewport({ scale: 1 });
  const container = document.querySelector('.canvas-wrap');
  const desiredScale = Math.min(1.1, (container.clientWidth - 42) / base.width) * Number($('zoom').value);
  const scale = Math.min(desiredScale, Math.sqrt(LIMITS.renderPixels / (base.width * base.height)), 16000 / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = $('preview'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
  renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport, background: 'rgb(255,255,255)' });
  try { await renderTask.promise; } catch (e) { if (e.name === 'RenderingCancelledException') return; throw e; }
  if (serial !== previewSerial || g !== generation || !result) return;
  renderTask = null; result.visited.add(previewPage);
  $('page-label').textContent = `${previewPage} / ${result.pages}`;
  $('previous').disabled = previewPage <= 1; $('next').disabled = previewPage >= result.pages;
  refreshDownload();
}
function refreshDownload() {
  const ready = result && (result.unchanged || (result.visited.size === result.pages && $('reviewed').checked));
  $('download').disabled = !ready;
  $('reviewed').disabled = !result || result.visited.size !== result.pages;
  $('download-note').textContent = !result ? '' : result.unchanged ? 'Byte for byte. No changes to your original.' : ready ? 'Saved only when you choose to download.' : `${result.visited.size} of ${result.pages} pages opened. Review all pages and confirm.`;
}
function download() {
  if (!result || $('download').disabled || !fits(result.bytes.length, result.limit)) return;
  const url = URL.createObjectURL(new Blob([result.bytes], { type: 'application/pdf' })); urls.add(url);
  const a = document.createElement('a'); a.href = url; a.download = result.name; a.click();
  setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 30000);
}
$('files').addEventListener('change', e => addFiles(e.target.files));
for (const name of ['dragenter', 'dragover']) $('dropzone').addEventListener(name, e => { e.preventDefault(); if (!busy) $('dropzone').classList.add('dragover'); });
for (const name of ['dragleave', 'drop']) $('dropzone').addEventListener(name, e => { e.preventDefault(); $('dropzone').classList.remove('dragover'); });
$('dropzone').addEventListener('drop', e => addFiles(e.dataTransfer.files));
window.addEventListener('dragover', e => e.preventDefault()); window.addEventListener('drop', e => e.preventDefault());
$('process').addEventListener('click', processFiles);
$('clear').addEventListener('click', reset);
$('cancel').addEventListener('click', reset);
$('build-mode').addEventListener('click', () => setMode('build'));
$('check-mode').addEventListener('click', () => setMode('check'));
$('check-shortcut').addEventListener('click', () => { setMode('check'); $('workspace').scrollIntoView(); });
for (const id of ['size-limit', 'reserve', 'raster']) $(id).addEventListener('input', () => { generation++; clearResult(); updateControls(); });
$('reviewed').addEventListener('change', refreshDownload); $('download').addEventListener('click', download);
for (const [id, delta] of [['previous', -1], ['next', 1]]) $(id).addEventListener('click', () => { if (!result) return; previewPage = Math.min(result.pages, Math.max(1, previewPage + delta)); showPage().catch(() => { clearResult(); status('Preview failed. Download blocked; prepare the document again.', 'error'); }); });
$('zoom').addEventListener('change', () => showPage().catch(() => { clearResult(); status('Preview failed. Download blocked.', 'error'); }));
window.addEventListener('pagehide', () => { generation++; items = []; clearResult(); for (const task of tasks) task.destroy().catch(() => {}); tasks.clear(); });
try {
  worker = new PDFWorker(); await worker.promise;
  engineReady = true; status('Ready. Your documents will be processed on this device.'); updateControls();
} catch { status('The PDF engine could not load. Use a current Chromium browser, allow this site’s scripts, and reload.', 'error'); }
