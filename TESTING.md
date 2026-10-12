# Verification record

Test date: 12 October 2026. Environment: Windows, Node.js 24.14.0, Microsoft Edge via Playwright 1.64.0. All document fixtures are synthetic.

## Automated checks

- 17 core tests: strict decimal-byte boundary; invalid limits; file magic; malformed/oversized image headers; static PDF parsing; signature dictionaries in ordinary and compressed object streams; blank fields; escaped historical markers; forms; actions; attachments; annotations; corrupt/truncated/encrypted PDFs; page count/order; signed merge refusal; 200-page cap.
- 37 browser scenarios: responsive layout and keyboard skip link; actual output page count/order/selectable text; all-page review gate; marker-based signature protection and SHA-256 equality; genuinely signed synthetic PDFs, including one over 10 MB; an actually encrypted PDF; offline mixed-image/PDF preparation; absence of document network requests and storage writes; hostile filenames; invalid files; protected PDF features; chosen limits above and below 10 MB; signing intent and invalidation after settings changes; opt-in rasterization; impossible targets; cancellation and recovery.
- Generated a test-only RSA certificate and signed PDF with pyHanko 0.37.0. Confirmed signature integrity, cryptographic validity and trust against the explicitly supplied synthetic test root. Downloaded through check mode and confirmed byte equality and the same cryptographic results independently with pyHanko. This does not establish real-world certificate trust.
- Reopened exported PDFs with pdf-lib and independently rendered with Poppler. Inspected the desktop, mobile and result screenshots plus rendered output for clipping and missing text.
- Production dependency audit: zero reported vulnerabilities at test time. This is not a comprehensive security audit.
- Live GitHub Pages smoke test: HTTP 200; assets load correctly under `/under10/`; signed input is blocked from merging; unchanged download is byte-identical; unsigned preparation works; zero document-time network requests and zero JavaScript page errors. Reproduce with `node scripts/smoke-live.mjs https://yashveeeeeeer.github.io/under10/`.

`npm run check` runs the reproducible Node and browser suite. Committed synthetic signed/encrypted fixtures remove Python from the normal test dependency chain. `scripts/signed-fixture.py` documents generation; its private test key is generated in process memory and is never written to disk.

## Focused signed-PDF recheck

Three signature-focused browser tests passed. Scan compression remained blocked for a genuinely signed PDF, including when mixed with an unsigned PDF. Already signed mode returned an eligible original byte for byte. A second genuinely signed fixture of 10,107,250 bytes was blocked at a 10 MB limit, returned unchanged at a 12 MB limit, and remained blocked from compression when switching to Unsigned. Its signature was independently verified before testing. The large fixture is stored as gzip in the test repository and restored to ordinary PDF bytes before the browser test; gzip is not offered as a PDF compression feature.

Run `npx playwright test --grep 'signature|signed'` to repeat these checks.

## Responsive layout

The full suite passed after the screen-fitting layout and signing-choice changes: 17 core tests and 37 browser scenarios. Layout checks cover widths from 320 to 2560 CSS pixels, enlarged text at 200%, long filenames, and preview resizing between portrait and landscape. An emulated touch workflow chooses two files through the picker, reorders them, prepares the PDF, reviews both pages and downloads a verified two-page output. Phone and desktop screenshots were inspected for clipping and overlap. These are automated browser checks, not tests on physical phones.

The workspace and review controls fit viewport sizes from 320 by 480 to 2560 by 1440, including phone landscape. File lists and zoomed previews scroll within their own panels. Help, options and file details use dialogs with Escape handling and focus restoration. Enlarged text and shortened viewports keep controls reachable. Fit page uses both dimensions; 150% and 200% use explicit magnification.

The signing option updates the target at 3, 10 and 25 MB, invalidates an earlier result when changed, and disappears for already signed files. Its state is restored when returning to Unsigned. Core checks cover the strict byte boundary above 10 MB and the 100 MB maximum. Existing file, page and image resource caps are unchanged.

## Explicit limits

- No production MCA submissions or authenticated portal tests.
- No certification of signature-detection completeness, certificate trust, revocation or legal validity.
- No guarantee that 150 DPI / 72% JPEG is readable for every source. User inspection is mandatory.
- Browser verification is Microsoft Edge (Chromium) on Windows, including mobile viewport and touch emulation. Actual iOS/Android devices, Firefox and Safari are not yet validated.
- No full accessibility audit, adversarial PDF fuzzing, large-corpus fidelity validation or independent penetration test.
- Some PDF features/codecs/fonts are deliberately unsupported. A failed parse or render blocks output; successful rendering alone cannot prove every glyph or visual detail is faithful.
- Browser/OS memory reclamation and secure erasure are outside application control. The app does not deliberately persist document data.
- Resource caps limit ordinary work; all malicious memory/CPU exhaustion patterns are not solved. Synchronous pdf-lib operations use the main thread and are not immediately interruptible.

## Release gate

Run `npm ci`, `npm run check`, and `npm audit`. Review source and `docs/` together. Publish only static assets and synthetic tests. Do not attach client documents to GitHub issues or test reports. After deployment, verify asset loading under the repository path and the unchanged signature workflow using the synthetic fixture.

The GitHub Actions CI file is supplied as a template rather than installed: the authenticated publishing credential has repository permission but does not have the `workflow` scope. Current publication uses GitHub Pages' built-in `main /docs` deployment. Local checks and the deployed-site smoke test were run; future pushes are not automatically gated by the template until it is installed as `.github/workflows/check.yml` with suitable permissions.
