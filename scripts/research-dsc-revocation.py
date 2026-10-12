"""Offline experiment for unsigned DSS revocation updates, NOT a public optimizer.

Only generated fixtures are accepted by this runner. All keys stay in memory.
PDFs, verification buffers and renders go to ignored tmp/dsc-revocation/.
The website does not import this code or accept its expanded profile.
"""
from pathlib import Path
from datetime import datetime, timedelta, timezone
from importlib import util
import gzip
import hashlib
import io
import json
import subprocess
import sys
import zlib

ROOT = Path(__file__).resolve().parents[1]
for directory in ('tmp/qa-python', 'tmp/research-python'):
    sys.path.insert(0, str(ROOT / directory))
from asn1crypto import keys, x509 as ax509, crl as acrl, ocsp as aocsp
from cryptography import x509
from cryptography.x509 import ocsp
from cryptography.x509.oid import NameOID, AuthorityInformationAccessOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa, ec
from PIL import Image
from reportlab.pdfgen import canvas
from pyhanko.pdf_utils import generic
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.sign import signers
from pyhanko.sign.fields import SigFieldSpec, SigSeedSubFilter
from pyhanko.sign.validation import validate_pdf_signature
from pyhanko.sign.validation.dss import DocumentSecurityStore
from pyhanko_certvalidator import ValidationContext
from pyhanko_certvalidator.registry import SimpleCertificateStore

OUT = ROOT / 'tmp/dsc-revocation'
OUT.mkdir(parents=True, exist_ok=True)
spec = util.spec_from_file_location('signed_lab', ROOT / 'scripts/research-signed-compression.py')
lab = util.module_from_spec(spec)
spec.loader.exec_module(lab)
lab.OUT = OUT
N = generic.pdf_name
DER = serialization.Encoding.DER
now = datetime.now(timezone.utc).replace(microsecond=0)


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def encoded(obj):
    out = io.BytesIO()
    obj.write_to_stream(out)
    return out.getvalue()


def reference(obj):
    require(isinstance(obj, (generic.IndirectObject, generic.Reference)), 'Expected indirect reference')
    return obj.idnum, obj.generation


def dss_snapshot(dss):
    """All values and every decoded stream, independent of object numbering."""
    def walk(obj, depth=0):
        require(depth < 12, 'DSS graph too deep')
        if isinstance(obj, (generic.IndirectObject, generic.Reference)):
            return walk(obj.get_object(), depth + 1)
        if isinstance(obj, generic.StreamObject):
            return ['stream', hashlib.sha256(obj.data).hexdigest(), len(obj.data)]
        if isinstance(obj, generic.DictionaryObject):
            return {str(k): walk(v, depth + 1) for k, v in sorted(obj.items())}
        if isinstance(obj, generic.ArrayObject):
            return [walk(v, depth + 1) for v in obj]
        return encoded(obj).hex()
    return walk(dss)


