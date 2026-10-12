"""Read-only, offline size diagnosis. Writes no PDF, report file or upload.

This is a research tool, not a trust/expiry/revocation or portal validator.
An unsigned tail is an opportunity to inspect, not permission to discard it.
"""
from pathlib import Path
import argparse
import io
import json
import logging
import sys

ROOT = Path(__file__).resolve().parents[1]
for directory in ('tmp/qa-python', 'tmp/research-python'):
    sys.path.insert(0, str(ROOT / directory))
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.validation import validate_pdf_signature, validate_pdf_timestamp
from pyhanko_certvalidator import ValidationContext

logging.basicConfig(level=logging.CRITICAL)


def inspect(data, limit):
    if len(data) > 40_000_000:
        raise ValueError('Input exceeds the 40 MB research limit')
    reader = PdfFileReader(io.BytesIO(data), strict=True)
    if reader.encrypted:
        raise ValueError('Encrypted input is unsupported')
    results = []
    for sig in reader.embedded_signatures:
        ranges = list(map(int, sig.byte_range))
        if not (len(ranges) == 4 and ranges[0] == 0 and 0 < ranges[1] < ranges[2]
                and ranges[3] > 0 and ranges[2] + ranges[3] <= len(data)):
            raise ValueError('Signature byte ranges are unsupported or invalid')
        context = ValidationContext(trust_roots=[], allow_fetching=False)
        timestamp = sig.sig_object.get('/Type') == '/DocTimeStamp'
        status = (validate_pdf_timestamp(sig, validation_context=context) if timestamp
                  else validate_pdf_signature(sig, signer_validation_context=context))
        results.append({'kind': 'document_timestamp' if timestamp else 'approval_or_certification',
            'signed_revision_end': ranges[2] + ranges[3], 'content_digest_intact': status.intact,
            'signature_math_valid': status.valid,
            'coverage': status.coverage.name if status.coverage else None,
            'modification_policy_ok': None if timestamp else status.docmdp_ok})
    if not results:
        raise ValueError('No embedded signatures found')
    floor = max(s['signed_revision_end'] for s in results)
    checks = all(s['content_digest_intact'] and s['signature_math_valid']
                 and s['coverage'] in ('ENTIRE_FILE', 'ENTIRE_REVISION')
                 and s['modification_policy_ok'] is not False for s in results)
    if not checks:
        verdict = 'signature_or_coverage_check_failed'
    elif floor >= limit:
        verdict = 'preserving_the_signed_prefix_cannot_meet_this_limit'
    elif floor == len(data):
        verdict = 'no_unsigned_tail_to_compress'
    else:
        verdict = 'unsigned_tail_needs_structural_inspection'
    return {'input_bytes': len(data), 'strict_target_bytes': limit, 'signatures': results,
        'preserved_prefix_floor_bytes': floor, 'unsigned_tail_bytes': len(data) - floor,
        'verdict': verdict, 'certificate_trust_checked': False,
        'note': 'The prefix floor applies to preserving existing signed revisions byte for byte. '
                'Unsigned bytes may still be essential and cannot be discarded without inspection.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pdf', type=Path)
    parser.add_argument('--limit', type=int, default=10_000_000, help='Strict target in decimal bytes')
    args = parser.parse_args()
    if args.limit <= 0:
        parser.error('--limit must be a positive byte count')
    try:
        if args.pdf.stat().st_size > 40_000_000:
            raise ValueError('Input exceeds the 40 MB research limit')
        print(json.dumps(inspect(args.pdf.read_bytes(), args.limit), indent=2))
    except Exception as exc:
        print(json.dumps({'error': str(exc)}), file=sys.stderr)
        sys.exit(1)
