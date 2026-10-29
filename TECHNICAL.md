# Under10 technical notes

[Back to the short guide](README.md)

A free, browser-only workspace for preparing unsigned PDFs and images under a chosen file-size limit. Built for document preparation around workflows such as MCA filings; independent of MCA.

**Live site:** https://yashveeeeeeer.github.io/under10/

This is not an MCA acceptance checker, signature validator, signing service or legal tool.

## Two workflows

- **Unsigned:** drop PDFs, JPEGs and PNGs; order the files; choose a decimal MB limit from 0.1 to 100; prepare, review every page and download. Native PDF text/vectors are copied first. Colour images use bounded compression. In Options, explicitly choose which unsigned PDFs may be converted to images if the first pass cannot meet the target. Choices start unchecked, with larger files listed first. Other PDFs keep their native text and vectors. Selection applies to every page in the chosen file and does not enable signature or protected-feature bypasses.
- **Signed:** select one PDF and try the validation-record compression profile below. Eligible outputs preserve the signed bytes and decoded records, with CMS integrity checked before and after. Unsupported files remain unchanged and can only be downloaded if they fit. A file fingerprint identifies bytes; it does not validate a signature. Selecting Unsigned never overrides signature detection.

No tool can promise to merge/compress arbitrary digitally signed PDFs into a smaller ordinary PDF while preserving their original signatures. The safe sequence is **prepare unsigned originals → review → sign → recheck size**. A PDF portfolio can retain original files as embedded documents but is not an equivalent merged PDF, and MCA acceptance is not assumed. This app does not generate portfolios.

## Run and test

Node.js 22 or newer:

```sh
npm ci
npm run check
npm start
```

Open the printed local URL. On Windows browser tests use installed Microsoft Edge; on Linux/macOS run `npx playwright install chromium` first. The public app needs no Node.js, Python, account, API key or processing server.

`npm run build` bundles pinned dependencies and emits `docs/`. Libraries and the PDF worker are served from the same site. No CDN runtime dependencies, analytics or third-party fonts. `docs/` is committed so free GitHub Pages can publish directly from `main /docs` without a build service.

## Exact guardrails

| Condition | Behaviour |
| --- | --- |
| Output size | Strictly **less than** the chosen decimal-byte limit. 10 MB = 10,000,000 bytes. Equality fails. |
| Signing headroom | “I’ll sign this PDF later” is visible for unsigned inputs and checked by default. Below it, choose how many signatures the file will carry, from 1 to 10, with 2 selected to start. The app holds back 100,000 bytes for each signature and aims at whichever is lower: the limit minus that reserve, or 98% of the limit. At a 10 MB limit, one or two signatures target 9,800,000 bytes and ten target 9,000,000. Unchecked, the target is 98%. A reserve wider than the limit blocks the run and names the shortfall. The count is hidden in Signed mode, where only the exact chosen limit applies. This cannot guarantee the eventual signed file size. |
| Cannot fit | Stop with no downloadable result. Never omit a page or secretly reduce quality below the configured floor. |
| Existing signature | Inspect decoded PDF objects and conservative raw/historical/escaped-name markers. Signature fields, including blank ones, block the unsigned merge/raster path. Signed mode has the narrow compression profile below, with an unchanged fallback. No cryptographic trust decision is made. |
| Ambiguous/unsupported PDF | Encrypted, damaged or unreadable inputs fail. Forms, annotations, scripts/actions, portfolios and embedded attachments cannot be transformed. |
| Quality | Colour JPEG attempts: 220 DPI / 90%, 190 / 84%, 170 / 78%, 150 / 72%. These are product settings, not an MCA-approved legibility threshold. Low-resolution originals are not made clearer by resampling. |
| Rasterization | Opt-in only, after the ordinary merge cannot fit. Removes searchable/selectable PDF text, tags and bookmarks. No OCR. |
| Page integrity | Every input page stays in file order. Generated output is reopened, counted and rendered page by page before a preview is offered. |
| Review | Visit every output page and confirm readability before download. The acknowledgement cannot prove a human actually inspected the content. |
| Resource bounds | 40 files, 40 MB/file, 100 MB total input, 200 pages. Images ≤32 million pixels and ≤16,000 pixels per side. Render surfaces ≤16 million pixels. |
| Reordering/settings change | Discard the old result. The new configuration must be prepared and reviewed again. |
| Clear/cancel | Invalidate the active job, release file/preview references, destroy document tasks and revoke blob URLs. An active signed-compression worker is terminated. Initial file inspection and unsigned processing still use cooperative cancellation around synchronous parser work. |
| Signed-file compression | Preserve the entire signed prefix. Only reconstruct a supported unsigned validation suffix. If the eligibility, integrity, rendering or size checks fail, no compressed result is offered. An unchanged original can be downloaded only if it fits. |

