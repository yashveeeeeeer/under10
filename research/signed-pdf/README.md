# Signed PDF compression: findings and prototype

Research and local tests: 12 October 2026.

Follow-up: [revocation-data compression and the offline size inspector](revocation-findings.md). The expanded research prototype handles unsigned CRL/OCSP/VRI additions and passed 19 local checks. It is not deployed.

**There is a working method for a limited class of signed PDFs: reduce an unsigned validation-data update after the last signature while preserving the complete signed prefix. There is still no demonstrated way to shrink arbitrary already-signed page content while preserving its original certificate signature.**

The local prototype reduced a deliberately bloated validation-data case from **12,095,873 bytes to 106,814 bytes**. Its original signature passed pyHanko validation and independent OpenSSL content verification before and after. The signed prefix was identical. Every decoded certificate entry remained in the same order. Page pixels were identical in Poppler.

This table records the Python feasibility result, not an estimate of typical savings. The input deliberately repeats the same public certificate 14,000 times in an unsigned update. We have not established how often real filing documents contain reducible unsigned updates. The app now implements a narrower browser profile for certificate-only updates; see the implementation record below. Other signed originals stay unchanged.

## What can actually change

A PDF can contain a signed revision followed by an unsigned update. The signature protects the signed revision's byte ranges, not necessarily everything added later. The standard requires a PAdES signature to cover its entire file revision except the signature value itself. See [ETSI EN 319 142-1 V1.2.1, clause 6.3(k)](https://www.etsi.org/deliver/etsi_en/319100_319199/31914201/01.02.01_60/en_31914201v010201p.pdf).

Our candidate keeps all bytes through the end of the last signed revision at their original offsets. It reconstructs only an eligible unsigned suffix. Repeated certificate streams can share storage, and unsigned stream data can use lossless compression. It preserves the actual certificate bytes after decoding.

That is different from appending a compressed replacement page. An ordinary incremental save retains the original large data, so it grows the file. Our page-replacement experiment also failed the validator's modification-policy check despite passing the signature's cryptographic check.

For this preservation strategy, the end of the last signed byte range is a firm minimum file length. If that is already 10 MB, no amount of unsigned-suffix cleanup can make the result strictly below 10 MB. Removing padding inside the signature placeholder would shift later signed bytes; it is not a general escape from that limit.

## Tools and documentation checked

