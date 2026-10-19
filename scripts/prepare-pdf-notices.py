"""Fetch redistribution notices and exact copyleft source archives for the offline build.

Build-time only. Does not access application settings, books or user caches.
"""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import urllib.request

root = Path(__file__).resolve().parent.parent
licenses = root / 'packages/app/src-tauri/pdf-offline/licenses'
sources = root / 'fix-build/pdf-engine-v7-sources'
archives = [
 ('mupdf-1.25.2-source.tar.gz', 'https://mupdf.com/downloads/archive/mupdf-1.25.2-source.tar.gz', '36ccf6a5e691e188acf8db6e98d08bf05f27bb4ce30432dc15fc76d329a92d4d'),
 ('babeldoc-0.6.2.tar.gz', 'https://files.pythonhosted.org/packages/5e/2b/e0f23e7fde25a7d9b90ff219ca60c220105552ec96f290a5dfaadabe4590/babeldoc-0.6.2.tar.gz', 'b2b2769aa9f8372b35071b46788da531ebb58bc3cf31ab4dbb5deb06e9424026'),
 ('pdf2zh_next-2.9.0.tar.gz', 'https://files.pythonhosted.org/packages/87/5e/d971946ec7ad3e0b0aeada46e323485e7b2fb29ed5285b0d854e285b9d8d/pdf2zh_next-2.9.0.tar.gz', 'cadd8380eb8b3c06427f04e4c4a3a3bafc56a2a6b5e2293f9b5ad07c3c3011dd'),
 ('pymupdf-1.25.2.tar.gz', 'https://files.pythonhosted.org/packages/40/fc/dd8776dc5c2f8cf0e51cf81a5f1de3840996bed7ca03ec768b0733024fb9/pymupdf-1.25.2.tar.gz', '9ea88ff1b3ccb359620f106a6fd5ba6877d959d21d78272052c3496ceede6eec'),
 ('levenshtein-0.27.5.tar.gz', 'https://files.pythonhosted.org/packages/81/ab/d55fdebfdee7605df174913708d44f75dfec0ec5e4e5fd8e978bb88897eb/levenshtein-0.27.5.tar.gz', '22021caf5867a46fae5ab927bbdcb430599d7e5ee3898449cbbe430ff07b7d08'),
]
notices = {
 'Adobe-CMap-LICENSE.txt': ['https://raw.githubusercontent.com/adobe-type-tools/cmap-resources/master/LICENSE.md'],
 'Go-Noto-UNLICENSE.txt': ['https://raw.githubusercontent.com/satbyy/go-noto-universal/master/UNLICENSE.txt'],
 'Source-Han-OFL.txt': ['https://raw.githubusercontent.com/Pal3love/Source-Han-TrueType/master/LICENSE.txt'],
 'LXGW-GB-OFL.txt': ['https://raw.githubusercontent.com/lxgw/LxgwWenKaiGB/main/OFL.txt'],
 'LXGW-TC-OFL.txt': ['https://raw.githubusercontent.com/lxgw/LxgwWenkaiTC/main/OFL.txt'],
 'Klee-OFL.txt': ['https://raw.githubusercontent.com/fontworks-fonts/Klee/master/OFL.txt'],
 'MaruBuri-README.md': ['https://raw.githubusercontent.com/fonts-archive/MaruBuri/main/README.md'],
 'Noto-OFL.txt': ['https://raw.githubusercontent.com/notofonts/noto-fonts/main/LICENSE', 'https://raw.githubusercontent.com/googlefonts/noto-fonts/main/LICENSE'],
 'BabelDOC-Assets-README.md': ['https://raw.githubusercontent.com/funstory-ai/BabelDOC-Assets/main/README.md'],
 'PDFMiner-LICENSE.txt': ['https://raw.githubusercontent.com/pdfminer/pdfminer.six/master/LICENSE'],
 'tiktoken-LICENSE.txt': ['https://raw.githubusercontent.com/openai/tiktoken/main/LICENSE'],
 'DocLayout-model-card.md': ['https://huggingface.co/wybxc/DocLayout-YOLO-DocStructBench-onnx/raw/main/README.md'],
 'DocLayout-upstream-model-card.md': ['https://huggingface.co/juliozhao/DocLayout-YOLO-DocStructBench/raw/main/README.md'],
}

def fetch(task):
    folder, name, urls, expected = task
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / name
    if expected and path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == expected:
        return dict(file=name, url=urls[0], sha256=expected)
    for url in urls:
        try:
            with urllib.request.urlopen(url, timeout=60) as response:
                data = response.read()
            digest = hashlib.sha256(data).hexdigest()
            if expected and digest != expected:
                raise ValueError('archive checksum mismatch')
            path.write_bytes(data)
            print('Fetched ' + name, flush=True)
            return dict(file=name, url=url, sha256=digest)
        except Exception as error:
            last = type(error).__name__
    print('FAILED ' + name + ': ' + last, flush=True)
    return dict(file=name, failed=True)

if __name__ == '__main__':
    tasks = [(sources, name, [url], checksum) for name, url, checksum in archives]
    tasks += [(licenses, name, urls, None) for name, urls in notices.items()]
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(fetch, tasks))
    licenses.mkdir(parents=True, exist_ok=True)
    (licenses / 'provenance.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
    if any(x.get('failed') for x in results):
        raise SystemExit(1)
