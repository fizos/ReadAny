"""Synthetic PDF -> local fake provider -> cache -> book export smoke check.

Run with the private engine's Python. No real books, credentials or external AI
services are used. This checks integration, not translation quality on a user M1.
"""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import uuid

import pymupdf


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--resources-root', required=True)
    parser.add_argument('--engine', required=True)
    args = parser.parse_args()
    resources = Path(args.resources_root).resolve()
    engine = Path(args.engine).resolve()
    script = resources / 'pdf-engine/worker.py'
    spec = importlib.util.spec_from_file_location('pdf_smoke_worker', script)
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    received = []

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            values = json.loads(body['messages'][-1]['content'])
            result = [{'id': value['id'], 'texts': ['译文' for _ in value['fragments']]} for value in values]
            received.append(True)
            content = json.dumps(result, ensure_ascii=False)
            payload = json.dumps({'choices': [{'message': {'content': content}, 'finish_reason': 'stop'}]}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix='ReadAny PDF 中文 ') as folder:
            root = Path(folder)
            source = root / 'original.pdf'
            with pymupdf.open() as document:
                page = document.new_page(width=595, height=842)
                page.insert_text((60, 70), 'Table of Contents', fontsize=20)
                for index in range(5):
                    y = 140 + index * 42
                    page.insert_text((60, y), f'Chapter {index + 1} .................... {index + 1}', fontsize=12)
                assert worker.toc_layout(page), 'fixture must exercise structured translation'
                document.new_page(width=720, height=480).draw_rect((30, 30, 100, 100))
                document.save(source)
            source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
            cache = root / 'pages'

            def run(action):
                job_id = str(uuid.uuid4())
                request = dict(action=action, jobId=job_id, filePath=str(source), page=1,
                               targetLang='zh-CN', baseUrl=f'http://127.0.0.1:{server.server_port}/v1',
                               apiKey='synthetic-not-a-secret', model='fixture', profileId='fixture',
                               engineDir=str(engine), jobDir=str(root/'jobs'/job_id),
                               assetsDir=str(engine/'assets'), cacheDir=str(cache),
                               resourceDir=str(resources/'pdf-engine'), runtimeDir=str(resources/'pdf-runtime'))
                result = subprocess.run([sys.executable, '-I', '-B', str(script)],
                                        input=json.dumps(request).encode(), capture_output=True, timeout=120)
                events = [json.loads(line) for line in result.stdout.splitlines()]
                assert result.returncode == 0, [(e.get('type'), e.get('code')) for e in events]
                complete = [e for e in events if e['type'] == 'complete']
                assert len(complete) == 1, events
                return complete[0]

            translated = run('translate')
            assert translated.get('cached') is False and received
            with pymupdf.open(translated['path']) as document:
                assert len(document) == 1 and '译文' in document[0].get_text()
            requests = len(received)
            cached = run('translate')
            assert cached.get('cached') is True and len(received) == requests
            plan = json.loads(Path(run('plan-export')['path']).read_text())
            assert (plan['totalPages'], plan['cachedPages'], plan['nonTextPages'], plan['missingPages']) == (2, 1, 1, 0), plan
            exported = run('export')
            with pymupdf.open(exported['path']) as document:
                assert len(document) == 2 and '译文' in document[0].get_text()
                assert list(document[1].rect) == [0, 0, 720, 480]
            assert hashlib.sha256(source.read_bytes()).hexdigest() == source_hash
            assert len(received) == requests, 'export should reuse the translated page'
            print(json.dumps(dict(translation=True, cache=True, export=True, sourceUnchanged=True,
                                  syntheticProviderRequests=requests)))
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
