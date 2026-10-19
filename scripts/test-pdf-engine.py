"""Run the shipped worker protocol from an isolated path; never print credentials."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time
import uuid

parser = argparse.ArgumentParser()
parser.add_argument("action", choices=["setup", "prepare", "translate"])
parser.add_argument("--settings")
parser.add_argument("--input")
parser.add_argument("--page", type=int, default=35)
parser.add_argument("--force", action="store_true")
parser.add_argument("--engine", default="tmp/PDF 引擎 smoke/engine")
parser.add_argument("--resources-root", help="Extracted installer directory containing pdf-engine and pdf-runtime")
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
resource_root = Path(args.resources_root).resolve() if args.resources_root else root / "packages/app/src-tauri"
resources = resource_root / "pdf-engine"
runtime = resource_root / "pdf-runtime"
engine = (root / args.engine).resolve()
job_id = str(uuid.uuid4())
job = engine / "jobs" / job_id
request = dict(action=args.action, jobId=job_id, engineDir=str(engine), jobDir=str(job),
               assetsDir=str(engine / "assets"), cacheDir=str(engine / "pages"),
               resourceDir=str(resources), runtimeDir=str(runtime))
if args.action == "translate":
    saved = json.loads(Path(args.settings).read_text(encoding="utf-8-sig"))["aiConfig"]
    endpoint = next(x for x in saved["endpoints"] if x["id"] == saved["activeEndpointId"])
    request.update(filePath=str(Path(args.input).resolve()), page=args.page, targetLang="ZH", force=args.force,
                   baseUrl=endpoint["baseUrl"], apiKey=endpoint["apiKey"], model=saved["activeModel"],
                   profileId=endpoint["id"], useExactRequestUrl=endpoint.get("useExactRequestUrl", False))
python = runtime / "python.exe" if args.action == "setup" else engine / "env/Scripts/python.exe"
started = time.monotonic()
process = subprocess.Popen([str(python), "-I", str(resources / "worker.py")], stdin=subprocess.PIPE,
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
process.stdin.write((json.dumps(request) + "\n").encode())
process.stdin.close()
events = []
for line in process.stdout:
    event = json.loads(line)
    events.append(event)
    print(json.dumps(event, ensure_ascii=True), flush=True)
code = process.wait()
summary = {"exit_code": code, "elapsed_seconds": round(time.monotonic() - started, 2), "events": events}
job.mkdir(parents=True, exist_ok=True)
(job / "smoke-result.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"exit_code": code, "elapsed_seconds": summary["elapsed_seconds"]}), flush=True)
sys.exit(code)