def compact_revocation_update(data, roots, limit=10_000_000):
    """Narrow research candidate: one newly added unsigned DSS revision.

    Validate the graph before rebuilding it. This uses pyHanko's pinned private
    writer API, has not been hardened for hostile inputs and is not deployed.
    """
    require(len(data) <= 40_000_000, 'Research input size limit')
    reader = PdfFileReader(io.BytesIO(data), strict=True)
    require(not reader.encrypted, 'Encrypted input')
    require(reader.embedded_signatures, 'No signatures')
    require(all(s.sig_object.get('/Type') != '/DocTimeStamp' for s in reader.embedded_signatures),
            'Document timestamps are outside this experiment')
    before = lab.inspect(data, roots)
    require(all(s.get('accepted_by_validator') and s.get('openssl_content_verified')
                and s.get('coverage') in ('ENTIRE_FILE', 'ENTIRE_REVISION')
                for s in before['signatures']), 'Input signature or modification check failed')
    end = max(s['byte_range'][2] + s['byte_range'][3] for s in before['signatures'])
    require(end < len(data), 'No unsigned update')
    require(end < limit, 'Protected signed prefix reaches the limit')
    prefix = data[:end]
    signed = PdfFileReader(io.BytesIO(prefix), strict=True)
    require(reader.xrefs.total_revisions == signed.xrefs.total_revisions + 1, 'More than one unsigned revision')
    revision = reader.xrefs.total_revisions - 1
    require(not reader.has_xref_stream and not reader.xrefs.get_xref_data(revision).hybrid
            and not reader.xrefs.object_streams_used_in(revision), 'Unsupported cross-reference format')
    require(not reader.xrefs.refs_freed_in_revision(revision), 'Freed objects')
    require('/DSS' not in signed.root, 'DSS existed before last signature')
    require(set(reader.root) == set(signed.root) | {'/DSS'}, 'Other catalog changes')
    require(all(encoded(reader.root.raw_get(k)) == encoded(signed.root.raw_get(k)) for k in signed.root),
            'Other catalog changes')
    require(set(reader.trailer.flatten()) <= {'/Size', '/Prev', '/Root', '/Info', '/ID'}, 'Unknown trailer entries')
    require(reference(reader.trailer.raw_get('/Root')) == reference(signed.trailer.raw_get('/Root')),
            'Catalog reference changed')
    first_new = int(signed.trailer['/Size'])
    allowed = {reference(reader.trailer.raw_get('/Root'))}
    stream_types = {}
    budget = [0]

    def new_object(ref):
        key = reference(ref)
        require(key[0] >= first_new and key[1] == 0, 'DSS replaces a signed object')
        allowed.add(key)
        return ref.get_object()

    def stream_array(array, kind):
        require(isinstance(array, generic.ArrayObject) and 0 < len(array) <= 1000, 'Unsupported evidence array')
        parser = {'Certs': ax509.Certificate, 'CRLs': acrl.CertificateList, 'OCSPs': aocsp.OCSPResponse}[kind]
        for ref in array:
            key = reference(ref)
            if key in stream_types:
                require(stream_types[key] == kind, 'Evidence used as different types')
                continue
            stream = new_object(ref)
            require(isinstance(stream, generic.StreamObject), 'Evidence is not a stream')
            require(set(stream) <= {'/Length', '/Filter'} and stream.get('/Filter') in (None, '/FlateDecode'),
                    'Unsupported evidence stream')
            value = stream.data
            require(0 < len(value) <= 16_000_000, 'Evidence stream too large')
            budget[0] += len(value)
            require(budget[0] <= 24_000_000, 'Decoded evidence budget exceeded')
            parsed = parser.load(value, strict=True)
            require(parsed.dump(force=True) == value, 'Evidence is not canonical DER')
            # Force the lazy ASN.1 parser to decode all fields.
            parsed.native
            stream_types[key] = kind

    dss_ref = reader.root.raw_get('/DSS')
    dss = new_object(dss_ref)
    require(isinstance(dss, generic.DictionaryObject) and not isinstance(dss, generic.StreamObject), 'Invalid DSS')
    require(set(dss) <= {'/Type', '/Certs', '/CRLs', '/OCSPs', '/VRI'} and dss.get('/Type', '/DSS') == '/DSS',
            'Unknown DSS key')
    for kind in ('Certs', 'CRLs', 'OCSPs'):
        if '/' + kind in dss:
            stream_array(dss.raw_get('/' + kind), kind)
    if '/VRI' in dss:
        vris = dss.raw_get('/VRI')
        if isinstance(vris, generic.IndirectObject):
            vris = new_object(vris)
        require(isinstance(vris, generic.DictionaryObject) and len(vris) <= 16, 'Invalid VRI dictionary')
        expected_identifiers = {DocumentSecurityStore.sig_content_identifier(s.pkcs7_content) for s in reader.embedded_signatures}
        require(set(vris) == expected_identifiers, 'VRI does not map every signature')
        for vri_ref in vris.values():
            vri = new_object(vri_ref)
            require(set(vri) <= {'/Type', '/Cert', '/CRL', '/OCSP', '/TU'} and vri.get('/Type', '/VRI') == '/VRI',
                    'Unknown VRI key')
            for key, kind in [('Cert', 'Certs'), ('CRL', 'CRLs'), ('OCSP', 'OCSPs')]:
                if '/' + key in vri:
                    stream_array(vri.raw_get('/' + key), kind)
            if '/TU' in vri:
                require(isinstance(vri['/TU'], generic.TextStringObject), 'Unsupported validation time')
    require(stream_types, 'Empty evidence set')
    if '/Info' in reader.trailer:
        info = reader.trailer.raw_get('/Info')
        require('/Info' in signed.trailer and reference(info) == reference(signed.trailer.raw_get('/Info')), 'Info reference changed')
        allowed.add(reference(info))
        require(all(isinstance(v, (generic.TextStringObject, generic.ByteStringObject, generic.NumberObject,
                    generic.FloatObject, generic.NameObject, generic.BooleanObject, generic.NullObject))
                    for v in info.get_object().values()), 'Indirect metadata')
    changed = {reference(ref) for ref in reader.xrefs.explicit_refs_in_revision(revision)}
    require(changed <= allowed, 'Unrelated objects changed')
    writer = IncrementalPdfFileWriter(io.BytesIO(prefix))
    cache = {}

    def clone(obj):
        if isinstance(obj, generic.IndirectObject):
            key = reference(obj)
            if key not in cache:
                cache[key] = writer.add_object(clone(obj.get_object()))
            return cache[key]
        if isinstance(obj, generic.StreamObject):
            raw = obj.data
            compressed = zlib.compress(raw, level=9)
            if len(compressed) + 24 < len(raw):
                return generic.StreamObject({N('/Filter'): N('/FlateDecode')}, encoded_data=compressed)
            return generic.StreamObject(stream_data=raw)
        if isinstance(obj, generic.DictionaryObject):
            return generic.DictionaryObject({k: clone(v) for k, v in obj.items()})
        if isinstance(obj, generic.ArrayObject):
            return generic.ArrayObject([clone(v) for v in obj])
        return obj

    writer.root[N('/DSS')] = clone(dss_ref)
    writer.update_root()
    if '/Info' in reader.trailer and encoded(reader.trailer['/Info']) != encoded(signed.trailer['/Info']):
        writer.set_info(writer.import_object(reader.trailer.raw_get('/Info')))
    writer._document_id = reader.trailer['/ID']
    buf = io.BytesIO()
    writer._write(buf)  # Pinned lab API: no auto-generated metadata.
    candidate = buf.getvalue()
    require(candidate[:end] == prefix, 'Protected bytes changed')
    output = PdfFileReader(io.BytesIO(candidate), strict=True)
    require(dss_snapshot(dss) == dss_snapshot(output.root['/DSS']), 'Evidence changed')
    for key in ('/Info', '/ID'):
        if key in reader.trailer:
            require(encoded(reader.trailer[key]) == encoded(output.trailer[key]), 'Metadata changed')
    after = lab.inspect(candidate, roots)
    identities = lambda report: [(s['byte_range'], s['cms_sha256'], s['signed_bytes_sha256']) for s in report['signatures']]
    require(identities(before) == identities(after), 'Signature identity changed')
    require(all(s.get('accepted_by_validator') and s.get('openssl_content_verified')
                and s.get('coverage') == 'ENTIRE_REVISION' for s in after['signatures']), 'Output verification failed')
    require(len(candidate) < min(len(data), limit),
            f'No smaller output below target ({len(data)} to {len(candidate)} bytes)')
    return candidate, before, after


