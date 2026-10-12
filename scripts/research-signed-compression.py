"""Local feasibility experiments. Never used by the website or on user documents.

Run from the repository root; output goes to ignored tmp/signed-research/.
The input fixtures were signed with disposable test certificates. Trusting those
certificates here tests integrity, not real-world certificate trust or MCA acceptance.
"""
from pathlib import Path
import gzip
import hashlib
import io
import json
import logging
import shutil
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
for directory in ('tmp/qa-python', 'tmp/research-python'):
    sys.path.insert(0, str(ROOT / directory))

import pikepdf
import pypdf
from PIL import Image
from pyhanko.pdf_utils import generic
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.sign.validation import validate_pdf_signature
from pyhanko_certvalidator import ValidationContext
from asn1crypto import cms, x509

logging.basicConfig(level=logging.CRITICAL)
OUT = ROOT / 'tmp/signed-research'
OUT.mkdir(parents=True, exist_ok=True)
OPENSSL = shutil.which('openssl')
if not OPENSSL:
    git_openssl = Path('C:/Program Files/Git/usr/bin/openssl.exe')
    OPENSSL = str(git_openssl) if git_openssl.is_file() else None
if not OPENSSL:
    raise RuntimeError('Install OpenSSL to run the independent CMS verification.')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def inspect(data, trust_roots):
    """Separate signed bytes, CMS validity, coverage, and modification policy."""
    try:
        reader = PdfFileReader(io.BytesIO(data), strict=True)
        signatures = []
        for sig in reader.embedded_signatures:
            ranges = list(map(int, sig.byte_range))
            well_formed = (
                len(ranges) == 4 and ranges[0] == 0 and ranges[1] > 0
                and ranges[2] > ranges[1] and ranges[3] >= 0
                and ranges[2] + ranges[3] <= len(data)
            )
            record = {
                'field': sig.field_name,
                'byte_range': ranges,
                'ranges_in_bounds': well_formed,
                'cms_sha256': digest(sig.pkcs7_content),
                'signed_bytes_sha256': digest(b''.join(
                    data[start:start + count] for start, count in zip(ranges[::2], ranges[1::2])
                )) if well_formed else None,
            }
            # OpenSSL checks CMS/content integrity independently of pyHanko.
            # -noverify skips certificate-chain trust ONLY. Digest and public-key
            # signature verification stay enabled; trust is tested by pyHanko.
            (OUT / 'verify-cms.der').write_bytes(cms.ContentInfo.load(sig.pkcs7_content).dump())
            (OUT / 'verify-content.bin').write_bytes(b''.join(
                data[start:start + count] for start, count in zip(ranges[::2], ranges[1::2])
            ))
            check = subprocess.run([
                OPENSSL, 'cms', '-verify', '-binary', '-inform', 'DER', '-noverify',
                '-in', str(OUT / 'verify-cms.der'), '-content', str(OUT / 'verify-content.bin'),
            ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, timeout=30)
            record['openssl_content_verified'] = check.returncode == 0
            try:
                status = validate_pdf_signature(sig, signer_validation_context=ValidationContext(
                    trust_roots=trust_roots, allow_fetching=False,
                ))
                record.update({
                    'intact': status.intact,
                    'cms_valid': status.valid,
                    'trusted_test_certificate': status.trusted,
                    'coverage': status.coverage.name if status.coverage else None,
                    'modification_level': status.modification_level.name if status.modification_level else None,
                    'docmdp_ok': status.docmdp_ok,
                    'accepted_by_validator': status.bottom_line,
                })
            except Exception as exc:
                record.update({'intact': False, 'accepted_by_validator': False,
                               'validation_error': f'{type(exc).__name__}: {exc}'})
            signatures.append(record)
        return {'bytes': len(data), 'sha256': digest(data),
                'revisions': reader.xrefs.total_revisions, 'signatures': signatures}
    except Exception as exc:
        return {'bytes': len(data), 'sha256': digest(data), 'signatures': [],
                'parse_error': f'{type(exc).__name__}: {exc}'}


def pypdf_rewrite(data):
    writer = pypdf.PdfWriter(clone_from=io.BytesIO(data))
    for page in writer.pages:
        page.compress_content_streams(level=9)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def qpdf_rewrite(data):
    out = io.BytesIO()
    with pikepdf.Pdf.open(io.BytesIO(data)) as pdf:
        pdf.save(out, compress_streams=True, recompress_flate=True,
                 object_stream_mode=pikepdf.ObjectStreamMode.generate)
    return out.getvalue()


def incremental_recompression(data):
    writer = IncrementalPdfFileWriter(io.BytesIO(data))
    page_ref, _ = writer.find_page_for_modification(0)
    page = page_ref.get_object()
    contents = page['/Contents']
    contents = contents if isinstance(contents, generic.ArrayObject) else [contents]
    streams = []
    for old in contents:
        replacement = generic.StreamObject(stream_data=old.get_object().data)
        replacement.compress()
        streams.append(writer.add_object(replacement))
    page[generic.pdf_name('/Contents')] = generic.ArrayObject(streams)
    writer.mark_update(page_ref)
    out = io.BytesIO()
    writer.write(out)
    result = out.getvalue()
    assert result[:len(data)] == data, 'Incremental writer changed the signed prefix'
    return result


def attachment_wrapper(data):
    """An unsigned cover PDF containing the exact signed original as an attachment."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(595, 842))
    font = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica,
    ))
    page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
    page.Contents = pdf.make_stream(
        b'BT /F1 16 Tf 50 780 Td (Research attachment container) Tj '
        b'0 -35 Td /F1 11 Tf (This cover is not digitally signed.) Tj '
        b'0 -22 Td (Extract original.pdf to inspect the original signed document.) Tj '
        b'0 -22 Td (Not approved for portal submissions.) Tj ET'
    )
    pdf.attachments['original.pdf'] = pikepdf.AttachedFileSpec(pdf, data, filename='original.pdf')
    out = io.BytesIO()
    pdf.save(out, compress_streams=True, object_stream_mode=pikepdf.ObjectStreamMode.generate)
    result = out.getvalue()
    with pikepdf.Pdf.open(io.BytesIO(result)) as reopened:
        extracted = reopened.attachments['original.pdf'].get_file().read_bytes()
    assert extracted == data
    return result, extracted


def append_validation_certificates(data, certificates, *, compact):
    """Known-fixture experiment: append only a DSS certificate array.

    Not an optimizer for arbitrary documents. A production implementation must
    prove that this is the ONLY unsigned change before rebuilding a suffix.
    """
    writer = IncrementalPdfFileWriter(io.BytesIO(data))
    refs = []
    cache = {}
    for der in certificates:
        key = digest(der)
        if compact and key in cache:
            ref = cache[key]
        else:
            stream = generic.StreamObject(stream_data=der)
            if compact:
                stream.compress()
            ref = writer.add_object(stream)
            cache[key] = ref
        refs.append(ref)
    dss = generic.DictionaryObject({
        generic.pdf_name('/Certs'): generic.ArrayObject(refs),
    })
    writer.root[generic.pdf_name('/DSS')] = writer.add_object(dss)
    writer.update_root()
    out = io.BytesIO()
    writer.write(out)
    result = out.getvalue()
    assert result[:len(data)] == data
    return result


def validation_certificates(data):
    reader = PdfFileReader(io.BytesIO(data))
    return [entry.get_object().data for entry in reader.root['/DSS']['/Certs']]


def compact_unsigned_certificate_update(data, trust_roots, limit=10_000_000):
    """Experimental, deliberately narrow candidate generator. Not a public API.

    Accept only one traditional-xref unsigned revision that adds /DSS /Certs
    and optionally updates a direct-value /Info dictionary. Everything else is
    rejected. No signed pages, timestamps, CRLs or OCSP data are rewritten.
    """
    def require(condition, reason):
        if not condition:
            raise ValueError(reason)

    def ref_key(ref):
        require(isinstance(ref, (generic.IndirectObject, generic.Reference)), 'Expected an indirect reference')
        return (ref.idnum, ref.generation)

    def serialise(obj):
        out = io.BytesIO()
        obj.write_to_stream(out)
        return out.getvalue()

    require(len(data) <= 40_000_000, 'Input is over the research resource limit')
    reader = PdfFileReader(io.BytesIO(data), strict=True)
    require(not reader.encrypted, 'Encrypted documents are outside this experiment')
    signatures = reader.embedded_signatures
    require(bool(signatures), 'No signatures')
    require(all(s.sig_object.get('/Type') != '/DocTimeStamp' for s in signatures), 'Document timestamps are outside this experiment')
    before = inspect(data, trust_roots)
    require(all(s.get('accepted_by_validator') and s.get('openssl_content_verified') and s['ranges_in_bounds'] for s in before['signatures']), 'Input signature validation failed')
    end = max(s['byte_range'][2] + s['byte_range'][3] for s in before['signatures'])
    require(end < len(data), 'No unsigned suffix to reduce')
    require(end < limit, 'Signed bytes already meet or exceed the requested limit')
    prefix = data[:end]
    signed_reader = PdfFileReader(io.BytesIO(prefix), strict=True)
    require(reader.xrefs.total_revisions == signed_reader.xrefs.total_revisions + 1,
            'Only one unsigned revision is supported')
    revision = reader.xrefs.total_revisions - 1
    xref = reader.xrefs.get_xref_data(revision)
    require(not reader.has_xref_stream and not xref.hybrid and not reader.xrefs.object_streams_used_in(revision),
            'Only traditional xrefs without object streams are supported')
    require(not reader.xrefs.refs_freed_in_revision(revision), 'Freed objects are unsupported')
    require('/DSS' not in signed_reader.root, 'An earlier DSS is outside this experiment')
    require(set(reader.root) == set(signed_reader.root) | {'/DSS'}, 'Catalog contains other changes')
    require(all(serialise(reader.root.raw_get(k)) == serialise(signed_reader.root.raw_get(k))
                for k in signed_reader.root), 'Catalog contains other changes')
    require(set(reader.trailer.flatten()) <= {'/Size', '/Prev', '/Root', '/Info', '/ID'}, 'Unknown trailer entries')
    require(ref_key(reader.trailer.raw_get('/Root')) == ref_key(signed_reader.trailer.raw_get('/Root')), 'Catalog reference changed')

    dss_ref = reader.root.raw_get('/DSS')
    allowed_refs = {ref_key(reader.trailer.raw_get('/Root')), ref_key(dss_ref)}
    first_new_object = int(signed_reader.trailer['/Size'])
    require(dss_ref.idnum >= first_new_object, 'DSS overwrites a signed object')
    dss = dss_ref.get_object()
    require(set(dss) == {'/Certs'}, 'Only a certificate-only DSS is supported')
    entries = dss.raw_get('/Certs')
    require(isinstance(entries, generic.ArrayObject) and 0 < len(entries) <= 20_000, 'Unsupported certificate array')
    certs = []
    for entry in entries:
        allowed_refs.add(ref_key(entry))
        require(entry.idnum >= first_new_object, 'Certificate overwrites a signed object')
        stream = entry.get_object()
        require(isinstance(stream, generic.StreamObject), 'Certificate is not a stream')
        require(set(stream) <= {'/Length', '/Filter'}, 'Unsupported certificate stream fields')
        require(stream.get('/Filter') in (None, '/FlateDecode'), 'Unsupported stream filter')
        der = stream.data
        require(0 < len(der) <= 65536, 'Certificate size is outside the research bounds')
        x509.Certificate.load(der, strict=True)
        certs.append(der)

    info = None
    if '/Info' in reader.trailer:
        info_ref = reader.trailer.raw_get('/Info')
        allowed_refs.add(ref_key(info_ref))
        require('/Info' in signed_reader.trailer and ref_key(info_ref) == ref_key(signed_reader.trailer.raw_get('/Info')),
                'Info reference changed')
        info = info_ref.get_object()
        require(all(isinstance(v, (generic.TextStringObject, generic.ByteStringObject,
                                   generic.NumberObject, generic.FloatObject, generic.NameObject,
                                   generic.BooleanObject, generic.NullObject)) for v in info.values()),
                'Only direct metadata values are supported')
    changed_refs = {ref_key(ref) for ref in reader.xrefs.explicit_refs_in_revision(revision)}
    require(changed_refs <= allowed_refs, 'Unsigned revision changes other document objects')

    # Build a candidate from the preserved signed prefix. The source is never
    # mutated. Every decoded certificate entry remains, in the original order.
    candidate = append_validation_certificates(prefix, certs, compact=True)
    # Preserve the latest metadata exactly, without a new automatic ModDate.
    writer = IncrementalPdfFileWriter(io.BytesIO(prefix))
    compact_reader = PdfFileReader(io.BytesIO(candidate))
    writer.root[generic.pdf_name('/DSS')] = writer.import_object(compact_reader.root.raw_get('/DSS'))
    writer.update_root()
    if info is not None:
        writer.set_info(writer.import_object(reader.trailer.raw_get('/Info')))
    writer._document_id = reader.trailer['/ID']
    out = io.BytesIO()
    # Pinned pyHanko internal API, used only in this local feasibility lab.
    writer._write(out)
    candidate = out.getvalue()
    require(candidate[:end] == prefix, 'Signed prefix changed')
    require(validation_certificates(candidate) == certs, 'Certificate contents changed')
    reopened = PdfFileReader(io.BytesIO(candidate))
    if info is not None:
        require(serialise(reopened.trailer['/Info']) == serialise(info), 'Metadata changed')
    after = inspect(candidate, trust_roots)
    identity = lambda result: [(s['cms_sha256'], s['signed_bytes_sha256']) for s in result['signatures']]
    require(identity(before) == identity(after), 'Signature identities or signed bytes changed')
    require(all(s.get('accepted_by_validator') and s.get('openssl_content_verified') for s in after['signatures']), 'Output verification failed')
    require(len(candidate) < min(len(data), limit), 'Candidate does not meet the size requirement')
    return candidate


def run():
    report = {'versions': {'pikepdf': pikepdf.__version__, 'qpdf': pikepdf.__libqpdf_version__,
                           'pypdf': pypdf.__version__, 'pyhanko': '0.37.0',
                           'openssl': subprocess.check_output([OPENSSL, 'version'], text=True).strip()}, 'fixtures': {}}
    for label, data in [
        ('small', (ROOT / 'tests/data/signed-synthetic.pdf').read_bytes()),
        ('large', gzip.decompress((ROOT / 'tests/data/signed-over-limit-synthetic.pdf.gz').read_bytes())),
    ]:
        reader = PdfFileReader(io.BytesIO(data))
        roots = [sig.signer_cert for sig in reader.embedded_signatures]
        assert roots
        original = inspect(data, roots)
        assert all(s['intact'] and s['accepted_by_validator'] and s['openssl_content_verified'] for s in original['signatures'])
        assert original['signatures'][-1]['coverage'] == 'ENTIRE_FILE'
        (OUT / f'{label}-original.pdf').write_bytes(data)
        attempts = {}
        for method, transform in [
            ('pypdf_lossless_rewrite', pypdf_rewrite),
            ('qpdf_lossless_rewrite', qpdf_rewrite),
            ('incremental_recompression', incremental_recompression),
        ]:
            result = transform(data)
            (OUT / f'{label}-{method}.pdf').write_bytes(result)
            evaluation = inspect(result, roots)
            evaluation['smaller'] = len(result) < len(data)
            evaluation['signature_count_preserved'] = len(evaluation['signatures']) == len(original['signatures'])
            evaluation['signed_bytes_preserved'] = [s['signed_bytes_sha256'] for s in evaluation['signatures']] == [s['signed_bytes_sha256'] for s in original['signatures']]
            evaluation['cms_preserved'] = [s['cms_sha256'] for s in evaluation['signatures']] == [s['cms_sha256'] for s in original['signatures']]
            evaluation['meets_requirement'] = (
                evaluation['smaller'] and evaluation['signature_count_preserved']
                and evaluation['signed_bytes_preserved'] and evaluation['cms_preserved']
                and all(s.get('accepted_by_validator') and s.get('openssl_content_verified') for s in evaluation['signatures'])
            )
            attempts[method] = evaluation
            if method.endswith('rewrite'):
                assert evaluation['smaller'] and evaluation['cms_preserved']
                assert not evaluation['signed_bytes_preserved']
                assert all(not s['intact'] and not s['openssl_content_verified'] for s in evaluation['signatures'])
            else:
                assert not evaluation['smaller'] and evaluation['signed_bytes_preserved']
                assert all(s['openssl_content_verified'] and not s['docmdp_ok'] for s in evaluation['signatures'])

        wrapped, extracted = attachment_wrapper(data)
        (OUT / f'{label}-attachment-container.pdf').write_bytes(wrapped)
        attempts['attachment_container'] = {
            **inspect(wrapped, roots), 'extracted_original_identical': extracted == data,
            'extracted_original_validation': inspect(extracted, roots),
            'meets_requirement': False,
            'reason': 'The container is unsigned. The signature belongs to the extracted original, not its cover.',
        }

        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as zip_out:
            zip_out.writestr('original.pdf', data)
        with zipfile.ZipFile(io.BytesIO(archive.getvalue())) as zip_in:
            assert zip_in.read('original.pdf') == data
        attempts['zip_container'] = {'bytes': len(archive.getvalue()), 'original_identical_after_extraction': True,
                                     'meets_requirement': False, 'reason': 'Output is ZIP, not an uploadable signed PDF.'}

        # A deliberately contrived unsigned whitespace suffix is a narrow exception.
        # Its removal restores the exact original; it cannot reduce signed content.
        padded = data + b' \r\n' * 200
        signed_end = max(sum(s['byte_range'][2:]) for s in original['signatures'])
        suffix = padded[signed_end:]
        assert signed_end == len(data) and suffix.strip(b' \t\r\n\x00\x0c') == b''
        restored = padded[:signed_end]
        assert restored == data
        attempts['remove_unsigned_whitespace'] = {
            'before_bytes': len(padded), 'after_bytes': len(restored),
            'removed_bytes': len(suffix), 'restores_exact_original': True,
            'validation': inspect(restored, roots),
            'ordinary_input_removable_bytes': len(data) - signed_end,
            'reason': 'Only contrived whitespace beyond the last signed EOF; no signed content is reduced.',
        }

        # Deleting a signed byte, even one byte of harmless syntax, must fail.
        endline = data[:signed_end].rfind(b'\n')
        tampered = data[:endline] + data[endline + 1:]
        bad = inspect(tampered, roots)
        assert not bad['signatures'] or not all(s.get('accepted_by_validator') for s in bad['signatures'])
        assert not any(attempt.get('meets_requirement') for attempt in attempts.values())
        report['fixtures'][label] = {'original': original, 'attempts': attempts,
                                     'signed_byte_deletion_rejected': True}
        print(label, 'original', len(data), 'bytes')
        for method, result in attempts.items():
            print(' ', method, result.get('bytes', result.get('after_bytes')),
                  'bytes; meets original requirement:', result.get('meets_requirement', 'narrow exception only'))

    # Explore a real mechanism with an intentionally exaggerated duplicate-data
    # fixture. The signed prefix is small; ALL bloat is unsigned DSS data added
    # later. This is not evidence of how often client documents have such bloat.
    base = (ROOT / 'tests/data/signed-synthetic.pdf').read_bytes()
    sig = PdfFileReader(io.BytesIO(base)).embedded_signatures[0]
    roots = [sig.signer_cert]
    certificates = [sig.signer_cert.dump()] * 14000
    bloated = append_validation_certificates(base, certificates, compact=False)
    assert len(bloated) > 10_000_000
    # Preserve every logical certificate entry; share repeated byte-identical
    # streams. Rebuild the known unsigned suffix, not the signed prefix.
    preserved_certificates = validation_certificates(bloated)
    compacted = compact_unsigned_certificate_update(bloated, roots)
    assert validation_certificates(compacted) == preserved_certificates
    assert compacted[:len(base)] == bloated[:len(base)] == base
    assert len(compacted) < 10_000_000
    before = inspect(bloated, roots)
    after = inspect(compacted, roots)
    for result in (before, after):
        assert all(s['intact'] and s['accepted_by_validator'] and s['openssl_content_verified'] for s in result['signatures']), result
    assert [(s['cms_sha256'], s['signed_bytes_sha256']) for s in before['signatures']] == [(s['cms_sha256'], s['signed_bytes_sha256']) for s in after['signatures']]
    (OUT / 'unsigned-dss-before.pdf').write_bytes(bloated)
    (OUT / 'unsigned-dss-after.pdf').write_bytes(compacted)
    report['unsigned_dss_experiment'] = {
        'before': before, 'after': after, 'signed_prefix_bytes': len(base),
        'decoded_certificate_entries_preserved': len(certificates),
        'same_original_cms_and_signed_bytes': True,
        'fixture_requirement_met': True,
        'production_ready': False,
        'scope': 'A known, sole, unsigned DSS certificate update after the last signature; no timestamps, page edits or other unsigned revisions.',
    }
    rejection_cases = {}
    tampered = bloated.replace(b'ReportLab', b'ReportLax', 1)
    assert tampered != bloated
    for name, test_input, test_limit in [
        ('no_unsigned_update', base, 10_000_000),
        ('signed_prefix_at_limit', bloated, len(base)),
        ('signed_prefix_over_limit', bloated, len(base) - 1),
        ('unachievable_limit', bloated, len(base) + 1),
        ('unsigned_page_change', incremental_recompression(base), 10_000_000),
        ('second_unsigned_revision', append_validation_certificates(bloated, certificates[:1], compact=True), 10_000_000),
        ('tampered_signed_metadata', tampered, 10_000_000),
    ]:
        try:
            compact_unsigned_certificate_update(test_input, roots, test_limit)
        except ValueError as exc:
            rejection_cases[name] = str(exc)
        else:
            raise AssertionError(f'Unsafe or unsupported input was accepted: {name}')
    report['dss_rejection_cases'] = rejection_cases
    print('Rejected unsupported or unsafe DSS candidates:', len(rejection_cases))
    print('Known unsigned DSS suffix:', len(bloated), '->', len(compacted),
          'bytes; original signature and decoded certificate entries preserved')
    renderer = shutil.which('pdftoppm')
    if renderer:
        rendered = {}
        names = [f'{label}-{method}' for label in ('small', 'large')
                 for method in ('original', 'pypdf_lossless_rewrite', 'qpdf_lossless_rewrite', 'incremental_recompression')]
        names += ['unsigned-dss-before', 'unsigned-dss-after']
        for name in names:
            subprocess.run([renderer, '-f', '1', '-singlefile', '-scale-to', '1000', '-png',
                            str(OUT / f'{name}.pdf'), str(OUT / name)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True, timeout=30)
            with Image.open(OUT / f'{name}.png') as pixels:
                rendered[name] = {'dimensions': list(pixels.size), 'pixel_sha256': digest(pixels.tobytes())}
        assert len({(tuple(x['dimensions']), x['pixel_sha256']) for x in rendered.values()}) == 1
        report['render_comparisons'] = rendered
        print('Poppler renders with identical pixels:', len(rendered))
    else:
        report['render_comparisons'] = {'skipped': 'pdftoppm is not installed'}
    (OUT / 'results.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print('Results:', OUT / 'results.json')


if __name__ == '__main__':
    run()
