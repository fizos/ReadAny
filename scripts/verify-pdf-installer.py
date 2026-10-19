"""Check an extracted NSIS payload before running its offline smoke test."""
import argparse
import importlib.util
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('directory')
args = parser.parse_args()
packed = Path(args.directory).resolve()
root = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('packed_worker', packed/'pdf-engine/worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
assert worker.file_hash(packed/'pdf-engine/worker.py') == worker.file_hash(root/'packages/app/src-tauri/pdf-engine/worker.py')
for filename in ('pdf-runtime/python.exe', 'pdf-runtime/uv.exe', 'pdf-engine/requirements.lock'):
    assert (packed/filename).is_file(), filename
manifest = worker.verify_offline_payload(packed/'pdf-offline', packed/'pdf-engine')
counts = {key: sum(name.startswith(key + '/') for name in manifest['files']) for key in ('wheels', 'assets', 'licenses')}
assert counts['wheels'] == 133 and counts['assets'] == 182 and counts['licenses'] >= 20, counts
assert not any(name.endswith(('.pdf', '.db')) or '/working/' in name for name in manifest['files'])
print('PASS: packed worker matches source; all offline hashes verified;', counts)
