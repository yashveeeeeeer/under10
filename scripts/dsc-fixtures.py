"""Certificate-chain compatibility cases. These are NOT licensed Indian DSCs.

Private keys are generated in memory and discarded. Only test PDFs and public
certificates are written, under tmp/qa/dsc. No app or public-page content changes.
"""
from pathlib import Path
from datetime import datetime, timedelta, timezone
import io
import json
import sys

ROOT = Path(__file__).resolve().parents[1]
for directory in ('tmp/qa-python', 'tmp/research-python'):
    sys.path.insert(0, str(ROOT / directory))
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa, ec
from asn1crypto import keys, x509 as asn_x509
from pyhanko.pdf_utils import generic
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.sign import signers
from pyhanko.sign.fields import SigFieldSpec, SigSeedSubFilter, MDPPerm
from pyhanko_certvalidator.registry import SimpleCertificateStore
from reportlab.pdfgen import canvas

OUT = ROOT / 'tmp/qa/dsc'
OUT.mkdir(parents=True, exist_ok=True)
now = datetime.now(timezone.utc)

def issue(label, key, issuer_cert=None, issuer_key=None, ca=False, path_length=None):
    subject = x509.Name([x509.NameAttribute(NameOID.ORGANIZATION_NAME, 'Under10 test certificates only'),
                        x509.NameAttribute(NameOID.COMMON_NAME, label)])
    builder = (x509.CertificateBuilder().subject_name(subject)
               .issuer_name(issuer_cert.subject if issuer_cert else subject).public_key(key.public_key())
               .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(days=1))
               .not_valid_after(now + timedelta(days=3650))
               .add_extension(x509.BasicConstraints(ca=ca, path_length=path_length), critical=True)
               .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
               .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key((issuer_key or key).public_key()), critical=False)
               .add_extension(x509.KeyUsage(digital_signature=not ca, content_commitment=not ca,
                    key_encipherment=False, data_encipherment=False, key_agreement=False,
                    key_cert_sign=ca, crl_sign=ca, encipher_only=None, decipher_only=None), critical=True))
    return builder.sign(issuer_key or key, hashes.SHA256())

root_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
root_cert = issue('TEST ROOT - not a public CA', root_key, ca=True, path_length=1)
inter_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
inter_cert = issue('TEST ISSUING CA', inter_key, root_cert, root_key, ca=True, path_length=0)
to_asn = lambda cert: asn_x509.Certificate.load(cert.public_bytes(serialization.Encoding.DER))
root, intermediate = to_asn(root_cert), to_asn(inter_cert)
(OUT / 'test-root.der').write_bytes(root.dump())
registry = SimpleCertificateStore(); registry.register_multiple([intermediate, root])

def unsigned(large=False):
    buf = io.BytesIO(); c = canvas.Canvas(buf, pageCompression=0 if large else 1)
    c.setTitle('Certificate-signature compatibility check')
    c.drawString(55, 780, 'Certificate-signature compatibility check')
    c.drawString(55, 752, 'Test document. No personal or filing data.')
    c.drawString(55, 725, 'Check the visible signature and cryptographic integrity.')
    if large: c._code.append('%' + 'size-test ' * 1_010_000)
    c.save(); return buf.getvalue()

def sign(data, signer, subfilter, field='CertificateSignature', certify=False):
    out = io.BytesIO()
    signers.sign_pdf(IncrementalPdfFileWriter(io.BytesIO(data)),
        signature_meta=signers.PdfSignatureMetadata(field_name=field, md_algorithm='sha256',
            subfilter=subfilter, certify=certify, docmdp_permissions=MDPPerm.NO_CHANGES,
            reason='Test certificate compatibility'), signer=signer,
        new_field_spec=SigFieldSpec(sig_field_name=field, box=(55, 590 if field == 'SecondSignature' else 635, 410, 630 if field == 'SecondSignature' else 700)), output=out)
    return out.getvalue()

def add_certificates(data, chain, update_metadata=False):
    writer = IncrementalPdfFileWriter(io.BytesIO(data))
    certs = generic.ArrayObject([writer.add_object(generic.StreamObject(stream_data=cert.dump())) for cert in chain])
    writer.root[generic.pdf_name('/DSS')] = writer.add_object(generic.DictionaryObject({generic.pdf_name('/Certs'): certs}))
    writer.update_root(); out = io.BytesIO()
    # Pinned pyHanko lab API: avoid its automatic XMP update in the eligible
    # certificate-only case. Test that automatic XMP update separately below.
    if update_metadata: writer.write(out)
    else: writer._write(out)
    return out.getvalue()

manifest = []
def save(label, data, expected, **extra):
    (OUT / f'{label}.pdf').write_bytes(data)
    manifest.append({'name': label, 'input_bytes': len(data), 'expected': expected, **extra})

for label, key, subfilter in [
    ('rsa2048-cms', rsa.generate_private_key(public_exponent=65537, key_size=2048), SigSeedSubFilter.ADOBE_PKCS7_DETACHED),
    ('rsa3072-pades', rsa.generate_private_key(public_exponent=65537, key_size=3072), SigSeedSubFilter.PADES),
    ('ecdsa-p256-pades', ec.generate_private_key(ec.SECP256R1()), SigSeedSubFilter.PADES),
]:
    cert = to_asn(issue('TEST SIGNER ' + label, key, inter_cert, inter_key))
    signer = signers.SimpleSigner(signing_cert=cert,
        signing_key=keys.PrivateKeyInfo.load(key.private_bytes(serialization.Encoding.DER,
            serialization.PrivateFormat.PKCS8, serialization.NoEncryption())), cert_registry=registry)
    signed = sign(unsigned(), signer, subfilter)
    save(label, signed, 'unchanged', subfilter=subfilter.value, certificates_in_chain=3)
    save(label + '-certs', add_certificates(signed, [cert, intermediate, root]), 'compressed',
         prefix_file=label + '.pdf', subfilter=subfilter.value, certificates_in_chain=3)
    if label.startswith('ecdsa'):
        save(label + '-certs-and-xmp', add_certificates(signed, [cert, intermediate, root], update_metadata=True), 'unchanged')
    if label == 'rsa2048-cms':
        save('rsa2048-oversized', sign(unsigned(True), signer, subfilter), 'blocked')
        save('rsa2048-certified', sign(unsigned(), signer, subfilter, certify=True), 'unchanged')
        save('rsa2048-two-signatures', sign(signed, signer, subfilter, field='SecondSignature'), 'unchanged')
(OUT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
print(json.dumps(manifest, indent=2))
