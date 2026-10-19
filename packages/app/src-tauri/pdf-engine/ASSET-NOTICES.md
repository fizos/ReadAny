# Offline asset provenance

Assets are unmodified copies selected by BabelDOC 0.6.2's embedded SHA3-256
metadata. The installer adds a SHA256 manifest. No book, translated page,
translation database, working directory, user settings or credentials are bundled.

The `pdf-offline/licenses` directory contains the fetched original notices and
source URLs/hashes in `provenance.json`. Font copyright and licensing name-table
entries are additionally retained in `font-embedded-notices.json`.

| Asset | Origin and notice |
| --- | --- |
| GoNotoKurrent | satbyy/go-noto-universal; build scripts under Unlicense; underlying Noto font software retains SIL OFL 1.1 |
| SourceHanSans / SourceHanSerif | Pal3love/Source-Han-TrueType, Adobe; SIL OFL 1.1 |
| LXGW WenKai GB/TC | lxgw/LxgwWenKaiGB and lxgw/LxgwWenkaiTC; SIL OFL 1.1 |
| Klee One | fontworks-fonts/Klee; SIL OFL 1.1 |
| Noto Sans / Serif | notofonts/noto-fonts; SIL OFL 1.1 |
| MaruBuri | Naver; Naver font license notice reproduced from the BabelDOC-linked fonts-archive/MaruBuri repository and embedded font metadata |
| Layout ONNX | wybxc/DocLayout-YOLO-DocStructBench-onnx, converted from juliozhao/DocLayout-YOLO-DocStructBench; both model cards declare Apache-2.0 |
| CMaps | Adobe character maps, redistributed as BabelDOC-Assets JSON; Adobe BSD notice retained. All 146 registry identifiers are Adobe-CNS1-7, Adobe-GB1-5, Adobe-Identity-0, Adobe-Japan1-7, Adobe-Korea1-2 or Adobe-KR-9. BabelDOC's CMap parser identifies Adobe's cmap-resources as its source. |
| Tokenizer cache | OpenAI o200k_base.tiktoken, https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken; tiktoken MIT notice retained |

Exact asset hashes are in `pdf-offline/manifest.json`. Source packages for
BabelDOC, PDFMathTranslate-next, PyMuPDF and Levenshtein accompany this build
under `fix-build/pdf-engine-v7-sources`. Their original files are not modified;
ReadAny's process-local adapter source is shipped in `pdf-engine/worker.py`.

This inventory is for the local experimental build, not a claim that every
possible downstream distribution or commercial use is legally reviewed.
