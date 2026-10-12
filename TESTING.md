# Verification record

Test date: 12 October 2026. Environment: Windows, Node.js 24.14.0, Microsoft Edge via Playwright 1.64.0. The standard suite uses synthetic fixtures. The separate DSC check below also uses one public signed document.

## Automated checks

- 17 unsigned/core tests: strict decimal-byte boundary; invalid limits; file magic; malformed/oversized image headers; static PDF parsing; signature dictionaries in ordinary and compressed object streams; blank fields; escaped historical markers; forms; actions; attachments; annotations; corrupt/truncated/encrypted PDFs; page count/order; signed merge refusal; 200-page cap.
- 44 browser scenarios: responsive layout and keyboard skip link; actual output page count/order/selectable text; all-page review gate; marker-based signature protection and SHA-256 equality; genuinely signed synthetic PDFs, including one over 10 MB; an actually encrypted PDF; offline mixed-image/PDF preparation; absence of document network requests and storage writes; hostile filenames; invalid files; protected PDF features; chosen limits above and below 10 MB; signing intent and invalidation after settings changes; opt-in rasterization; impossible targets; cancellation and recovery.
- Generated a test-only RSA certificate and signed PDF with pyHanko 0.37.0. Confirmed signature integrity, cryptographic validity and trust against the explicitly supplied synthetic test root. Downloaded through check mode and confirmed byte equality and the same cryptographic results independently with pyHanko. This does not establish real-world certificate trust.
- Reopened exported PDFs with pdf-lib and independently rendered with Poppler. Inspected the desktop, mobile and result screenshots plus rendered output for clipping and missing text.
- Production dependency audit: zero reported vulnerabilities at test time. This is not a comprehensive security audit.
- Live GitHub Pages smoke test: HTTP 200; assets load correctly under `/under10/`; signed input is blocked from merging; unchanged download is byte-identical; unsigned preparation works; zero document-time network requests and zero JavaScript page errors. Reproduce with `node scripts/smoke-live.mjs https://yashveeeeeeer.github.io/under10/`.

`npm run check` runs the reproducible Node and browser suite. Committed synthetic signed/encrypted fixtures remove Python from the normal test dependency chain. `scripts/signed-fixture.py` documents generation; its private test key is generated in process memory and is never written to disk.

## Earlier signed-file guardrail check

Three signature-focused browser tests passed. Scan compression remained blocked for a genuinely signed PDF, including when mixed with an unsigned PDF. Signed mode returned an eligible original byte for byte. A second genuinely signed fixture of 10,107,250 bytes was blocked at a 10 MB limit, returned unchanged at a 12 MB limit, and remained blocked from compression when switching to Unsigned. Its signature was independently verified before testing. The large fixture is stored as gzip in the test repository and restored to ordinary PDF bytes before the browser test; gzip is not offered as a PDF compression feature.

Run `npx playwright test --grep 'signature|signed'` to repeat these checks.

## Signed compression implementation

Twenty additional Node cases cover the eligible certificate suffix, preservation of all decoded certificates and metadata, the strict output byte boundary, fully signed/oversized prefixes, tampered signed content, catalog changes, duplicate dictionary keys, extra DSS fields, page/object updates, invalid certificates, unindexed content, malformed xrefs, unsupported permission/timestamp structures, repeated compression, resource bounds, oversized certificate decompression, and independently generated multiple-signature/timestamp/extra-revision fixtures.

Seven new browser scenarios cover actual signed compression and download offline, zero document-time requests/storage writes, preserved signed prefix, the review gate, compression when the original already fits, a tampered signature, an impossible target, cancellation with recovery, keyboard selection, and the result on a phone-sized viewport.

The exaggerated certificate fixture is 12,095,873 bytes before and 106,820 after. This is not representative savings. Both the actual Node output and browser download were independently checked with pyHanko and OpenSSL. Signed bytes and CMS hashes, all 14,000 certificate entries, Info and ID matched. pyHanko classified the update as `LTA_UPDATES`, with integrity and modification-policy checks passing against the explicit test root. Poppler page pixels matched exactly. Reproduce with `python scripts/verify-signed-output.py` after the standard checks; this independent check additionally needs the research Python dependencies, OpenSSL and Poppler.

A strict subset parser rejects unsupported structure rather than repairing it. This is not a general PAdES validator or proof of acceptance by Acrobat, DSS or MCA. OCSP/CRL/VRI, multiple signatures, document timestamps and certification permissions are deliberately outside the compression profile. Their presence prevents compression. No certificate trust, expiry or fresh revocation check is claimed by the app.

