# ReadAny optional high-fidelity PDF mode (Windows, experimental)

This worker integrates PDFMathTranslate-next 2.9.0 and BabelDOC 0.6.2. It is a
separate, optional path: quick immersive translation and EPUB are unchanged.

## User workflow

Open a PDF, choose **高保真 PDF 翻译（实验）** from the translation menu, then
initialize the engine on first use. The v7 full installer includes portable
Python, uv, hash-locked Windows wheels, fonts and the layout model. Initialization
is offline and requires approximately 1.2 GiB beyond the installed application,
plus temporary working space. Translation still connects to the configured AI
endpoint. No system Python configuration is necessary.

The selected AI translation profile is used. If quick mode uses a free provider,
the active AI chat endpoint/model is shown and used instead. Only the current PDF
page is processed; turning pages cancels outdated work. Code detected through
monospace fonts is protected. This is heuristic, not a guarantee for arbitrary
PDFs. Scanned PDFs without text need OCR elsewhere. Complex lists/tables may
still differ from the original, and the two panes fit their available space
independently rather than sharing pixel-level coordinates.

## Packaging

Run `scripts/prepare-pdf-runtime.ps1` with a portable CPython 3.12.11 installation
and the uv 0.9.28 executable. Download the lock's wheels using that Python's
`pip download --require-hashes --only-binary=:all: --dest pdf-offline/wheels -r pdf-engine/requirements.lock`
from the Tauri directory, then use `scripts/prepare-pdf-offline.py --assets ...`
to stage approved assets and their integrity manifest. Finally run
`pnpm tauri build --no-sign --bundles nsis`.
The Windows Tauri config includes `pdf-runtime/` and `pdf-offline/`; base
resources include this worker, locked requirements and license notices.
Keep license texts and corresponding sources with the distribution.
Never include a harvested developer environment, AI settings, books,
translation databases or working directories in an installer.

Initialization verifies payload hashes, creates a private environment with
bundled Python and installs exclusively from the wheelhouse using `uv --offline`
and `--no-index`. Preparation additionally blocks remote socket connections and DNS
(numeric loopback is retained for Windows asyncio's self-pipe), and verifies
native PyMuPDF/ONNX loading, exact engine versions and upstream asset checksums.
Missing/corrupt assets cause an explicit error, never an online fallback.

This build retains `com.readany.app` and version 1.3.6. Installing it upgrades the
existing application at the chosen location, not a side-by-side application.
Creating the installer does not install it or touch the user's library.

## Boundaries and verification

Rust owns a single job, Windows kill-on-close Job Object, time limits (setup 20
minutes, translation 4 minutes), input/output validation and cleanup. Requests
arrive on stdin; API keys never enter arguments, settings files or diagnostic
messages. The worker normalizes JSON/SSE responses, disables automatic retries,
rejects failed/partial results and atomically caches only a validated single-page
PDF. Provider connections are limited to 15 seconds and response reads to 90
seconds of read inactivity; the native four-minute page deadline still applies.
The provider request uses streaming, then normalizes a complete JSON/SSE reply
into the single JSON completion expected by the PDF SDK. A real WPS page-28
paragraph took 67 seconds non-streaming and 131 seconds streaming in separate
tests, exceeding the previous 45-second read limit. Streaming avoids waiting
silently for the full response; it does not make the underlying model faster.
Authentication, rate limits, server errors, network timeouts, malformed responses
and PDF translation failures have distinct safe error categories.
Cache identity includes the source hash, page, language, endpoint, model,
profile and engine version; quota is 50 pages / 200 MiB.

Tests: `test_worker.py` uses only stdlib. Run `test_worker_pdf.py` with the
installed engine Python. `scripts/test-pdf-engine.py` provides an explicit smoke
harness; optional settings are loaded only into memory and never printed.
Native and frontend regression tests cover their own boundaries. Browser pane
checks are not a substitute for installing on a clean Windows machine.