def issue(label, key, issuer=None, issuer_key=None, ca=False):
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Under10 TEST ' + label)])
    return (x509.CertificateBuilder().subject_name(subject).issuer_name(issuer.subject if issuer else subject)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=3650))
            .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=not ca, content_commitment=not ca,
                key_encipherment=False, data_encipherment=False, key_agreement=False, key_cert_sign=ca,
                crl_sign=ca, encipher_only=None, decipher_only=None), critical=True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key((issuer_key or key).public_key()), critical=False)
            .add_extension(x509.AuthorityInformationAccess([x509.AccessDescription(
                AuthorityInformationAccessOID.OCSP, x509.UniformResourceIdentifier('https://ocsp.example.invalid/'))]), critical=False)
            .sign(issuer_key or key, hashes.SHA256()))


def signer(cert, key, chain):
    registry = SimpleCertificateStore()
    registry.register_multiple(chain)
    return signers.SimpleSigner(signing_cert=ax509.Certificate.load(cert.public_bytes(DER)),
        signing_key=keys.PrivateKeyInfo.load(key.private_bytes(DER, serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption())), cert_registry=registry)


def unsigned(padding=0):
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pageCompression=0)
    c.setTitle('Revocation-data compression experiment')
    c.drawString(55, 780, 'Revocation-data compression experiment')
    c.drawString(55, 750, 'Test certificate chain. No personal or filing data.')
    c.drawString(55, 725, 'Document content and original signatures must remain unchanged.')
    if padding:
        c._code.append('%' + 'x' * padding)
    c.save()
    return buf.getvalue()


def signed(data, identity, field='FirstSignature'):
    buf = io.BytesIO()
    box = (55, 610, 460, 700) if field == 'FirstSignature' else (55, 500, 460, 590)
    signers.sign_pdf(IncrementalPdfFileWriter(io.BytesIO(data)),
        signature_meta=signers.PdfSignatureMetadata(field_name=field, md_algorithm='sha256', subfilter=SigSeedSubFilter.PADES),
        signer=identity, new_field_spec=SigFieldSpec(sig_field_name=field, box=box), output=buf)
    return buf.getvalue()


