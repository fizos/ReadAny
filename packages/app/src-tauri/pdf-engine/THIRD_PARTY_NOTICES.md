# Optional high-fidelity PDF engine

The ReadAny installer includes the authored worker (AGPL-3.0-or-later), portable
CPython 3.12.11 (Python Software Foundation License, see pdf-runtime/LICENSE.txt),
and uv 0.9.28 (MIT OR Apache-2.0, license texts in this directory).

Sources: https://github.com/python/cpython/tree/v3.12.11,
https://github.com/astral-sh/python-build-standalone,
https://github.com/astral-sh/uv/tree/0.9.28.

The v7 full installer bundles the exact Windows wheels and hashes in
requirements.lock, plus fonts and a layout model. On explicit initialization,
uv installs only from the local wheelhouse into the application's private env.
No runtime dependency downloads are permitted. Original wheel contents are
preserved. See ASSET-NOTICES.md and the accompanying source and license materials.

Key bundled components:
- PDFMathTranslate-next 2.9.0: AGPL-3.0, https://github.com/PDFMathTranslate/PDFMathTranslate-next
- BabelDOC 0.6.2: AGPL-3.0, https://github.com/funstory-ai/BabelDOC
- PyMuPDF 1.25.2: AGPL-3.0, https://github.com/pymupdf/PyMuPDF
- Levenshtein 0.27.5: GPL-2.0-or-later, https://github.com/rapidfuzz/Levenshtein
- ONNX Runtime: MIT, https://github.com/microsoft/onnxruntime
- Assets and their upstream provenance: https://github.com/funstory-ai/BabelDOC-Assets

License texts missing from wheel dist-info are supplied separately under
pdf-offline/licenses (including AGPL and Levenshtein GPL). The authored worker
source and pinned requirements are shipped alongside the application resources.
This build is experimental: complex lists/tables may not exactly match the source.
No OCR support is claimed. Documents and API keys are sent only to the user's
configured AI endpoint; they are not sent to a ReadAny translation service.
