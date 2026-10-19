"""Verify a relocated, signed macOS arm64 ReadAny PDF payload.

The verifier intentionally runs on macOS only.  It checks the lock/payload
hashes, the runtime hashes recorded after ad-hoc signing, Mach-O architecture,
minimum macOS metadata, and the app's deep code signature.  With ``--smoke``
it copies the app to a Unicode-and-space path and runs setup plus the offline
asset preparation protocol against the embedded resources.  No translation
request, API key, user setting, or book is needed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile


MINIMUM_MACOS = (14, 0)


def fail(message: str) -> "NoReturn":
    raise SystemExit(f"verify-pdf-macos: {message}")


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def run(command: list[str], *, timeout: int = 60, capture: bool = False) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(command, check=True, timeout=timeout, text=True,
                              capture_output=capture)
    except FileNotFoundError as error:
        fail(f"required macOS verifier tool is missing: {error.filename}")
    except subprocess.TimeoutExpired:
        fail(f"command timed out: {' '.join(command)}")
    except subprocess.CalledProcessError as error:
        detail = error.stderr.strip() if capture and error.stderr else ""
        fail(f"command failed: {' '.join(command)} {detail}")
    raise AssertionError("unreachable")


def require_native_arm64() -> None:
    if platform.system() != "Darwin" or platform.machine().lower() not in {"arm64", "aarch64"}:
        fail("must run on a native macOS arm64 host")


def is_macho(path: Path) -> bool:
    if path.is_symlink() or not path.is_file():
        return False
    try:
        with path.open("rb") as stream:
            magic = stream.read(4)
    except OSError:
        return False
    return magic in {
        b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf",
        b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca",
        b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca",
    }


def native_files(root: Path) -> list[Path]:
    return [path for path in sorted(root.rglob("*")) if is_macho(path)]


def verify_native_architecture(root: Path) -> list[Path]:
    files = native_files(root)
    if not files:
        fail(f"no Mach-O files found under {root}")
    for path in files:
        result = run(["lipo", "-archs", str(path)], capture=True)
        architectures = set(result.stdout.strip().split())
        if "arm64" not in architectures or architectures - {"arm64", "x86_64"}:
            fail(f"native file is not arm64-compatible: {path} ({result.stdout.strip()})")
    for path in root.rglob("*"):
        if path.is_file() and path.suffix.lower() in {".exe", ".dll", ".pyd"}:
            fail(f"Windows native file leaked into macOS app: {path}")
    return files


def verify_hashes(resources: Path) -> dict:
    engine = resources / "pdf-engine"
    payload = resources / "pdf-offline"
    runtime = resources / "pdf-runtime"
    lock = engine / "requirements.macos-arm64.lock"
    manifest_path = payload / "manifest.json"
    for path in (engine / "worker.py", lock, manifest_path, runtime / "uv", runtime / "bin/python3"):
        if not path.exists() and not path.is_symlink():
            fail(f"missing embedded PDF resource: {path}")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        fail(f"invalid payload manifest: {error}")
    if manifest.get("platform") != "macos-arm64":
        fail(f"payload platform is {manifest.get('platform')!r}, expected macos-arm64")
    if manifest.get("lock") != digest(lock):
        fail("payload lock hash does not match embedded macOS lock")
    files = manifest.get("files")
    if not isinstance(files, dict) or not files:
        fail("payload manifest has no file hashes")
    for name, expected in files.items():
        path = payload / name
        if not name.startswith(("wheels/", "assets/", "licenses/")) or not path.resolve().is_relative_to(payload.resolve()):
            fail(f"unsafe payload manifest path: {name}")
        if not path.is_file() or digest(path) != expected:
            fail(f"payload hash mismatch: {name}")
    runtime_hashes = manifest.get("runtime")
    if not isinstance(runtime_hashes, dict) or not runtime_hashes:
        fail("manifest has no post-signature runtime hashes")
    actual_runtime = {
        path.relative_to(runtime).as_posix(): digest(path)
        for path in sorted(runtime.rglob("*"))
        if path.is_file() and not path.is_symlink()
    }
    if actual_runtime != runtime_hashes:
        expected_names = set(runtime_hashes)
        actual_names = set(actual_runtime)
        missing = sorted(expected_names - actual_names)
        extra = sorted(actual_names - expected_names)
        changed = sorted(name for name in expected_names & actual_names if runtime_hashes[name] != actual_runtime[name])
        fail(f"runtime hash mismatch (missing={missing[:3]}, extra={extra[:3]}, changed={changed[:3]})")
    return manifest


def version_tuple(value: str) -> tuple[int, ...]:
    match = re.search(r"(\d+(?:\.\d+)+)", value)
    if not match:
        return ()
    return tuple(int(part) for part in match.group(1).split("."))


def verify_minimum_version(app: Path) -> str:
    info_path = app / "Contents/Info.plist"
    if not info_path.is_file():
        fail(f"missing app Info.plist: {info_path}")
    try:
        info = plistlib.loads(info_path.read_bytes())
    except Exception as error:
        fail(f"invalid app Info.plist: {error}")
    declared = info.get("LSMinimumSystemVersion") or info.get("MinimumOSVersion")
    if not isinstance(declared, str) or version_tuple(declared) < MINIMUM_MACOS:
        fail(f"app minimum system version is {declared!r}, expected >= 14.0")
    binary = app / "Contents/MacOS/app"
    if not binary.is_file():
        fail(f"missing main app executable: {binary}")
    load = run(["otool", "-l", str(binary)], capture=True).stdout
    minos = re.search(r"\bminos\s+(\d+(?:\.\d+)+)", load)
    if minos and version_tuple(minos.group(1)) != MINIMUM_MACOS:
        fail(f"main Mach-O minimum OS is {minos.group(1)}, expected exactly 14.0")
    return declared


def verify_app(app: Path) -> tuple[Path, dict, list[Path]]:
    app = app.resolve()
    if app.suffix != ".app" or not app.is_dir():
        fail(f"expected a .app directory: {app}")
    resources = app / "Contents/Resources"
    manifest = verify_hashes(resources)
    native = verify_native_architecture(app)
    run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", str(app)], timeout=180)
    minimum = verify_minimum_version(app)
    print(json.dumps({"app": str(app), "platform": "macos-arm64", "native_macho_files": len(native),
                      "minimum_macos": minimum, "payload_files": len(manifest["files"])}, indent=2), flush=True)
    return resources, manifest, native


def relocated_smoke(app: Path, source_root: Path) -> None:
    test_script = source_root / "scripts/test-pdf-engine.py"
    if not test_script.is_file():
        fail(f"offline smoke script is missing: {test_script}")
    with tempfile.TemporaryDirectory(prefix="ReadAny macOS PDF smoke ") as temporary_name:
        temporary = Path(temporary_name)
        relocated = temporary / "目录 with spaces" / "ReadAny.app"
        relocated.parent.mkdir(parents=True)
        run(["ditto", str(app), str(relocated)], timeout=300)
        resources = relocated / "Contents/Resources"
        engine = temporary / "PDF 引擎 smoke" / "engine"
        for action in ("setup", "prepare"):
            run([sys.executable, "-B", str(test_script), action, "--resources-root", str(resources),
                 "--engine", str(engine)], timeout=900)
        # The round-trip harness uses a loopback fake provider and synthetic
        # five-entry TOC/blank-page input.  It exercises cached revisit and
        # whole-book export after the embedded environment is prepared, while
        # never reading user settings or making an external request.
        roundtrip = source_root / "scripts/smoke-pdf-roundtrip.py"
        if roundtrip.is_file():
            embedded_python = engine / "env/bin/python"
            if not embedded_python.is_file():
                fail(f"offline setup did not create embedded Python: {embedded_python}")
            run([str(embedded_python), "-I", "-B", str(roundtrip), "--resources-root", str(resources),
                 "--engine", str(engine)], timeout=1200)
        # Check the bundle actually exercised, not just the untouched original.
        verify_app(relocated)
    print("PASS: relocated Unicode/space app completed offline setup and prepare", flush=True)


def main() -> None:
    require_native_arm64()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path, help="built ReadAny.app directory")
    parser.add_argument("--source-root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--smoke", action="store_true", help="run relocated offline setup and prepare")
    args = parser.parse_args()
    app = args.app.resolve()
    verify_app(app)
    if args.smoke:
        relocated_smoke(app, args.source_root.resolve())
        # Relocation must not change the signed source bundle; re-hash and
        # re-verify the original app after the smoke, too.
        verify_app(app)


if __name__ == "__main__":
    main()
