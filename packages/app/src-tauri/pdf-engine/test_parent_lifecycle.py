"""macOS parent-death integration check; no AI endpoint or PDF dependencies."""
import json
from pathlib import Path
import queue
import signal
import subprocess
import sys
import threading
import time
import unittest


@unittest.skipUnless(sys.platform == 'darwin', 'requires macOS process groups')
class ParentLifecycleTests(unittest.TestCase):
    def test_parent_death_stops_blocked_worker_and_grandchild(self):
        worker = str(Path(__file__).with_name('worker.py').resolve())
        child_code = (
            'import importlib.util, subprocess, sys\n'
            's=importlib.util.spec_from_file_location("worker",sys.argv[1])\n'
            'w=importlib.util.module_from_spec(s);s.loader.exec_module(w)\n'
            'w.watch_native_parent()\n'
            'p=subprocess.Popen([sys.executable,"-c","import time;time.sleep(60)"])\n'
            'print(p.pid,flush=True)\n'
            'sys.stdin.buffer.readline()\n'
        )
        supervisor_code = (
            'import json,os,subprocess,sys,time\n'
            'env=dict(os.environ,READANY_PDF_PARENT_PID=str(os.getpid()))\n'
            'p=subprocess.Popen([sys.executable,"-I","-B","-c",sys.argv[1],sys.argv[2]],'
            'stdin=subprocess.PIPE,stdout=subprocess.PIPE,env=env,start_new_session=True)\n'
            'print(json.dumps([p.pid,int(p.stdout.readline())]),flush=True)\n'
            'time.sleep(60)\n'
        )
        supervisor = subprocess.Popen([sys.executable, '-I', '-B', '-c', supervisor_code, child_code, worker],
                                      stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        result = queue.Queue()
        threading.Thread(target=lambda: result.put(supervisor.stdout.readline()), daemon=True).start()
        group = None
        try:
            group, grandchild = json.loads(result.get(timeout=10))
            supervisor.kill()
            supervisor.wait(timeout=5)
            # launchd can briefly retain a zombie; zombies cannot execute work.
            deadline = time.monotonic() + 10
            remaining = [group, grandchild]
            while remaining and time.monotonic() < deadline:
                remaining = [pid for pid in remaining if self.running(pid)]
                time.sleep(0.05)
            self.assertFalse(remaining, f'worker processes survived parent death: {remaining}')
        finally:
            if supervisor.poll() is None:
                supervisor.kill()
            supervisor.wait(timeout=5)
            if group is not None:
                import os
                try:
                    os.killpg(group, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            supervisor.stdout.close()

    @staticmethod
    def running(pid):
        status = subprocess.run(['/bin/ps', '-o', 'stat=', '-p', str(pid)],
                                text=True, capture_output=True, timeout=5)
        state = status.stdout.strip()
        return bool(state) and not state.startswith('Z')


if __name__ == '__main__':
    unittest.main()
