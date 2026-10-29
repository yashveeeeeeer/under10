import { PDFWorker, GlobalWorkerOptions, getDocument } from 'pdfjs-dist/build/pdf.mjs';
import { LIMITS, PROFILES, SIGNING, mb, byteLimit, targetBytes, signingReserve, signatureCount, fits, sniff, imageDimensions, inspectPDF, transformIssue, assemble } from './core.js';
import { SignedCompressor } from './signed-client.js';

GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.mjs', import.meta.url).href;
const $ = id => document.getElementById(id);
let items = [], mode = 'build', busy = false, engineReady = false, generation = 0, result = null, previewDoc = null, previewPage = 1, renderTask = null;
let worker;
const signedCompressor = new SignedCompressor();
const tasks = new Set();
const urls = new Set();
const nextTick = () => new Promise(resolve => setTimeout(resolve, 0));
const sizeLabel = bytes => `${Number((bytes / 1_000_000).toFixed(3))} MB`;
function status(text, kind = '') { $('status').textContent = text; $('status').className = `status ${kind}`; }
function checkGeneration(g) { if (g !== generation) throw new Error('Cancelled. Your original files are unchanged.'); }
function setBusy(value) {
  busy = value;
  document.querySelector('.work-grid').setAttribute('aria-busy', String(value));
  for (const id of ['files', 'size-limit', 'reserve', 'signature-count', 'options-open', 'build-mode', 'check-mode']) $(id).disabled = value;
  document.querySelectorAll('#scan-files input').forEach(el => el.disabled = value);
  document.querySelectorAll('.file-actions button').forEach(el => el.disabled = value);
  $('cancel').hidden = !value;
  updateControls();
}
function chosenSignatures() {
  try { return signatureCount($('signature-count').value); } catch { return SIGNING.defaultSignatures; }
}
function updateControls() {
  let limit;
  try { limit = byteLimit($('size-limit').value); } catch { /* Invalid field blocks the action. */ }
  const valid = items.length > 0 && items.every(i => !i.error && i.info);
  const issues = mode === 'build' && items.some(i => i.kind === 'pdf' && i.info && transformIssue(i.info));
  const pages = items.reduce((sum, i) => sum + (i.info?.pages || 0), 0);
  const signing = mode === 'build' && $('reserve').checked;
  const signatures = chosenSignatures();
  $('signature-count-row').hidden = !signing;
  const target = limit && (mode === 'check' ? limit : targetBytes(limit, signing, signatures));
  // A reserve wider than the limit leaves nothing to aim at, so block the run and say why.
  const noRoom = Boolean(limit) && signing && target <= 0;
  $('process').disabled = busy || !engineReady || !limit || !valid || issues || noRoom || pages > LIMITS.pages || (mode === 'check' && (items.length !== 1 || items[0].kind !== 'pdf'));
  $('target').textContent = !limit ? 'Choose a limit' : noRoom ? 'Limit too small' : sizeLabel(target);
  $('target-label').textContent = mode === 'check' ? 'Must be under' : 'Target';
  $('action-hint').textContent = !limit ? `Choose a limit from 0.1 to ${LIMITS.outputMB} MB.` : mode === 'check' ? 'Compression depends on how the PDF was signed.' : noRoom ? `${signatures} signatures need about ${sizeLabel(signingReserve(signatures))} of room. Raise the limit or choose fewer signatures.` : signing ? `We’re aiming for ${sizeLabel(target)} to leave room for ${signatures === 1 ? 'one signature' : `${signatures} signatures`}.` : `We’re aiming for ${sizeLabel(target)} to stay below your ${sizeLabel(limit)} limit.`;
  $('file-count').textContent = `${items.length} ${items.length === 1 ? 'file' : 'files'}${pages ? `, ${pages} ${pages === 1 ? 'page' : 'pages'}` : ''}`;
  $('workspace').classList.toggle('has-files', items.length > 0);
  $('workspace').classList.toggle('has-result', Boolean(result));
  $('choose-label').textContent = items.length ? 'Add files' : 'Choose files';
  const selected = items.filter(i => i.compressScans).length;
  $('options-open').textContent = selected ? `Options (${selected})` : 'Options';
}
function renderScanOptions() {
  const list = $('scan-files'); list.replaceChildren();
  const eligible = items.filter(i => i.kind === 'pdf' && !i.error && i.info && !transformIssue(i.info));
  $('scan-empty').hidden = eligible.length > 0;
  for (const item of eligible.sort((a, b) => b.file.size - a.file.size)) {
    const label = document.createElement('label'); label.className = 'check-row scan-choice';
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = Boolean(item.compressScans); input.disabled = busy;
    input.setAttribute('aria-label', `Compress ${item.file.name}`);
    input.setAttribute('aria-describedby', 'scan-help');
    const body = document.createElement('span'); body.textContent = item.file.name;
    const meta = document.createElement('small'); meta.textContent = `${mb(item.file.size)}, ${item.info.pages} ${item.info.pages === 1 ? 'page' : 'pages'}`;
    body.append(meta); label.append(input, body); list.append(label);
    input.addEventListener('change', () => {
      item.compressScans = input.checked;
      generation++; clearResult(); updateControls();
      status('Compression choice updated. Prepare again to apply it.');
    });
  }
}
function renderList() {
  const list = $('file-list'); list.replaceChildren();
  items.forEach((item, index) => {
    const row = document.createElement('div'); row.className = 'file-row';
    const icon = document.createElement('span'); icon.className = 'file-icon'; icon.textContent = (item.kind || '?').toUpperCase();
    const body = document.createElement('div');
    const name = document.createElement('p'); name.className = 'file-name'; name.textContent = item.file.name;
    const meta = document.createElement('p'); meta.className = 'file-meta';
    meta.textContent = `${mb(item.file.size)}${item.info ? `, ${item.info.pages} ${item.info.pages === 1 ? 'page' : 'pages'}` : ''}${item.info?.signature ? ', signature marker or field' : ''}`;
    body.append(name, meta);
    const issue = item.error || (mode === 'build' && item.info && item.kind === 'pdf' && transformIssue(item.info));
    if (issue) { const p = document.createElement('p'); p.className = 'file-issue'; p.textContent = issue; body.append(p); }
    const actions = document.createElement('div'); actions.className = 'file-actions';
    for (const [label, symbol, move, disabled] of [['Move up', '↑', -1, index === 0], ['Move down', '↓', 1, index === items.length - 1], ['Remove', '×', 0, false]]) {
      const button = document.createElement('button'); button.className = 'small-button'; button.textContent = symbol; button.setAttribute('aria-label', `${label} ${item.file.name}`); button.disabled = busy || disabled;
      button.addEventListener('click', () => { clearResult(); if (move) [items[index], items[index + move]] = [items[index + move], items[index]]; else items.splice(index, 1); renderList(); status('Files updated. Prepare again to use this order.'); });
      actions.append(button);
    }
    row.append(icon, body, actions); list.append(row);
  });
  renderScanOptions(); updateControls();
}
async function loadPDF(bytes) {
  const task = getDocument({ data: bytes.slice(), worker, isEvalSupported: false, useWasm: false, useSystemFonts: true, disableFontFace: true, stopAtErrors: true, maxImageSize: LIMITS.imagePixels, verbosity: 0 });
  tasks.add(task);
  try { const doc = await task.promise; return { doc, release: async () => { tasks.delete(task); await task.destroy(); } }; }
  catch (e) { tasks.delete(task); await task.destroy().catch(() => {}); throw e; }
}
async function clearResult() {
  previewSerial++;
  result = null;
  $('workspace').classList.remove('has-result');
  $('file-details-dialog').close();
  $('result').close();
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
  signedCompressor.cancel();
  setBusy(true);
  items = [];
  $('files').value = '';
  await clearResult();
  await Promise.allSettled([...tasks].map(t => t.destroy())); tasks.clear();
  setBusy(false); renderList(); status('Session cleared.');
}
function setMode(next) {
  if (busy) return;
  mode = next; generation++; clearResult();
  const check = mode === 'check';
  $('build-mode').setAttribute('aria-pressed', String(!check)); $('check-mode').setAttribute('aria-pressed', String(check));
  $('input-title').textContent = check ? 'Original PDF' : 'Files';
  $('input-help').hidden = !check;
  $('formats').textContent = check ? 'One PDF, up to 40 MB' : 'PDF, JPG or PNG';
  $('files').accept = check ? '.pdf,application/pdf' : '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png';
  $('files').multiple = !check;
  $('files').setAttribute('aria-label', check ? 'Choose one PDF' : 'Choose PDFs and images');
  $('build-settings').hidden = check;
  $('signing-option').hidden = check;
  $('settings-title').textContent = 'PDF settings';
  $('process').textContent = 'Prepare PDF →';
  renderList();
  status(check ? 'Choose one signed PDF.' : 'Choose files to begin.');
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
      const item = { file, compressScans: false };
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
    status(count > LIMITS.pages ? 'Over 200 pages. Remove files to continue.' : mode === 'check' && items.length !== 1 ? 'Choose one PDF at a time. Remove the extra files to continue.' : blocked ? 'Check the messages beside your files.' : mode === 'check' ? 'Ready to check.' : 'Ready to prepare.', blocked || count > LIMITS.pages ? 'error' : '');
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
      checkGeneration(g); status(`Compressing PDF page ${i} of ${source.doc.numPages} at ${profile.dpi} DPI`);
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
    let bytes, detail, warning, signedCompression = false, unchanged = mode === 'check';
    const pages = items.reduce((n, i) => n + i.info.pages, 0);
    if (unchanged) {
      bytes = new Uint8Array(await items[0].file.arrayBuffer());
      checkGeneration(g);
      let reason = 'No signature markers detected.';
      if (items[0].info.signature) {
        try {
          const compact = await signedCompressor.run(bytes, limit, text => { if (g === generation) status(text); });
          checkGeneration(g); bytes = compact.bytes; unchanged = false; signedCompression = true;
          await validateRendering(bytes, pages, g);
          detail = `${pages} ${pages === 1 ? 'page' : 'pages'} (${bytes.length.toLocaleString()} bytes). Saved ${mb(compact.saved)} by compressing validation records added after signing. All ${compact.signedBytes.toLocaleString()} bytes through the signed revision are identical to the original. Certificates, revocation records and their signature links are retained.`;
          warning = 'Signature integrity checked. Certificate trust, expiry and revocation have not been verified.';
        } catch (e) { checkGeneration(g); if (signedCompression) throw e; reason = e.message; }
      }
      if (unchanged) {
        if (!fits(bytes.length, limit)) throw new Error(`This original is ${mb(bytes.length)}, so it is not strictly below ${mb(limit)}. It was not changed. ${reason}`);
        detail = `${pages} ${pages === 1 ? 'page' : 'pages'} (${bytes.length.toLocaleString()} bytes). Original unchanged. ${reason}`;
        warning = `${reason} Original unchanged; signature validity and trust have not been verified.`;
      }
    } else {
      const target = targetBytes(limit, $('reserve').checked, chosenSignatures());
      const selected = items.filter(i => i.kind === 'pdf' && i.compressScans);
      let used, raster = false;
      const run = async (profile, scans) => {
        checkGeneration(g); status(`Preparing ${scans ? 'scanned pages' : 'files'} with ${profile.dpi} DPI images…`); await nextTick();
        return assemble(items.map(i => ({ ...i, raster: scans && i.kind === 'pdf' && i.compressScans })), (item, accept) => imagePages(item, profile, accept, g), text => status(text), () => checkGeneration(g));
      };
      for (const profile of PROFILES) {
        bytes = await run(profile, false); used = profile;
        if (bytes.length <= target) break;
        if (items.every(i => i.kind === 'pdf')) break;
      }
      if (bytes.length > target && selected.length) {
        raster = true;
        for (const profile of PROFILES) { bytes = await run(profile, true); used = profile; if (bytes.length <= target) break; }
      }
      if (bytes.length > target || !fits(bytes.length, limit)) throw new Error(`Cannot meet the ${sizeLabel(target)} target at the available quality settings. ${!selected.length && items.some(i => i.kind === 'pdf') ? 'Choose scanned PDFs for compression in Options, or use smaller source images.' : 'Use smaller source images or a higher size limit if your upload form allows it.'}`);
      await validateRendering(bytes, pages, g);
      detail = `${pages} ${pages === 1 ? 'page' : 'pages'} (${bytes.length.toLocaleString()} bytes). ${raster ? `Pages in ${selected.length} selected PDF ${selected.length === 1 ? 'file' : 'files'} converted to colour images. Text and vectors in other PDFs retained` : 'PDF text and vectors retained'}.${raster || items.some(i => i.kind !== 'pdf') ? ` Images use ${used.dpi} DPI and ${Math.round(used.quality * 100)}% JPEG quality.` : ''}`;
      warning = `${raster ? 'Scan compression removed selectable text from the selected PDFs. ' : ''}Document-level bookmarks, tags and metadata are not retained.${$('reserve').checked ? ` Room was reserved for ${chosenSignatures() === 1 ? 'one signature' : `${chosenSignatures()} signatures`}. Check the file size again after signing.` : ''}`;
    }
    checkGeneration(g);
    const hashBytes = await crypto.subtle.digest('SHA-256', bytes); checkGeneration(g);
    result = { bytes, limit, pages, unchanged, hash: Array.from(new Uint8Array(hashBytes), b => b.toString(16).padStart(2, '0')).join(''), name: unchanged ? items[0].file.name : signedCompression ? 'compressed-signed-document.pdf' : 'prepared-document.pdf', visited: new Set() };
    $('result-title').textContent = unchanged ? 'The original fits.' : 'Review your PDF';
    $('result-kicker').textContent = unchanged ? 'SIZE CHECK' : 'PREPARED';
    $('result-size').textContent = mb(bytes.length); $('result-detail').textContent = detail; $('result-warning').textContent = warning; $('hash').textContent = result.hash;
    $('preview-area').hidden = unchanged; $('review-row').hidden = unchanged; $('download').textContent = unchanged ? 'Download unchanged original ↓' : 'Download PDF ↓';
    $('result').classList.toggle('original', unchanged);
    $('result').hidden = false;
    $('result').showModal();
    if (!unchanged) { previewDoc = await loadPDF(bytes); checkGeneration(g); previewPage = 1; $('zoom').value = '1'; await showPage(g); }
    refreshDownload();
    status(unchanged ? 'Size check passed. Original unchanged.' : 'Size and page count checked. Review before downloading.', 'success');
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
  const style = getComputedStyle(container);
  const available = Math.max(1, container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
  const availableHeight = Math.max(1, container.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom));
  const fitScale = Math.min(1.5, available / base.width, availableHeight / base.height);
  const zoom = Number($('zoom').value);
  const desiredScale = zoom === 1 ? fitScale : zoom;
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
  $('download-note').textContent = !result ? '' : result.unchanged ? 'Original file, unchanged.' : ready ? 'Ready to save.' : `${result.visited.size} of ${result.pages} pages opened. Review all, then confirm.`;
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
$('privacy-link').addEventListener('click', () => { $('privacy').open = true; $('help-dialog').showModal(); });
$('help-close').addEventListener('click', () => $('help-dialog').close());
$('options-open').addEventListener('click', () => $('options-dialog').showModal());
$('options-close').addEventListener('click', () => $('options-dialog').close());
$('back-to-files').addEventListener('click', () => $('result').close());
$('details-open').addEventListener('click', () => $('file-details-dialog').showModal());
$('details-close').addEventListener('click', () => $('file-details-dialog').close());
for (const id of ['size-limit', 'reserve', 'signature-count']) $(id).addEventListener('input', () => { generation++; clearResult(); updateControls(); });
$('reviewed').addEventListener('change', refreshDownload); $('download').addEventListener('click', download);
for (const [id, delta] of [['previous', -1], ['next', 1]]) $(id).addEventListener('click', () => { if (!result) return; previewPage = Math.min(result.pages, Math.max(1, previewPage + delta)); showPage().catch(() => { clearResult(); status('Preview failed. Download blocked; prepare the document again.', 'error'); }); });
$('zoom').addEventListener('change', () => showPage().catch(() => { clearResult(); status('Preview failed. Download blocked.', 'error'); }));
let resizeTimer, previewSize = '';
new ResizeObserver(([entry]) => {
  const width = Math.round(entry.contentRect.width), height = Math.round(entry.contentRect.height);
  const size = `${width}x${height}`;
  if (size === previewSize) return;
  previewSize = size;
  clearTimeout(resizeTimer);
  if (width > 0 && height > 0 && previewDoc && result && $('result').open && !busy) resizeTimer = setTimeout(() => {
    showPage().catch(() => { clearResult(); status('Preview failed. Download blocked.', 'error'); });
  }, 100);
}).observe(document.querySelector('.canvas-wrap'));
function fitScreen() {
  const textSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
  document.body.classList.toggle('cramped', innerHeight / textSize < 32);
  const fixedHeight = document.querySelector('.workspace-head').offsetHeight + document.querySelector('.action-bar').offsetHeight;
  $('workspace').classList.toggle('needs-scroll', fixedHeight + 44 > $('workspace').clientHeight);
}
const screenObserver = new ResizeObserver(fitScreen);
screenObserver.observe(document.querySelector('.topbar'));
screenObserver.observe(document.querySelector('.action-bar'));
window.addEventListener('resize', fitScreen);
fitScreen();
window.addEventListener('pagehide', () => { generation++; signedCompressor.cancel('Session closed.', false); items = []; clearResult(); for (const task of tasks) task.destroy().catch(() => {}); tasks.clear(); });
window.addEventListener('pageshow', event => { if (event.persisted) { signedCompressor.start(); renderList(); status('Ready.', 'idle'); } });
try {
  worker = new PDFWorker(); await worker.promise;
  await signedCompressor.ready;
  engineReady = true; status('Ready.', 'idle'); updateControls();
} catch { status('The PDF engine could not load. Use a current Chromium browser, allow this site’s scripts, and reload.', 'error'); }
