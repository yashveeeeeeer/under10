"""Generate the committed production regression fixtures. No keys leave memory."""
from pathlib import Path
from importlib import util
import gzip
import io
import json

ROOT = Path(__file__).resolve().parents[1]
spec = util.spec_from_file_location('lab', ROOT / 'scripts/research-dsc-revocation.py')
lab = util.module_from_spec(spec)
spec.loader.exec_module(lab)


def run():
    root_key = lab.rsa.generate_private_key(public_exponent=65537, key_size=2048)
    root = lab.issue('ROOT (not licensed)', root_key, ca=True)
    ca_key = lab.rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ca = lab.issue('ISSUING CA', ca_key, root, root_key, ca=True)
    rsa_key = lab.rsa.generate_private_key(public_exponent=65537, key_size=2048)
    rsa_cert = lab.issue('RSA signer', rsa_key, ca, ca_key)
    ec_key = lab.ec.generate_private_key(lab.ec.SECP256R1())
    ec_cert = lab.issue('ECDSA signer', ec_key, ca, ca_key)
    chain = [lab.ax509.Certificate.load(c.public_bytes(lab.DER)) for c in (root, ca, rsa_cert, ec_cert)]
    revocations = [lab.crl(root, root_key), lab.crl(ca, ca_key, 60_000)]
    ocsp_ca = lab.response(ca, root, root_key)
    folder = ROOT / 'tests/data'
    (folder / 'revocation-test-root.der').write_bytes(root.public_bytes(lab.DER))
    manifest = []
    for name, cert, key, padding, crls in [
        ('rsa-crl-ocsp', rsa_cert, rsa_key, 9_200_000, revocations),
        ('rsa-ocsp', rsa_cert, rsa_key, 0, []),
        ('ecdsa-crl-ocsp', ec_cert, ec_key, 0, revocations),
    ]:
        prefix = lab.signed(lab.unsigned(padding), lab.signer(cert, key, chain[:2]))
        data = lab.append_dss(prefix, chain, crls, [ocsp_ca, lab.response(cert, ca, ca_key)])
        label = 'revocation-' + name
        (folder / (label + '.pdf.gz')).write_bytes(gzip.compress(data, mtime=0))
        manifest.append({'name': label, 'input_bytes': len(data), 'signed_bytes': len(prefix),
                         'certificates': 4, 'crls': len(crls), 'ocsps': 2})
    # Both signatures survive only in the lab's broader profile. The public
    # worker must keep rejecting this case rather than bypass its field policy.
    multi = lab.signed(prefix, lab.signer(rsa_cert, rsa_key, chain[:2]), 'SecondSignature')
    data = lab.append_dss(multi, chain, revocations, [ocsp_ca, lab.response(rsa_cert, ca, ca_key), lab.response(ec_cert, ca, ca_key)])
    (folder / 'revocation-multiple.pdf.gz').write_bytes(gzip.compress(data, mtime=0))
    (folder / 'revocation-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(manifest, indent=2))


if __name__ == '__main__':
    run()
