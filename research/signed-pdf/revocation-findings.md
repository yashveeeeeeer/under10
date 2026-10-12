# DSC compression: the next method

Research and local experiments, 12 October 2026.

**An expanded prototype reduced a generated signed PDF from 10,508,159 bytes to 9,378,697 bytes, preserving the original signature.** It compressed a large unsigned revocation-data update. It did not compress the signed pages. This is a working research result, not a feature deployed on the website or proof that ordinary DSC-signed files can all shrink.

## What was built and measured

The existing app handles certificate-only additions. The new offline prototype also handles certificate revocation lists (CRLs), OCSP responses and validation-related information (VRI) added after signing. It preserves every decoded record, array entry and signature reference. These are established PDF validation structures, described in [ETSI EN 319 142-1, section 5.4.2](https://www.etsi.org/deliver/etsi_en/319100_319199/31914201/01.02.01_60/en_31914201v010201p.pdf). The [nSoftware SDK documentation](https://cdn.nsoftware.com/help/EPJ/mac/PDFSign.htm) also documents DSS compression; that commercial SDK was not used or tested here.

| Generated case | Before | After | Saved |
| --- | ---: | ---: | ---: |
| One RSA signature, large unsigned CRL, OCSP and VRI | 10,508,159 | 9,378,697 | 1,129,462 bytes |
| One RSA signature, small OCSP and VRI update | 19,989 | 19,921 | 68 bytes |
| RSA and ECDSA signatures, then unsigned CRL, OCSP and VRI | 1,321,701 | 192,259 | 1,129,442 bytes |

The large CRL contains 60,000 distinct generated revoked serial numbers and occupies 1,287,530 bytes before stream compression. It is not 14,000 repetitions of the same certificate, as in the earlier experiment. However, it is deliberately constructed and does not establish typical savings or how often licensed DSC workflows leave such an update unsigned. The first case also deliberately contains 9.2 MB of padding signed as part of its page stream. Those bytes remain untouched, despite being highly compressible. Its preserved signed prefix alone is 9,214,497 bytes.

For every successful candidate:

- OpenSSL verified each original CMS signature against the retained signed content.
- pyHanko checked signature integrity, revision coverage and permitted modifications. Both signatures in the multiple-signature case passed.
- A second pyHanko check required revocation evidence against the generated test root, using the output's embedded evidence and no network fetching. It passed.
- Original byte ranges, CMS values, signed-byte hashes, decoded DSS records, VRI relationships, Info and ID matched.
- Poppler rendered every page before and after. Pixels matched, and the rendered pages were inspected.

Ten rejection checks passed: no unsigned update, target at the protected prefix boundary, a protected prefix already above 10 MB, tampered signed content, unsigned page rotation, an unknown DSS field, extra unsigned revisions, a document timestamp, an already compact result, and revocation data subsequently covered by another signature. Six additional size diagnoses passed. All **19 research checks** passed. These are separate from the website's standard 81-check suite.

Code: [revocation prototype](../../scripts/research-dsc-revocation.py), [offline size inspector](../../scripts/inspect-signed-budget.py). Evidence: [revocation-validation.json](revocation-validation.json).

## What further research supports

| Approach | Finding for an existing DSC-signed PDF |
| --- | --- |
| Compress unsigned validation records | Demonstrated above. A promising extension to the current app when this data exists outside all signatures. |
| Recompress pages or images with Flate, JPEG or Brotli | Changes the bytes protected by the existing signature. A newer codec does not change that requirement. The [PDF Association's Brotli discussion](https://pdfa.org/brotli-compression-coming-to-pdf/) also explains reader compatibility costs. |
| Trim the signature placeholder | Changing its length shifts subsequent bytes. `/ByteRange` itself is signed, so updating those offsets changes protected data. See [pyHanko's signing documentation](https://docs.pyhanko.eu/en/latest/lib-guide/signing.html). Fixed-length placeholder edits do not reduce file size. |
| ZIP, PDF attachments or CMS CompressedData | Can preserve an original for later extraction. [RFC 3274](https://www.rfc-editor.org/rfc/rfc3274.html) defines a compressed CMS content type, not a replacement for a PDF signature. Such a package is not the smaller standalone signed PDF requested here; the earlier lab already demonstrated the packaging distinction. |
| Compression-tolerant signatures | [Erfurth's JPEG signature research](https://eprint.iacr.org/2024/588) proposes a special original signing scheme. Its published abstract requires constrained JPEG quantization. This does not retrofit an ordinary PDF's existing DSC signature. The paper PDF could not be opened by the browsing tool; this assessment is limited to the published abstract and indexed text. |
| Sanitizable signatures | [Ahmad, Rass and Seyedi's 2026 preprint](https://arxiv.org/abs/2602.20657) describes a new scheme with a designated party's trapdoor enabling authorized changes. Based on the authors' abstract, this is a different signing design, not a way to transform an already-issued RSA/ECDSA PDF signature. No implementation was tested. |
| Compress, then sign again with the same DSC | Technically viable as a separate signer-authorized workflow. [pyHanko supports external signers](https://docs.pyhanko.eu/en/latest/lib-guide/signing.html), including signing infrastructure integrations. It creates a new signature and requires the signer; it does not preserve the original signature value. It is not implemented here. |

## The boundary we can measure

The PDF signature covers the encoded file revision, including its signature dictionary, except the signature value. [ETSI section 6.3(k)](https://www.etsi.org/deliver/etsi_en/319100_319199/31914201/01.02.01_60/en_31914201v010201p.pdf) specifies that coverage. Therefore, when we preserve signed revisions byte for byte, the end of the last protected byte range is a lower bound on output length. A separate decoder or server does not lower that bound for the standalone PDF received by an unchanged validator.

The read-only inspector reports this bound and the unsigned tail size without writing document data or fetching certificates. It includes document timestamps in the bound. An unsigned tail is only a candidate for structural inspection; it might contain essential pages, timestamps or other data and must never be dropped automatically.

The previously tested public DSC document still has zero unsigned bytes: all 1,688,159 bytes are covered by its signature revision. The expanded method cannot shrink that file. This research has **not** found a general method for reducing existing signed page content while retaining its original DSC signature.

## Infrastructure and release decision

The useful infrastructure now consists of a read-only size diagnosis, a narrow candidate generator, independent verification, generated signing identities, positive cases and rejection cases. All test keys are created in memory. Outputs use ignored local test folders. No app content, main README, upload behavior or production bundle was changed.

The next production feature should extend the browser worker to the proven unsigned CRL/OCSP/VRI profile. It needs explicit DER schemas, complete VRI comparison, bounded stream decompression, cancellation, negative cases and independent verification of browser downloads. Multiple signatures can remain a separate release after the one-signature path passes those checks. Existing DSS stores and data after document timestamps require their own revision analysis; they remain outside this candidate generator.

The Python prototype is for generated fixtures and is not hardened for arbitrary uploaded PDFs. It uses a pinned internal writer API. Its decoded-data checks occur after library decompression, so it must not be exposed as a public document service. No Acrobat/European Commission DSS cross-validation, representative filing corpus, licensed token workflow, live revocation service or MCA submission was tested. The app's stricter production rules remain in place.

GitHub Pages can continue serving the frontend if the verified method is ported into its worker. A backend is not needed to overcome this size limit for supported unsigned updates. A backend or local signing helper becomes relevant only for a different workflow, such as obtaining a new signature with the user's DSC.

## Reproduce

Install Node dependencies as usual. In a Python environment, install both existing research requirement files, with OpenSSL and Poppler's `pdftoppm` available:

```sh
python -m pip install -r research/signed-pdf/requirements.txt -r research/signed-pdf/dsc-requirements.txt
python scripts/research-dsc-revocation.py
python scripts/inspect-signed-budget.py tmp/dsc-revocation/large-rsa-crl-ocsp-vri-input.pdf --limit 10000000
```

The experiment writes only to ignored `tmp/dsc-revocation/`. Keys, signing times and certificate serials change on each run, so byte counts vary slightly. The inspector reads a PDF and prints its diagnosis to the terminal; it does not create a copy or report file. Public certificate trust and current revocation status are deliberately not claimed by that inspector.