### Where the per-signature reserve comes from

A signature is appended as an incremental revision, so its cost is a flat number of bytes rather than a share of the document. That is why the reserve counts signatures instead of taking a fixed percentage.

The 100,000-byte figure is a reserve, not a measurement of any particular signing tool. Each added signature revision in this repository’s own multi-signature fixtures costs between 5,648 and 13,750 bytes, the largest being the one carrying CRL and OCSP records. The reserve sits well above that range so a visible signature appearance, a longer certificate chain and the new cross-reference table also fit. A signing tool that attaches a large CRL can still exceed it. The app therefore asks you to check the size again after signing, and never claims the signed file will fit.

## Signed compression profile

`src/signed.js` is a deliberately strict subset reader. It does not repair PDFs. `src/signed.worker.js` runs it in a dedicated worker; an active job is terminated on cancellation or after 30 seconds. The worker is loaded with the page, so processing also works offline. PKI.js 3.4.1 and WebCrypto verify the detached CMS content digest and public-key signature before and after compression. Certificate-chain trust, expiry, revocation and legal validity are not checked.

Eligible inputs have one ordinary approval signature, one simple signature field, traditional xrefs with generation-zero objects and direct stream lengths, and exactly one unsigned update after the signed revision. That update may add a new `/DSS` containing `/Certs`, `/CRLs`, `/OCSPs` and `/VRI`, update the catalog solely to reference it, and update plain `/Info` metadata. Evidence arrays must be direct and nonempty. VRI may be direct or indirect, must identify the one signature by the standard SHA-1 Contents lookup key, and must reference the global evidence arrays. VRI `TU` strings are retained; `TS` tokens are unsupported. The signature must use `adbe.pkcs7.detached` or `ETSI.CAdES.detached` and SHA-256, SHA-384 or SHA-512. Every byte-range boundary is checked against the actual signature contents and signed revision EOF.

The worker checks bounded ASN.1 encodings and certificate/CRL/OCSP schemas, deduplicates byte-identical streams of the same type and applies Flate compression when smaller. It preserves every decoded record in its original array order, all VRI mappings, the latest Info values, document ID, signature contents and every byte through the signed revision. It compares the complete validation graph after reopening. This preserves revocation evidence without making a current revocation or trust decision. It builds only the unsigned suffix, reopens the result with the strict reader, repeats integrity checks, and compares the preserved data. The normal PDF renderer checks page count and renders every page before mandatory user review. No signed content is rasterized, merged or re-signed.

Certification permissions, multiple signatures, document timestamps, an existing signed DSS, unknown validation keys, VRI timestamp tokens, further unsigned revisions, hybrid/xref/object streams, indirect stream lengths, duplicate dictionary keys, unindexed objects, unknown trailer entries, encryption and ambiguous structures are rejected. This limits compatibility deliberately. The original input is never mutated. If the signed prefix itself reaches the chosen limit, this method cannot make it fit.

Additional limits: 16 revisions, 30,000 object entries, nesting below 32, one million parsed values, 20,000 entries per certificate array, 1,000 entries per CRL/OCSP array, 24,000 evidence references and 256 distinct records. Decoded streams are capped at 65,536 bytes per certificate, 4 MB per CRL, 1 MB per OCSP response and 24 MB total. Streaming decompression stops before retaining bytes above the cap. ASN.1 encoding preflight rejects indefinite lengths, nesting of 24 or more and more than 350,000 nodes. The schema parser is also bounded. These limits and the worker deadline are not a formal memory sandbox.

The production revocation fixture shrank from 10,508,164 to 9,379,292 bytes. Its unsigned CRL contains 60,000 distinct serials. This demonstrates the mechanism, not typical savings or licensed DSC compatibility. See the [method and proof](research/signed-pdf/production-revocation.md) and [independent verifier](scripts/verify-revocation-output.py). A fully signed oversized file cannot shrink under this preservation strategy: the app verifies its signature, reports the protected byte count and refuses to transform it. Preparing an unsigned original and signing again creates a new signature; that is not preservation of the existing signature.

## Privacy: precise claims

The app never sends document contents or filenames to a server. It has no document-upload endpoint, persistent document store, cookies, localStorage, sessionStorage, IndexedDB, service worker, telemetry or analytics. Files are held in browser memory for the active session. Saving is a deliberate download action. Page reload starts with an empty workspace.

