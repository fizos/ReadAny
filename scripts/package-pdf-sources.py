"""Package build sources, excluding runtime caches, credentials and documents."""
from pathlib import Path
import subprocess
import zipfile
import hashlib
import json
import argparse

parser = argparse.ArgumentParser()
parser.add_argument('--version', choices=['v7', 'v8', 'v9', 'v10', 'v11', 'v12', 'v13', 'v14'], default='v7')
version = parser.parse_args().version

root = Path(__file__).resolve().parent.parent
files = set(subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')) - {''}
for folder in ('packages/app/src-tauri/pdf-engine', 'packages/app/src/components/reader/immersive-translation', 'scripts'):
    for path in (root/folder).rglob('*'):
        if path.is_file() and '__pycache__' not in path.parts:
            files.add(path.relative_to(root).as_posix())
for file in ('packages/app/src-tauri/src/pdf_engine.rs', 'packages/app/src-tauri/tauri.windows.conf.json',
             'packages/app/src/lib/reader/theme.ts',
             'packages/app/src/lib/reader/theme.test.ts',
             'packages/app/vitest.reader.config.ts',
             'packages/core/src/translation/book-context.ts',
             'packages/core/src/translation/book-context.test.ts',
             'packages/core/src/translation/book-context.live.test.ts',
             'packages/core/src/translation/cache.test.ts', 'packages/core/src/translation/chapter-translator.test.ts'):
    files.add(file)
target = root/f'fix-build/pdf-engine-{version}-sources/ReadAny-{version}-build-sources.zip'
target.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in sorted(files):
        path = root/name
        if path.is_file():
            archive.write(path, 'ReadAny-v1.3.6/'+name)
print('Packaged', len(files), 'source entries')
hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in target.parent.iterdir()
          if p.is_file() and p.name != 'SHA256SUMS.json'}
(target.parent/'SHA256SUMS.json').write_text(json.dumps(hashes, indent=2), encoding='utf-8')
