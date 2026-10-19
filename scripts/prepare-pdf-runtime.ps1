param(
  [Parameter(Mandatory=$true)][string]$PythonRoot,
  [Parameter(Mandatory=$true)][string]$UvPath
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$destination = Join-Path $repo 'packages/app/src-tauri/pdf-runtime'
if (-not (Test-Path (Join-Path $PythonRoot 'python.exe'))) { throw 'Portable CPython root required' }
if (-not (Test-Path $UvPath -PathType Leaf)) { throw 'uv executable missing' }
New-Item -ItemType Directory -Force -Path $destination | Out-Null
# Copy portable standard library + native runtime, never the developer's venv/site-packages.
foreach ($name in @('python.exe','python3.dll','python312.dll','vcruntime140.dll','vcruntime140_1.dll','LICENSE.txt','DLLs','Lib')) {
  Copy-Item -LiteralPath (Join-Path $PythonRoot $name) -Destination $destination -Recurse -Force
}
Copy-Item -LiteralPath $UvPath -Destination (Join-Path $destination 'uv.exe') -Force
& (Join-Path $destination 'python.exe') -I -c 'import sys, ssl, sqlite3, ctypes; print(sys.version); print(sys.prefix)'
if ($LASTEXITCODE -ne 0) { throw 'Portable Python smoke test failed' }
& (Join-Path $destination 'uv.exe') --version
if ($LASTEXITCODE -ne 0) { throw 'Portable uv smoke test failed' }