def crl(issuer, key, count=0):
    builder = (x509.CertificateRevocationListBuilder().issuer_name(issuer.subject)
        .last_update(now - timedelta(hours=1)).next_update(now + timedelta(days=7))
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(key.public_key()), critical=False)
        .add_extension(x509.CRLNumber(1), critical=False))
    # Unique serials, no repeated certificate objects. This is a deliberately
    # large test CRL, not a claim about typical licensed CA revocation lists.
    for i in range(count):
        builder = builder.add_revoked_certificate(x509.RevokedCertificateBuilder()
            .serial_number(i + 1).revocation_date(now - timedelta(days=2)).build())
    result = builder.sign(key, hashes.SHA256())
    assert result.is_signature_valid(key.public_key())
    return acrl.CertificateList.load(result.public_bytes(DER))


def response(cert, issuer, key):
    result = (ocsp.OCSPResponseBuilder().add_response(cert, issuer, hashes.SHA256(), ocsp.OCSPCertStatus.GOOD,
        now - timedelta(minutes=5), now + timedelta(days=1), None, None)
        .responder_id(ocsp.OCSPResponderEncoding.HASH, issuer).sign(key, hashes.SHA256()))
    return aocsp.OCSPResponse.load(result.public_bytes(DER))


def append_dss(data, certs, crls, ocsps, mutate=None):
    writer = IncrementalPdfFileWriter(io.BytesIO(data))
    for sig in writer.prev.embedded_signatures:
        DocumentSecurityStore.supply_dss_in_writer(writer, sig.pkcs7_content, certs=certs, crls=crls, ocsps=ocsps)
    if mutate:
        mutate(writer)
    buf = io.BytesIO()
    writer._write(buf)
    assert buf.getvalue()[:len(data)] == data
    return buf.getvalue()


def render(path):
    prefix = path.with_suffix('')
    subprocess.run(['pdftoppm', '-r', '96', '-png', str(path), str(prefix)], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=30)
    images = sorted(path.parent.glob(prefix.name + '-*.png'))
    assert images
    result = []
    for image in images:
        with Image.open(image) as img:
            result.append((img.size, hashlib.sha256(img.convert('RGB').tobytes()).hexdigest()))
    return result