`connect-src 'none'` blocks fetch/XHR/beacon/WebSocket connections in the page. GitHub Pages does not send CSP response headers for worker scripts; the workers contain no document networking or persistence code. Scripts and worker code load from this site's origin. The host may cache website code and retain ordinary page access logs, including IP addresses. The app cannot control the browser's memory management, swap files, extensions, crash recovery or the user's downloads. It cannot promise forensic erasure or that “nothing is stored anywhere.”

Security headers are included for Cloudflare Pages in `src/_headers`. GitHub Pages does not apply that file: it receives the HTML meta CSP. Header-only protections, including `frame-ancestors`, need a host supporting custom response headers. CSP is defence in depth; it is not a defence against a compromised software supply chain or browser.

## MCA requirements and evidence

Research checked on **12 October 2026**. The quoted LinkedIn post is context, not a technical specification. Public MCA materials describe different scopes:

- [2020 SPICe+ FAQ, question 64](https://www.mca.gov.in/Ministry/pdf/SpicePlusFAQS_20112020.pdf): 6 MB for each PDF form. Historical source, not asserted as today's rule.
- [URC-1 instruction kit](https://www.mca.gov.in/content/dam/mca-aem-forms/instructionkits/Instruction%20Kit_URC-1.pdf): attachments totalling up to 10 MB.
- [RD-1 V3 instruction kit](https://www.mca.gov.in/content/dam/mca-aem-forms/instructionkits/Instruction_Kit_RD-1_v3.pdf): 2 MB per attachment and 10 MB total.
- [Adobe signed PDF restrictions](https://helpx.adobe.com/acrobat/desktop/e-sign-documents/learn-about-signatures/signed-pdf-limitations.html) and [digital signature technical reference](https://www.adobe.com/devnet-docs/acrobatetk/tools/DigSig/Acrobat_DigitalSignatures_in_PDF.pdf): why rewriting a signed file is not a safe compression strategy. The signed compressor preserves the signed revision and rebuilds only a supported unsigned validation update, as specified above.

Direct requests to the MCA incorporation page and 2023 V3 FAQ returned HTTP 403 during research. Relevant indexed official excerpts were available. No authenticated MCA portal was accessed, no legal requirements were changed, and no live filing or acceptance test was performed. Confirm the current limit and whether it is per attachment, per form or aggregate in the actual filing workflow.

## Hosting and free alternatives

**GitHub Pages is suitable for this free personal utility.** There is no backend to scale or pay for. GitHub Free supports Pages on public repositories; visitors' document data is not placed in the repository. Respect the [Pages limits and use restrictions](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits), including its restrictions on commercial SaaS hosting.

For a broader public service, **Cloudflare Pages** can serve the same `docs/` directory, with [custom security headers](https://developers.cloudflare.com/pages/configuration/headers/) and [free static asset requests](https://developers.cloudflare.com/pages/functions/pricing/). A server-based PDF processor is not required. Reliability comes from the parser/compressor, validation corpus, release review and dependency maintenance; paying for a server does not solve signature preservation.

For an immediate existing option on Windows, [PDF24 Creator](https://tools.pdf24.org/en/creator) is free for private and commercial use, supports drag-and-drop assembly/compression and works offline. It saves files locally as a desktop application; it is not the same ephemeral browser design. Its online tools use a different data flow. No recommendation here implies signed files can safely be recompressed.

“Jev” was not identified unambiguously from the request, so no capability or pricing claim is made about it.

## Development plan

1. **Current version:** browser-only merge, bounded compression, exact size gate, limited signed validation-record compression, unchanged-file checks, page review, conservative signature blocks and reproducible regression tests.
2. **Before recommending for sensitive production work:** independent security review; an authorised, sanitised corpus including Indian-script fonts, JPEG2000/JBIG2, rotations/crop boxes, multiple and timestamped signatures, damaged PDFs and large scans; visual comparisons against trusted renderers; browser/low-memory testing; accessibility review; live MCA field confirmation by a filing professional.
3. **Robustness work:** isolate all parsing/merging in a dedicated terminable worker with hard time and memory budgets, tighten PDF feature support, add loss-aware content checks, broaden offline font/CMap support, add performance budgets and fuzzing. Current parsing/merging can temporarily block the main thread; resource caps are not a sandbox against all malicious PDFs.
4. **Release operations:** run checks for each change, review dependency updates, use protected branches and CI, verify built assets match source, retain a rollback commit. `ci/check.yml.example` is a ready-to-install GitHub Actions check; publishing it as a workflow requires appropriate GitHub permissions.

No OCR, signing-key handling, cloud upload, automatic split, document editing, compliance advice or certificate trust validation is in scope.

See [TESTING.md](TESTING.md) for completed checks and limitations. All committed PDF fixtures are synthetic; no client documents or private keys are included.
