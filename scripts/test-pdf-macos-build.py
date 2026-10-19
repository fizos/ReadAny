"""Cross-platform checks for the macOS payload builder; never stage a runtime."""
import importlib.util
import io
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name+'.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


builder = load('prepare-pdf-macos')
verifier = load('verify-pdf-macos')


class BuildTests(unittest.TestCase):
    def test_wrong_platform_fails_before_staging(self):
        with patch.object(builder.platform, 'system', return_value='Windows'), self.assertRaises(SystemExit):
            builder.require_native_arm64()

    def test_public_asset_categories(self):
        for path, expected in [('fonts/book.ttf', 'fonts'), ('models/layout.onnx', 'models'),
                               ('cmap/78-H.json', 'cmap'), ('tiktoken/hash', 'tiktoken'), ('private.sqlite', None)]:
            self.assertEqual(builder.classify_asset(Path(path)), expected)

    def test_archive_traversal_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive = root/'unsafe.tar.gz'
            with tarfile.open(archive, 'w:gz') as stream:
                member = tarfile.TarInfo('../escape')
                member.size = 1
                stream.addfile(member, io.BytesIO(b'x'))
            with self.assertRaises(SystemExit):
                builder.safe_extract_tar(archive, root/'unpacked')
            self.assertFalse((root/'escape').exists())

    def test_absolute_internal_symlink_is_relocated(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root/'source'
            source.mkdir()
            (source/'python3.12').write_bytes(b'python')
            try:
                (source/'python3').symlink_to(source/'python3.12')
            except OSError:
                self.skipTest('host does not allow symlink creation')
            destination = root/'relocated'
            builder.copy_tree_preserving_relative_links(source, destination)
            self.assertFalse(os.path.isabs(os.readlink(destination/'python3')))
            self.assertEqual((destination/'python3').resolve(), destination/'python3.12')

    def test_signed_runtime_manifest_detects_mutations(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            engine, runtime, payload = root/'pdf-engine', root/'pdf-runtime', root/'pdf-offline'
            engine.mkdir()
            (engine/'requirements.macos-arm64.lock').write_text('lock')
            (engine/'worker.py').write_text('VERSION = "fixture"\n')
            (runtime/'bin').mkdir(parents=True)
            (runtime/'uv').write_bytes(b'uv')
            (runtime/'bin/python3').write_bytes(b'python')
            (payload/'wheels').mkdir(parents=True)
            (payload/'wheels/demo.whl').write_bytes(b'wheel')
            builder.write_manifest(engine, runtime, payload)
            manifest = verifier.verify_hashes(root)
            self.assertEqual(manifest['platform'], 'macos-arm64')
            (runtime/'uv').write_bytes(b'changed-signature')
            with self.assertRaises(SystemExit):
                verifier.verify_hashes(root)

    def test_standalone_site_packages_are_not_shipped(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root/'source'
            packages = source/'lib/python3.12/site-packages/pip'
            packages.mkdir(parents=True)
            (packages/'windows-launcher.exe').write_bytes(b'build-tool')
            (source/'bin').mkdir()
            (source/'bin/pip3').write_bytes(b'build-tool')
            (source/'bin/python3').write_bytes(b'interpreter')
            destination = root/'runtime'
            builder.copy_tree_preserving_relative_links(source, destination)
            self.assertEqual((destination/'bin/python3').read_bytes(), b'interpreter')
            self.assertFalse((destination/'bin/pip3').exists())
            self.assertEqual(list((destination/'lib/python3.12/site-packages').iterdir()), [])


if __name__ == '__main__':
    unittest.main()