| Tool or source | What the evidence supports |
| --- | --- |
| [SignNow's compression claim](https://www.signnow.com/esign/pdf-compressor-without-losing-digital-signature) | Explicitly advertises preserving signatures during compression. The page does not provide a verifiable before/after pair or a technical method that demonstrates rewriting already-signed bytes safely. We did not independently establish that capability. No account or paid service was used. |
| [Aspose support discussion](https://forum.aspose.com/t/how-to-reduce-file-size-increased-by-digital-signature/268747) | Support initially suggested optimization after signing. The customer then reported signature-verification errors. The thread records ticket PDFNET-56033 and a later request for escalation. This is not evidence of a working solution; it also is not a claim about every current Aspose version. |
| [Smallpdf's signed-file guidance](https://smallpdf.com/blog/how-to-combine-signed-pdf-files) | Warns against compression and merging when the existing certificate signature must remain valid. A visible signature is a separate issue. |
| [nSoftware Secure PDF: CompressDSS](https://cdn.nsoftware.com/help/EPJ/mac/PDFSign.htm) | Documents compression of data in the Document Security Store. This supports using compressed validation streams; it does not claim that signed page data can be rewritten. We did not test this commercial SDK. |
| [LibPDF incremental saves](https://libpdf.documenso.com/docs/concepts/incremental-saves) | Keeps original bytes when appending allowed changes; its documentation explicitly says incremental updates increase size. A full rewrite invalidates existing signatures. Potential browser implementation component, not a ready-made signed-file compressor. |
| [OCRmyPDF signed-file behavior](https://ocrmypdf.readthedocs.io/en/latest/cookbook.html#digitally-signed-pdfs) | Refuses signed documents by default; the override explicitly invalidates digital signatures. |
| [pyHanko revision analysis](https://docs.pyhanko.eu/en/latest/lib-guide/validation/diff-analysis.html) | Distinguishes cryptographic integrity from whether later revisions are allowed. Used locally with signature coverage and modification analysis enabled. |
| [pikepdf attachment support](https://pikepdf.readthedocs.io/en/latest/topics/attachments.html) | Can store the exact signed original in a compressed attachment. This works for packaging, but the outer PDF is unsigned and is not equivalent to the original signed document. |

ThePDFCompress search excerpts suggested incremental/lossless methods, but the [opened article](https://thepdfcompress.com/blog/how-to-compress-pdf-without-losing-digital-signature) said rewriting signed bytes breaks signatures and appending changes grows the file. Search snippets alone are insufficient evidence.

## Research papers

- Simon Erfurth, [Digital Signatures for Authenticating Compressed JPEG Images](https://eprint.iacr.org/2024/588), 2024 preprint. The proposed signature scheme permits certain JPEG transformations, provided the image was originally signed using that scheme. It does not convert an existing PDF certificate signature into a compression-tolerant one. Assessment here is based on the author's published abstract; the paper PDF fetch returned HTTP 403.
- Mainka, Mladenov and Rohlmann, [Shadow Attacks: Hiding and Replacing Content in Signed PDFs](https://www.ndss-symposium.org/wp-content/uploads/2021-117-paper.pdf), NDSS 2021. Demonstrates the danger of treating an apparently valid signature as proof that the current displayed document is unchanged. This informs our rejection rules; bypassing a viewer's warnings is not a compression technique we will use.

The [PDF Association's signature-validation presentation](https://pdfa.org/wp-content/uploads/2020/07/2020-10-07_PDF-Signature-Validation_comp.pdf) is useful technical background on byte ranges and revision handling. It is not a research paper establishing signed-PDF compression.

## Reproducible results

The existing large fixture contains highly compressible data that was present **before** signing. It was chosen to distinguish compression capability from signature preservation, not to estimate typical compression ratios.

| Method on the 10,107,250-byte signed fixture | Output bytes | Result |
| --- | ---: | --- |
| pypdf lossless stream rewrite | 25,927 | Original CMS signature object retained, but signed-content integrity fails. |
| QPDF through pikepdf, lossless rewrite | 25,472 | Same failure. Preserving the signature object does not preserve its validity. |
| Incremental page-stream recompression | 10,127,909 | Original signature math passes; file grows and modification-policy validation fails. |
| Compressed PDF attachment container | 23,926 | Extracted original is byte-identical and valid. The outer PDF has no signature. Not treated as a successful signed-PDF output. |
| ZIP container | 22,937 | Exact original survives extraction. Output is a ZIP, not the requested PDF. |
| Remove 600 bytes of added whitespace | 10,107,250 | Restores the unchanged original; cannot reduce its signed content. The normal fixture has no removable suffix. |

For the separate unsigned-DSS experiment:

| Check | Result |
| --- | --- |
| Input / output | 12,095,873 / 106,814 bytes |
| Signed prefix | Exactly the original 7,266 bytes |
| Original CMS signature and signed-content SHA-256 | Unchanged |
| Certificate entries | All 14,000 decoded values retained in order |
| Metadata | Latest Info values retained |
| pyHanko | Intact, valid, permitted LTA update; trusted against the explicitly supplied test certificate |
| OpenSSL | CMS content verification passes; certificate-chain trust is deliberately not evaluated by this second check |
| Poppler | Same page pixels before and after |

Seven rejection cases passed: no unsigned update; signed prefix at the limit; signed prefix above the limit; unreachable output size; unsigned page changes; a second unsigned revision; and tampered signed metadata. Ordinary lossless rewrites and incremental page replacement are also asserted to fail the requested combined size/integrity requirement.

The script renders ten documents across the comparison cases and checks identical pixels. Visual equality alone would have missed the broken signatures in the rewrite outputs. The machine-readable evidence is in [results.json](results.json).

## How to run the local lab

This code runs offline after dependencies are installed. It only reads the repository's test fixtures. It is not bundled with the website, and it does not accept client documents or upload anything. Generated PDFs, verification buffers and renders go to ignored `tmp/signed-research/`.

From the repository root, with Python 3.12+ and OpenSSL installed:

```sh
python -m venv tmp/signed-research-env
```

Activate that environment, then:

```sh
python -m pip install -r research/signed-pdf/requirements.txt
python scripts/research-signed-compression.py
```

Install Poppler and put `pdftoppm` on PATH for the pixel comparison. The cryptographic checks require OpenSSL; the script also recognises Git for Windows' bundled executable. Existing local `tmp/qa-python` and `tmp/research-python` dependency directories, if present, take precedence. The tested versions are recorded in the results file.

## Implementation decision

The correct feature is **try safe reduction on eligible signed files**, with an exact size check. It cannot promise every signed file will shrink or fit.

The candidate generator currently handles just one narrow case: one unsigned revision, traditional cross-reference tables, a newly added certificate-only DSS, and direct Info metadata. It rejects document timestamps, prior DSS stores, CRLs, OCSP, VRI dictionaries, object streams, unknown changes, bad signatures and unachievable size targets. Those restrictions are intentional boundaries of the prototype, not claims that the excluded formats can never be supported.

The best browser implementation path is:

1. Parse every revision and discover all signatures, including document timestamps. Require strict parsing; never repair a signed file silently.
2. Verify the signatures and determine the end of all protected bytes. Report certificate trust separately from content integrity; an offline browser cannot silently claim fresh revocation status.
3. Check that all proposed changes are confined to a supported unsigned validation-data suffix. Preserve all pages, fields, annotations, attachments, certificates, revocation data, timestamps and permitted metadata. Unknown objects or ambiguous references mean no transformation.
4. Keep the complete signed prefix unchanged, deduplicate only byte-identical eligible streams, and encode the supported suffix compactly. Never rasterize, merge, remove evidence or re-sign automatically.
5. Reopen the candidate and independently compare every signature, byte range, protected-byte hash, decoded validation-data value and page. Require an identical original signature set and acceptable revision policy. Download only if it is smaller and strictly below the selected limit.

[LibPDF](https://github.com/libpdf-js/core) is an MIT-licensed browser-capable parser/writer candidate. Its [current documentation](https://libpdf.documenso.com/docs) says signature verification is not implemented, so it cannot supply the whole safety check. [PKI.js](https://pkijs.org/docs/examples/other/) offers browser CMS/PDF verification building blocks, but revision-policy validation remains additional work. The implementation now uses PKI.js with a strict subset reader; LibPDF was not added. A free static GitHub Pages frontend remains feasible; a paid compression server does not change the signed-byte restrictions.

The restricted browser implementation now has parser/decompression limits, malformed-file tests, and genuine multiple-signature and timestamp rejection fixtures. General DSS/OCSP/CRL support, independent Acrobat/DSS validation, and an authorised representative corpus remain future work. Those unsupported formats are rejected, not rewritten. MCA upload acceptance has not been tested. No result here establishes legal validity or portal compatibility.

**Current status: the restricted certificate-only implementation is deployed and tested on GitHub Pages. General signed-PDF compression remains unresolved.**

## Browser implementation

The browser port is in `src/signed.js`, with a dedicated terminable worker and PKI.js/WebCrypto integrity checks. The exact eligibility rules and resource bounds are in [TECHNICAL.md](../../TECHNICAL.md#signed-compression-profile). It accepts only the documented certificate-only subset and preserves the signed prefix verbatim. Ordinary page compression, merging, timestamps, certification permissions and multiple signatures remain blocked.

Both Node and the browser produced a 106,820-byte output from the 12,095,873-byte certificate fixture. All 14,000 decoded certificate entries, Info metadata, ID, signature CMS and signed bytes matched. Independent pyHanko validation reported `LTA_UPDATES`, valid cryptographic integrity and permitted modifications; OpenSSL verified the original CMS against the retained signed content. Poppler renders matched pixel for pixel. Certificate trust in the local test uses an explicitly supplied test root, not a claim about real-world trust.

Run `npm run check`, then `python scripts/verify-signed-output.py` with the research Python dependencies, OpenSSL and Poppler installed. `scripts/signed-compression-fixtures.py` regenerates the extra-revision, genuine second-signature and genuine document-timestamp rejection fixtures. No private key is persisted. The committed [browser validation evidence](browser-validation.json) records the independently checked output.

## DSC compatibility check

Eleven additional cases ran against the deployed app at commit `6ca6738`. Three generated RSA/ECDSA certificate-chain cases with eligible certificate-only additions saved just 106 to 115 bytes. Their signed bytes, decoded certificate chains, metadata and rendered pages remained identical. Ordinary fully signed, certified and multiply signed cases remained unchanged; the fully signed file above 10 MB was blocked at that limit.

We also tested the public [eMudhra CPS PDF](https://emudhradigital.com/Downloads/e-Mudhra_CPS.pdf). Its embedded signing certificate is issued by Capricorn. The 1,688,159-byte file remained byte-identical and did not shrink. Independent OpenSSL and pyHanko checks confirmed signature integrity before and after; public certificate trust and current revocation status were not established.

These results do not establish general DSC-signed PDF compression. They confirm the current preservation rules and small savings for supported unsigned certificate additions. See [the verification record and reproduction steps](../../TESTING.md#dsc-compatibility-check) and [machine-readable evidence](dsc-validation.json).
