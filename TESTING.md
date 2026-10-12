# Verification record

Test date: 12 October 2026. Environment: Windows, Node.js 24.14.0, Microsoft Edge via Playwright 1.64.0. All document fixtures are synthetic.

## Automated checks

- 17 core tests: strict decimal-byte boundary; invalid limits; file magic; malformed/oversized image headers; static PDF parsing; signature dictionaries in ordinary and compressed object streams; blank fields; escaped historical markers; forms; actions; attachments; annotations; corrupt/truncated/encrypted PDFs; page count/order; signed merge refusal; 200-page cap.
- 11 browser scenarios: desktop/mobile layout and keyboard skip link; actual output page count/order/selectable text; all-page review gate; marker-based signature protection and SHA-256 equality; a genuinely signed synthetic PDF; an actually encrypted PDF; offline mixed-image/PDF preparation; absence of document network requests and storage writes; hostile filenames; invalid files; protected PDF features; over-limit checks; invalidation after settings changes; opt-in rasterization; impossible targets; cancellation and recovery.
- Generated a test-only RSA certificate and signed PDF with pyHanko 0.37.0. Confirmed signature integrity, cryptographic validity and trust against the explicitly supplied synthetic test root. Downloaded through check mode and confirmed byte equality and the same cryptographic results independently with pyHanko. This does not establish real-world certificate trust.
- Reopened exported PDFs with pdf-lib and independently rendered with Poppler. Inspected the desktop, mobile and result screenshots plus rendered output for clipping and missing text.
- Production dependency audit: zero reported vulnerabilities at test time. This is not a comprehensive security audit.

`npm run check` runs the reproducible Node and browser suite. Committed synthetic signed/encrypted fixtures remove Python from the normal test dependency chain. `scripts/signed-fixture.py` documents generation; its private test key is generated in process memory and is never written to disk.

## Explicit limits

- No production MCA submissions or authenticated portal tests.
- No certification of signature-detection completeness, certificate trust, revocation or legal validity.
- No guarantee that 150 DPI / 72% JPEG is readable for every source. User inspection is mandatory.
- Initial browser verification is Microsoft Edge (Chromium) on Windows, including a mobile viewport. Actual iOS/Android devices, Firefox and Safari are not yet validated.
- No full accessibility audit, adversarial PDF fuzzing, large-corpus fidelity validation or independent penetration test.
- Some PDF features/codecs/fonts are deliberately unsupported. A failed parse or render blocks output; successful rendering alone cannot prove every glyph or visual detail is faithful.
- Browser/OS memory reclamation and secure erasure are outside application control. The app does not deliberately persist document data.
- Resource caps limit ordinary work; all malicious memory/CPU exhaustion patterns are not solved. Synchronous pdf-lib operations use the main thread and are not immediately interruptible.

## Release gate

Run `npm ci`, `npm run check`, and `npm audit`. Review source and `docs/` together. Publish only static assets and synthetic tests. Do not attach client documents to GitHub issues or test reports. After deployment, verify asset loading under the repository path and the unchanged signature workflow using the synthetic fixture.