## DSC compatibility check

Eleven additional cases passed against the live app at commit `6ca6738`, with the browser offline after loading the app. This separate lab does not change the standard suite's 81-check count. Ten generated files exercise RSA-2048 CMS, RSA-3072 PAdES and ECDSA P-256 PAdES signatures with a three-certificate test chain, plus certification, multiple signatures, an extra XMP update and an oversized signed document. Private test keys exist only in memory.

| Case | Result |
| --- | --- |
| RSA-2048 with eligible unsigned certificates | 18,325 to 18,210 bytes; 115 bytes saved |
| RSA-3072 with eligible unsigned certificates | 19,184 to 19,078 bytes; 106 bytes saved |
| ECDSA P-256 with eligible unsigned certificates | 17,899 to 17,786 bytes; 113 bytes saved |
| Six other generated files under the limit | Byte-identical originals |
| Fully signed 10,115,017-byte file | Blocked at the 10 MB limit |
| Public Capricorn-issued DSC in the [eMudhra CPS PDF](https://emudhradigital.com/Downloads/e-Mudhra_CPS.pdf) | All 1,688,159 bytes unchanged; no compression |

OpenSSL and pyHanko independently checked every input signature and every downloaded output, including both signatures in the multiple-signature case. All cryptographic integrity checks passed. Compressed outputs retained identical signed prefixes, CMS values, decoded certificates, Info and ID metadata, and Poppler page pixels. The browser recorded zero document-time requests, attempted localStorage/IndexedDB writes or JavaScript errors. Renders were also inspected visually.

The generated certificates are not licensed DSCs. Their chains validate only against the explicitly supplied test root. The public sample's certificate issuer was inspected, but its public trust chain, current revocation status, USB token workflows and MCA submission were not tested. Ordinary fully signed PDFs did not shrink. Machine-readable results are in [dsc-validation.json](research/signed-pdf/dsc-validation.json); the third-party PDF is not committed.

To reproduce, install the Node dependencies and, in a Python environment, `pip install -r research/signed-pdf/dsc-requirements.txt`. OpenSSL and Poppler's `pdftoppm` must be available. Run from the repository root:

```sh
python scripts/dsc-fixtures.py
```

Optionally download the linked public CPS file to `tmp/qa/dsc/emudhra-public-cps.pdf`. Then run:

```sh
node scripts/test-dsc-live.mjs https://yashveeeeeeer.github.io/under10/
python scripts/verify-dsc-results.py
```

Without the optional public sample there are ten cases. Generated files and verification buffers stay in ignored `tmp/qa/dsc/`. Certificate keys and timestamps change on regeneration, so byte counts can vary. The live site and public sample may also change; the committed report records the tested URL and output hashes.

Additional research, separate from the production suite: the [revocation-data lab](research/signed-pdf/revocation-findings.md) passed three compression cases, ten rejection cases and six offline size diagnoses. One generated signed file with a large unsigned CRL shrank from 10,508,159 to 9,378,697 bytes. The original signatures, decoded validation records and page pixels were preserved. This is an offline prototype, not production support for CRL/OCSP/VRI or multiple-signature compression.

## Responsive layout

The full suite passed after the screen-fitting layout and signing-choice changes: 37 Node tests and 44 browser scenarios. Layout checks cover widths from 320 to 2560 CSS pixels, enlarged text at 200%, long filenames, and preview resizing between portrait and landscape. An emulated touch workflow chooses two files through the picker, reorders them, prepares the PDF, reviews both pages and downloads a verified two-page output. Phone and desktop screenshots were inspected for clipping and overlap. These are automated browser checks, not tests on physical phones.

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

Run `npm ci`, `npm run check`, and `npm audit`. Review source and `docs/` together. Publish only static assets and synthetic tests. Do not attach client documents to GitHub issues or test reports. After deployment, verify asset loading under the repository path and both the unchanged signature and eligible signed-compression workflows using the synthetic fixture.

The GitHub Actions CI file is supplied as a template rather than installed: the authenticated publishing credential has repository permission but does not have the `workflow` scope. Current publication uses GitHub Pages' built-in `main /docs` deployment. Local checks and the deployed-site smoke test were run; future pushes are not automatically gated by the template until it is installed as `.github/workflows/check.yml` with suitable permissions.
