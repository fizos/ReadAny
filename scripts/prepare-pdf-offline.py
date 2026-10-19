"""Build an offline payload from hash-locked wheels and approved public assets.

Download wheels first with pip download --require-hashes --only-binary=:all:
against pdf-engine/requirements.lock using bundled Windows Python 3.12.
Never copy an existing environment, translation database or document cache.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil

parser = argparse.ArgumentParser()
parser.add_argument('--assets', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent / 'packages/app/src-tauri'
resources = root / 'pdf-engine'
payload = root / 'pdf-offline'
spec = importlib.util.spec_from_file_location('worker', resources / 'worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
if not list((payload / 'wheels').glob('*.whl')):
    raise SystemExit('Download the locked wheelhouse first')
source = Path(args.assets).resolve()
for category in ('fonts', 'models', 'cmap', 'tiktoken'):
    for path in sorted((source / category).rglob('*')):
        if not path.is_file():
            continue
        target = payload / 'assets' / category / path.relative_to(source / category)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
files = {}
for category in ('wheels', 'assets', 'licenses'):
    for path in sorted((payload / category).rglob('*')):
        if path.is_file():
            files[path.relative_to(payload).as_posix()] = worker.file_hash(path)
manifest = dict(version=worker.VERSION, lock=worker.file_hash(resources / 'requirements.lock'), files=files)
(payload / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
print(f'Offline payload: {len(files)} files, {sum((payload / p).stat().st_size for p in files) / 2**20:.1f} MiB')
