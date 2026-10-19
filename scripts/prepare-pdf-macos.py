"""Build the relocatable Apple Silicon PDF engine payload.

This is deliberately a macOS arm64-only build tool.  It never reuses the
developer's Python installation, uv cache, application settings, books, or a
Windows runtime.  CI invokes it on a native ``macos-15`` runner and then
signs the runtime before Tauri copies it into the application bundle.

The two useful modes are::

    python scripts/prepare-pdf-macos.py --sign-runtime
    python scripts/prepare-pdf-macos.py --manifest-only

The first mode downloads the pinned uv release, installs the pinned
python-build-standalone interpreter into a temporary directory using uv,
downloads binary-only wheels from the macOS lock, warms BabelDOC's public
assets in a temporary environment, and writes the runtime/payload.  The
second mode is used after notices/source archives have been added to refresh
the final hash manifest without downloading anything.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from typing import Iterable
from urllib.request import Request, urlopen


UV_VERSION = "0.9.28"
UV_ARCHIVE = f"uv-aarch64-apple-darwin.tar.gz"
UV_URL = f"https://github.com/astral-sh/uv/releases/download/{UV_VERSION}/{UV_ARCHIVE}"
UV_SHA256 = "12163fe09eb292d3ad1ea0f132a84485c902e2ff360d57562bf676e6615fcba0"
PYTHON_VERSION = "3.12.11"
MACOS_MINIMUM = "14.0"
PLATFORM_NAME = "macos-arm64"


def fail(message: str) -> "NoReturn":
    raise SystemExit(f"prepare-pdf-macos: {message}")


def require_native_arm64() -> None:
    """Fail before touching any destination path on the wrong host."""
    if platform.system() != "Darwin" or platform.machine().lower() not in {"arm64", "aarch64"}:
        fail("must run on a native macOS arm64 host; refusing to touch a Windows runtime")


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def run(command: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> None:
    printable = " ".join(command)
    print(f"+ {printable}", flush=True)
    try:
        subprocess.run(command, cwd=cwd, env=env, check=True)
    except FileNotFoundError as error:
        fail(f"required tool is missing: {error.filename}")
    except subprocess.CalledProcessError as error:
        fail(f"command failed with exit code {error.returncode}: {command[0]}")


def download(url: str, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    request = Request(url, headers={"User-Agent": "ReadAny-macOS-pdf-build"})
    with urlopen(request, timeout=120) as response, target.open("wb") as output:
        shutil.copyfileobj(response, output)


def safe_extract_tar(archive: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    root = destination.resolve()
    with tarfile.open(archive, "r:gz") as stream:
        for member in stream.getmembers():
            target = (destination / member.name).resolve()
            if not target.is_relative_to(root):
                fail(f"unsafe path in uv archive: {member.name}")
            if member.issym() or member.islnk():
                link_target = (target.parent / member.linkname).resolve()
                if not link_target.is_relative_to(root):
                    fail(f"unsafe link in uv archive: {member.name}")
            stream.extract(member, destination)


def locate_uv(extracted: Path) -> Path:
    candidates = sorted(path for path in extracted.rglob("uv") if path.is_file())
    if len(candidates) != 1:
        fail(f"expected one uv binary in {UV_ARCHIVE}, found {len(candidates)}")
    return candidates[0]


def locate_python(install_dir: Path) -> Path:
    candidates = sorted(path for path in install_dir.rglob("python3") if path.is_file() or path.is_symlink())
    candidates = [path for path in candidates if "bin" in path.parts]
    if len(candidates) != 1:
        fail(f"expected one managed Python 3 interpreter, found {len(candidates)}")
    return candidates[0]


def copy_tree_preserving_relative_links(source: Path, destination: Path) -> None:
    source = source.resolve()
    for link in source.rglob("*"):
        if not link.is_symlink():
            continue
        target = link.resolve()
        if not target.is_relative_to(source):
            fail(f"managed Python contains an absolute/out-of-tree symlink: {link}")
    def ignore_build_tools(folder, names):
        folder = Path(folder)
        if folder.name == "site-packages":
            return names  # Runtime dependencies live only in the private venv.
        if folder == source / "bin":
            return [name for name in names if name == "pip" or name.startswith("pip3")]
        return []
    shutil.copytree(source, destination, symlinks=True, copy_function=shutil.copy2,
                    ignore=ignore_build_tools)
    # A managed installation may contain an absolute link to its own root.
    # Rewrite that link before deleting the build-time managed directory.
    for link in source.rglob("*"):
        if link.is_symlink() and os.path.isabs(os.readlink(link)):
            copied = destination / link.relative_to(source)
            if not copied.is_symlink():
                continue
            target = destination / link.resolve().relative_to(source)
            copied.unlink()
            copied.symlink_to(os.path.relpath(target, copied.parent))


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


def sign_runtime(runtime: Path) -> list[Path]:
    files = native_files(runtime)
    if not files:
        fail(f"no Mach-O files found in {runtime}")
    for path in files:
        run(["codesign", "--force", "--sign", "-", "--timestamp=none", str(path)])
        run(["codesign", "--verify", "--strict", str(path)])
    return files


def verify_runtime_architecture(runtime: Path) -> list[Path]:
    files = native_files(runtime)
    if not files:
        fail(f"runtime has no Mach-O files: {runtime}")
    for path in files:
        try:
            result = subprocess.run(["lipo", "-archs", str(path)], check=True,
                                    capture_output=True, text=True)
        except (FileNotFoundError, subprocess.CalledProcessError) as error:
            fail(f"cannot inspect runtime architecture for {path}: {error}")
        architectures = set(result.stdout.strip().split())
        if "arm64" not in architectures or architectures - {"arm64", "x86_64"}:
            fail(f"runtime file is not arm64-compatible: {path} ({result.stdout.strip()})")
    for path in runtime.rglob("*"):
        if path.is_file() and path.suffix.lower() in {".exe", ".dll", ".pyd"}:
            fail(f"Windows runtime file leaked into macOS payload: {path}")
    return files


def runtime_hashes(runtime: Path) -> dict[str, str]:
    records: dict[str, str] = {}
    for path in sorted(runtime.rglob("*")):
        if path.is_file() and not path.is_symlink():
            records[path.relative_to(runtime).as_posix()] = digest(path)
    return records


def payload_files(payload: Path) -> dict[str, str]:
    records: dict[str, str] = {}
    for category in ("wheels", "assets", "licenses"):
        folder = payload / category
        if not folder.is_dir():
            continue
        for path in sorted(folder.rglob("*")):
            if path.is_file() and not path.is_symlink():
                records[path.relative_to(payload).as_posix()] = digest(path)
    return records


def load_worker_version(engine: Path) -> str:
    worker_path = engine / "worker.py"
    match = re.search(r"^VERSION\s*=\s*[\"']([^\"']+)[\"']", worker_path.read_text(encoding="utf-8"), re.MULTILINE)
    if not match:
        fail(f"worker VERSION is missing: {worker_path}")
    return match.group(1)


def write_manifest(engine: Path, runtime: Path, payload: Path) -> None:
    lock = engine / "requirements.macos-arm64.lock"
    if not lock.is_file():
        fail(f"missing macOS lock: {lock}")
    files = payload_files(payload)
    if not any(name.startswith("wheels/") for name in files):
        fail("offline payload has no wheels")
    if not files:
        fail("offline payload is empty")
    manifest = {
        "version": load_worker_version(engine),
        "platform": PLATFORM_NAME,
        "lock": digest(lock),
        "files": files,
        "runtime": runtime_hashes(runtime),
    }
    provenance = {
        "platform": PLATFORM_NAME,
        "minimum_macos": MACOS_MINIMUM,
        "uv": {"version": UV_VERSION, "url": UV_URL, "sha256": UV_SHA256},
        "python": {"version": PYTHON_VERSION, "distribution": "python-build-standalone via uv python install"},
        "lock": {"file": lock.name, "sha256": manifest["lock"]},
        "payload_files": len(files),
        "runtime_macho_files": len(manifest["runtime"]),
        "network": "build-time only; runtime setup/prepare is offline",
    }
    license_dir = payload / "licenses"
    license_dir.mkdir(parents=True, exist_ok=True)
    (license_dir / "macos-build-provenance.json").write_text(
        json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    # Add the provenance file itself to the final payload hashes.
    manifest["files"] = payload_files(payload)
    temporary = payload / "manifest.json.tmp"
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, payload / "manifest.json")
    print(f"wrote {payload / 'manifest.json'} ({len(manifest['files'])} payload files)", flush=True)


def classify_asset(path: Path) -> str | None:
    suffix = path.suffix.lower()
    name = path.name.lower()
    parts = {part.lower() for part in path.parts}
    if suffix in {".ttf", ".otf", ".ttc"} or "font" in parts or "fonts" in parts:
        return "fonts"
    if suffix == ".onnx" or "model" in parts or "models" in parts:
        return "models"
    if suffix == ".json" and ("cmap" in parts or "cmaps" in parts):
        return "cmap"
    if suffix == ".tiktoken" or name == "o200k_base" or "tiktoken" in parts:
        return "tiktoken"
    return None


def copy_warmed_assets(source: Path, destination: Path) -> dict[str, int]:
    counts = {category: 0 for category in ("fonts", "models", "cmap", "tiktoken")}
    for path in sorted(source.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        category = classify_asset(path)
        if category is None:
            continue
        target = destination / "assets" / category / path.name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
        counts[category] += 1
    missing = [category for category, count in counts.items() if count == 0]
    if missing:
        fail(f"BabelDOC warmup did not produce public assets: {', '.join(missing)}")
    return counts


def build_payload(uv: Path, runtime: Path, payload: Path, engine: Path, temporary: Path) -> dict[str, int]:
    lock = engine / "requirements.macos-arm64.lock"
    if not lock.is_file():
        fail(f"missing macOS lock: {lock}")
    if payload.exists():
        shutil.rmtree(payload)
    (payload / "wheels").mkdir(parents=True)
    (payload / "assets").mkdir(parents=True)
    (payload / "licenses").mkdir(parents=True)

    base_env = os.environ.copy()
    base_env.update({
        "MACOSX_DEPLOYMENT_TARGET": MACOS_MINIMUM,
        "UV_CACHE_DIR": str(temporary / "uv-cache"),
        "UV_PYTHON_INSTALL_DIR": str(temporary / "python-managed"),
        "HOME": str(temporary / "home"),
        "XDG_CACHE_HOME": str(temporary / "cache"),
    })
    for key in ("UV_PROJECT_ENVIRONMENT", "VIRTUAL_ENV", "PYTHONHOME", "PYTHONPATH"):
        base_env.pop(key, None)
    (temporary / "home").mkdir(parents=True, exist_ok=True)
    (temporary / "cache").mkdir(parents=True, exist_ok=True)

    # uv 0.9.28 intentionally has no ``uv pip download`` command.  Use the
    # pinned interpreter's pip for acquisition, while uv remains the
    # relocatable offline venv/sync tool at runtime.  The explicit target
    # selects arm64 wheels even if a future runner image changes defaults.
    download_env = temporary / "download-env"
    run([str(uv), "venv", "--offline", "--no-python-downloads", "--python", str(runtime / "bin/python3"), str(download_env)], env=base_env)
    download_python = download_env / "bin/python"
    # Keep pip's build tooling (including cross-platform Windows launchers)
    # out of the shipped interpreter. Only this temporary venv is seeded.
    run([str(download_python), "-B", "-m", "ensurepip", "--upgrade"], env=base_env)
    run([str(download_python), "-B", "-m", "pip", "download", "--python-version", "3.12",
         "--platform", "macosx_14_0_arm64", "--implementation", "cp", "--abi", "cp312",
         "--only-binary", ":all:", "--require-hashes", "--dest", str(payload / "wheels"),
         "-r", str(lock)], env=base_env)
    if not list((payload / "wheels").glob("*.whl")):
        fail("locked macOS wheelhouse is empty")

    build_env = temporary / "build-env"
    run([str(uv), "venv", "--offline", "--no-python-downloads", "--python", str(runtime / "bin/python3"), str(build_env)], env=base_env)
    build_python = build_env / "bin/python"
    run([str(uv), "pip", "sync", "--offline", "--no-index", "--find-links", str(payload / "wheels"),
         "--python", str(build_python), "--require-hashes", "--only-binary", ":all:", str(lock)], env=base_env)

    warmed = temporary / "warmed-assets"
    warmed.mkdir()
    warm_env = base_env.copy()
    warm_env.update({"READANY_ASSET_DIR": str(warmed), "TIKTOKEN_CACHE_DIR": str(warmed / "tiktoken")})
    (warmed / "tiktoken").mkdir()
    warm_code = (
        "from pathlib import Path\n"
        "import os\n"
        "import babeldoc.const as const\n"
        "target = Path(os.environ['READANY_ASSET_DIR'])\n"
        "const.CACHE_FOLDER = target\n"
        "const.TIKTOKEN_CACHE_FOLDER = target / 'tiktoken'\n"
        "const.TIKTOKEN_CACHE_FOLDER.mkdir(parents=True, exist_ok=True)\n"
        "from babeldoc.assets import assets\n"
        "assets.warmup()\n"
    )
    run([str(build_python), "-I", "-B", "-c", warm_code], cwd=temporary, env=warm_env)
    counts = copy_warmed_assets(warmed, payload)
    (payload / "licenses" / "macos-assets-provenance.json").write_text(
        json.dumps({"source": "BabelDOC 0.6.2 upstream warmup", "categories": counts}, indent=2) + "\n",
        encoding="utf-8",
    )
    return counts


def stage_runtime(uv: Path, managed_python: Path, runtime: Path) -> None:
    if runtime.exists():
        shutil.rmtree(runtime)
    runtime.parent.mkdir(parents=True, exist_ok=True)
    copy_tree_preserving_relative_links(managed_python.parent.parent if managed_python.parent.name == "bin" else managed_python, runtime)
    # Keep a single relocatable copy of uv beside the managed interpreter.
    uv_target = runtime / "uv"
    shutil.copy2(uv, uv_target)
    uv_target.chmod(uv_target.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    if not (runtime / "bin/python3").exists() or not (runtime / "bin/python3").is_symlink() and not (runtime / "bin/python3").is_file():
        fail("managed Python installation has no relocatable bin/python3")


def main() -> None:
    require_native_arm64()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--sign-runtime", action="store_true", help="ad-hoc sign runtime Mach-O files before manifesting")
    parser.add_argument("--manifest-only", action="store_true", help="refresh hashes from already prepared files; no network")
    args = parser.parse_args()
    root = args.root.resolve()
    engine = root / "packages/app/src-tauri/pdf-engine"
    runtime = root / "packages/app/src-tauri/pdf-runtime"
    payload = root / "packages/app/src-tauri/pdf-offline"
    if args.manifest_only:
        if args.sign_runtime:
            sign_runtime(runtime)
        verify_runtime_architecture(runtime)
        write_manifest(engine, runtime, payload)
        return

    with tempfile.TemporaryDirectory(prefix="readany-macos-pdf-") as temporary_name:
        temporary = Path(temporary_name)
        uv_archive = temporary / UV_ARCHIVE
        download(UV_URL, uv_archive)
        actual_uv_hash = digest(uv_archive)
        if actual_uv_hash != UV_SHA256:
            fail(f"uv checksum mismatch: expected {UV_SHA256}, got {actual_uv_hash}")
        uv_extract = temporary / "uv"
        safe_extract_tar(uv_archive, uv_extract)
        uv = locate_uv(uv_extract)
        managed_dir = temporary / "python-managed"
        env = os.environ.copy()
        env.update({
            "MACOSX_DEPLOYMENT_TARGET": MACOS_MINIMUM,
            "UV_CACHE_DIR": str(temporary / "uv-cache"),
            "UV_PYTHON_INSTALL_DIR": str(managed_dir),
            "HOME": str(temporary / "home"),
            "XDG_CACHE_HOME": str(temporary / "cache"),
        })
        (temporary / "home").mkdir(parents=True, exist_ok=True)
        (temporary / "cache").mkdir(parents=True, exist_ok=True)
        run([str(uv), "python", "install", PYTHON_VERSION, "--install-dir", str(managed_dir), "--no-bin"], env=env)
        managed_python = locate_python(managed_dir)
        stage_runtime(uv, managed_python, runtime)
        files = verify_runtime_architecture(runtime)
        # Finish build-time interpreter use before signing and recording hashes.
        counts = build_payload(runtime / "uv", runtime, payload, engine, temporary)
        if args.sign_runtime:
            sign_runtime(runtime)
        # Check architecture again after signing and before any hash is written.
        verify_runtime_architecture(runtime)
        write_manifest(engine, runtime, payload)
        print(json.dumps({"platform": PLATFORM_NAME, "runtime_macho_files": len(files), "assets": counts}, indent=2), flush=True)


if __name__ == "__main__":
    main()
