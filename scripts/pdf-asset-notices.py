"""Preserve copyright/license metadata embedded in unmodified bundled fonts."""
import json
from pathlib import Path
import tarfile
import hashlib
from fontTools.ttLib import TTFont

root = Path(__file__).resolve().parent.parent
payload = root/'packages/app/src-tauri/pdf-offline'
records = {}
for path in sorted((payload/'assets/fonts').glob('*.ttf')):
    with TTFont(path, lazy=True) as font:
        records[path.name] = {str(key): sorted({record.toUnicode() for record in font['name'].names if record.nameID == key})
                              for key in (0, 7, 8, 9, 13, 14)}
(payload/'licenses/font-embedded-notices.json').write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding='utf-8')
with tarfile.open(root/'fix-build/pdf-engine-v7-sources/levenshtein-0.27.5.tar.gz') as archive:
    (payload/'licenses/Levenshtein-GPL.txt').write_bytes(archive.extractfile('levenshtein-0.27.5/LICENSE').read())
print('Preserved embedded notices for', len(records), 'fonts and Levenshtein GPL text')
for filename, member, target in (
    ('babeldoc-0.6.2.tar.gz', 'babeldoc-0.6.2/LICENSE', 'BabelDOC-LICENSE.txt'),
    ('pdf2zh_next-2.9.0.tar.gz', 'pdf2zh_next-2.9.0/LICENSE', 'PDFMathTranslate-LICENSE.txt'),
    ('pymupdf-1.25.2.tar.gz', 'pymupdf-1.25.2/COPYING', 'PyMuPDF-COPYING.txt'),
    ('mupdf-1.25.2-source.tar.gz', 'mupdf-1.25.2-source/COPYING', 'MuPDF-COPYING.txt'),
):
    with tarfile.open(root/'fix-build/pdf-engine-v7-sources'/filename) as archive:
        (payload/'licenses'/target).write_bytes(archive.extractfile(member).read())