def run():
    root_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    root_cert = issue('ROOT (not licensed)', root_key, ca=True)
    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ca_cert = issue('ISSUING CA', ca_key, root_cert, root_key, ca=True)
    leaf_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    leaf = issue('RSA signer', leaf_key, ca_cert, ca_key)
    second_key = ec.generate_private_key(ec.SECP256R1())
    second = issue('ECDSA signer', second_key, ca_cert, ca_key)
    chain = [ax509.Certificate.load(c.public_bytes(DER)) for c in (root_cert, ca_cert, leaf, second)]
    roots = [chain[0]]
    first_signer, second_signer = signer(leaf, leaf_key, chain[:2]), signer(second, second_key, chain[:2])
    revocations = [crl(root_cert, root_key), crl(ca_cert, ca_key, 60_000)]
    responses = [response(ca_cert, root_cert, root_key), response(leaf, ca_cert, ca_key), response(second, ca_cert, ca_key)]
    large = signed(unsigned(9_200_000), first_signer)
    small = signed(unsigned(), first_signer)
    multi = signed(small, second_signer, 'SecondSignature')
    report = {'date': now.isoformat(), 'scope': 'Offline generated fixtures, not licensed DSCs or MCA submissions. Not deployed.',
              'crl_entries': 60_000, 'revocation_stream_bytes': [len(c.dump()) for c in revocations], 'cases': [], 'rejections': []}
    for label, prefix, crls, ocsps in [
        ('large-rsa-crl-ocsp-vri', large, revocations, responses[:2]),
        ('rsa-ocsp-vri', small, [], responses[:2]),
        ('two-signatures-crl-ocsp-vri', multi, revocations, responses),
    ]:
        source = append_dss(prefix, chain, crls, ocsps)
        output, before, after = compact_revocation_update(source, roots)
        in_path, out_path = OUT / f'{label}-input.pdf', OUT / f'{label}-output.pdf'
        in_path.write_bytes(source)
        out_path.write_bytes(output)
        assert render(in_path) == render(out_path)
        reopened = PdfFileReader(io.BytesIO(output), strict=True)
        material = DocumentSecurityStore.read_dss(reopened)
        context = material.as_validation_context({'trust_roots': roots, 'allow_fetching': False, 'revocation_mode': 'require'})
        for sig in reopened.embedded_signatures:
            status = validate_pdf_signature(sig, signer_validation_context=context)
            assert status.intact and status.valid and status.trusted and status.docmdp_ok, status.pretty_print_details()
        report['cases'].append({'name': label, 'input_bytes': len(source), 'output_bytes': len(output),
            'saved_bytes': len(source) - len(output), 'signed_prefix_bytes': len(prefix),
            'input': before, 'output': after, 'all_page_pixels_identical': True,
            'all_dss_values_preserved': True, 'test_chain_revocation_required_passed': True,
            'dss': dss_snapshot(reopened.root['/DSS'])})
        print(label, len(source), '->', len(output), flush=True)
        if label.startswith('large'):
            assert len(source) > 10_000_000 > len(output)
            positive = source

    def page_change(writer):
        ref, _ = writer.find_page_for_modification(0)
        ref.get_object()[N('/Rotate')] = generic.NumberObject(90)
        writer.mark_update(ref)

    def unknown_dss(writer):
        writer.root['/DSS'][N('/Unknown')] = generic.NumberObject(1)

    # Change a signed title without moving any offsets.
    assert b'Revocation' in positive
    tampered = positive.replace(b'Revocation', b'Revocatxon', 1)
    writer = IncrementalPdfFileWriter(io.BytesIO(positive))
    writer.update_root()
    extra = io.BytesIO()
    writer._write(extra)
    stamped = gzip.decompress((ROOT / 'tests/data/signed-timestamp.pdf.gz').read_bytes())
    stamped_end = max(s.byte_range[2] + s.byte_range[3]
                      for s in PdfFileReader(io.BytesIO(stamped)).embedded_signatures)
    protected_large = gzip.decompress((ROOT / 'tests/data/signed-over-limit-synthetic.pdf.gz').read_bytes())
    for label, data, trust, limit, expected in [
        ('no-unsigned-suffix', small, roots, 10_000_000, 'No unsigned update'),
        ('target-below-protected-prefix', positive, roots, len(large), 'Protected signed prefix'),
        ('signed-prefix-over-10mb', append_dss(protected_large, chain, revocations, []),
            [s.signer_cert for s in PdfFileReader(io.BytesIO(protected_large)).embedded_signatures], 10_000_000, 'Protected signed prefix'),
        ('signed-page-tampered', tampered, roots, 10_000_000, 'Input signature'),
        ('unsigned-page-change', append_dss(small, chain, revocations, [], page_change), roots, 10_000_000, 'Input signature'),
        ('unknown-dss-key', append_dss(small, chain, revocations, [], unknown_dss), roots, 10_000_000, 'Input signature'),
        ('extra-unsigned-revision', extra.getvalue(), roots, 10_000_000, 'More than one unsigned revision'),
        ('document-timestamp', stamped, [], 10_000_000, 'Document timestamps'),
        ('already-compacted-update', output, roots, 10_000_000, 'No smaller output'),
        ('revocation-covered-by-later-signature', signed(positive, second_signer, 'SecondSignature'), roots,
            20_000_000, 'No unsigned update'),
    ]:
        try:
            compact_revocation_update(data, trust, limit)
        except ValueError as exc:
            assert expected in str(exc), (label, str(exc))
            report['rejections'].append({'name': label, 'reason': str(exc)})
            print(label, 'rejected:', str(exc), flush=True)
        else:
            raise AssertionError(label + ': unsafe candidate accepted')
    budget_spec = util.spec_from_file_location('budget_lab', ROOT / 'scripts/inspect-signed-budget.py')
    budget_lab = util.module_from_spec(budget_spec)
    budget_spec.loader.exec_module(budget_lab)
    report['budget_checks'] = []
    for label, data, expected in [
        ('fully-signed', small, 'no_unsigned_tail_to_compress'),
        ('large-unsigned-revocation-update', positive, 'unsigned_tail_needs_structural_inspection'),
        ('signed-prefix-over-limit', protected_large, 'preserving_the_signed_prefix_cannot_meet_this_limit'),
        ('tampered-signature', tampered, 'signature_or_coverage_check_failed'),
        ('timestamp-covered', stamped[:stamped_end], 'no_unsigned_tail_to_compress'),
        ('unsigned-data-after-timestamp', stamped, 'unsigned_tail_needs_structural_inspection'),
    ]:
        result = budget_lab.inspect(data, 10_000_000)
        assert result['verdict'] == expected, (label, result)
        report['budget_checks'].append({'name': label, **result})
    (OUT / 'results.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print('Verified', len(report['cases']), 'candidates,', len(report['rejections']),
          'rejections and', len(report['budget_checks']), 'budget diagnoses.', flush=True)


if __name__ == '__main__':
    run()
