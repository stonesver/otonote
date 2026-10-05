"""A durable fixed-capability resource node. No generic command execution API."""
import fcntl
import json
import os
import re
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from .config import secret, validate_config


R2_ACTIONS_URL = 'https://github.com/stonesver/otonote/actions/workflows/content-r2.yml'
R2_DELIVERY_MAX_AGE_SECONDS = 6 * 60
R2_DELIVERY_MAX_FUTURE_SECONDS = 60


class Jobs:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.path, check_same_thread=False, timeout=5)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, key TEXT UNIQUE, profile TEXT,
              action TEXT, actor TEXT, status TEXT, created REAL, updated REAL, message TEXT);
            CREATE TABLE IF NOT EXISTS audit(at REAL, actor TEXT, action TEXT, result TEXT);''')
        self.db.execute('CREATE TABLE IF NOT EXISTS job_targets(id TEXT PRIMARY KEY,candidate TEXT NOT NULL)')
        self.db.commit()

    def create(self, payload, actor):
        with self.lock, self.db:
            self.db.execute('BEGIN IMMEDIATE')
            existing = self.db.execute("SELECT jobs.*,COALESCE(job_targets.candidate,'') candidate FROM jobs LEFT JOIN job_targets USING(id) WHERE key=?", (payload['key'],)).fetchone()
            if existing:
                if existing['profile'] != payload['profile'] or existing['action'] != payload['action'] or existing['actor'] != actor or existing['candidate'] != payload.get('candidate', ''):
                    raise ValueError('idempotency key conflict')
                return dict(existing)
            active = self.db.execute("SELECT id FROM jobs WHERE profile=? AND status IN ('queued','running')", (payload['profile'],)).fetchone()
            if active:
                raise ValueError('a task is already active for this profile')
            now, job_id = time.time(), uuid.uuid4().hex
            self.db.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?)',
                            (job_id, payload['key'], payload['profile'], payload['action'], actor, 'queued', now, now, '等待节点执行'))
            self.db.execute('INSERT INTO job_targets VALUES(?,?)', (job_id, payload.get('candidate', '')))
            self.db.execute('INSERT INTO audit VALUES(?,?,?,?)', (now, actor, payload['action'], job_id))
            return dict(self.db.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone())

    def list(self):
        with self.lock:
            return [dict(r) for r in self.db.execute("SELECT jobs.*,COALESCE(job_targets.candidate,'') candidate FROM jobs LEFT JOIN job_targets USING(id) ORDER BY created DESC LIMIT 50")]

    def close(self):
        self.db.close()


def profile_state(profile):
    result = {'id': profile['id'], 'name': profile.get('name', profile['id']), 'capabilities': profile.get('capabilities', ['check']),
              'status': 'not_run', 'steps': [], 'publication': 'enabled' if 'publish' in profile.get('capabilities', []) else 'disabled'}
    path = Path(profile.get('stateWorkspace', profile['workspace'])) / 'latest-run.json'
    if profile.get('productionSource') == 'github-actions-r2':
        result.update({'productionOwner': 'github-actions-r2', 'actionsUrl': R2_ACTIONS_URL,
                       'capabilities': [], 'publication': 'disabled', 'status': 'unavailable'})
        try:
            if path.is_symlink() or path.stat().st_size > 1024 * 1024:
                raise ValueError('unsafe delivery status')
            stamp = path.stat().st_mtime
            result['updatedAt'] = stamp
            age = time.time() - stamp
            if age > R2_DELIVERY_MAX_AGE_SECONDS or age < -R2_DELIVERY_MAX_FUTURE_SECONDS:
                raise ValueError('stale delivery status')
            data = json.loads(path.read_text())
            delivery = data.get('delivery')
            if (data.get('schemaVersion') != 2 or data.get('productionOwner') != 'github-actions-r2'
                    or not isinstance(delivery, dict) or delivery.get('status') not in {'ready', 'unavailable'}
                    or not isinstance(delivery.get('regions'), dict)
                    or data.get('status') != ('passed' if delivery['status'] == 'ready' else 'unavailable')):
                raise ValueError('invalid delivery status')
            regions = delivery['regions']
            if delivery['status'] == 'ready':
                if set(regions) != {'global', 'jp'}:
                    raise ValueError('incomplete delivery status')
                for row in regions.values():
                    if (not isinstance(row, dict)
                            or not isinstance(row.get('contentReleaseId'), str)
                            or len(row['contentReleaseId']) > 200
                            or not re.fullmatch('[a-f0-9]{24}', row.get('releaseId', ''))
                            or not re.fullmatch('[a-f0-9]{64}', row.get('manifestSha256', ''))
                            or not re.fullmatch('[a-f0-9]{24}-[a-f0-9]{24}', row.get('renderPair', ''))):
                        raise ValueError('invalid delivery identity')
            elif regions:
                raise ValueError('unavailable delivery has identities')
            result['delivery'] = delivery
            result['status'] = data['status']
        except (OSError, ValueError, TypeError, AttributeError, KeyError):
            pass
        return result
    try:
        if path.stat().st_size > 1024 * 1024:
            raise ValueError('state too large')
        data = json.loads(path.read_text())
        result['status'] = data.get('status') if data.get('status') in {'running', 'passed', 'failed'} else 'unknown'
        result['steps'] = [{'name': str(s.get('name', ''))[:80], 'status': str(s.get('status', ''))[:30]}
                           for s in data.get('steps', [])[:40] if isinstance(s, dict)]
        result['updatedAt'] = path.stat().st_mtime
        result['candidate'] = data.get('candidate')
        result['inputsReady'] = data.get('inputsReady', False)
        result['currentRelease'] = data.get('currentRelease')
    except FileNotFoundError:
        pass
    except (OSError, ValueError, TypeError, AttributeError):
        result['status'] = 'unavailable'
    return result


def create_node(config):
    from fastapi import FastAPI, HTTPException, Request
    from fastapi.responses import JSONResponse
    from .collector import bearer, small_json
    c = validate_config(config, 'node')
    read_key, write_key = secret(c['readTokenEnv']), secret(c['writeTokenEnv'])
    if read_key == write_key:
        raise ValueError('node read and write credentials must differ')
    profiles = {p['id']: p for p in c.get('profiles', [])}
    jobs = Jobs(c['database'])
    @asynccontextmanager
    async def lifespan(app):
        yield
        jobs.close()
    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.jobs = jobs

    @app.middleware('http')
    async def authenticate(request, call_next):
        allowed = bearer(request, write_key if request.method == 'POST' else read_key)
        if not allowed:
            return JSONResponse({'error': 'unauthorized'}, status_code=401)
        response = await call_next(request)
        response.headers['Cache-Control'] = 'no-store'
        return response

    @app.get('/state')
    def state():
        return {'id': c.get('id', 'node'), 'profiles': [profile_state(p) for p in profiles.values()],
                'tasks': jobs.list(), 'capabilities': sorted(set(a for p in profiles.values() for a in p.get('capabilities', ['check']))), 'checkedAt': time.time()}

    @app.post('/tasks')
    async def submit(request: Request):
        data = await small_json(request)
        if set(data) not in ({'profile', 'action', 'key', 'actor'}, {'profile', 'action', 'key', 'actor', 'candidate'}) or any(not isinstance(v, str) for v in data.values()):
            raise HTTPException(400, 'invalid task')
        if data['profile'] not in profiles or data['action'] not in profiles[data['profile']].get('capabilities', ['check']):
            raise HTTPException(403, 'capability unavailable')
        if profiles[data['profile']].get('productionSource') == 'github-actions-r2':
            raise HTTPException(403, 'production belongs to GitHub Actions')
        if data['action'] == 'publish':
            if data['actor'] not in profiles[data['profile']].get('publishUsers', []):
                raise HTTPException(403, 'publication not allowed')
            if not re.fullmatch('[a-f0-9]{64}', data.get('candidate', '')):
                raise HTTPException(400, 'verified candidate is required')
        elif 'candidate' in data:
            raise HTTPException(400, 'candidate is only valid for publication')
        if not 16 <= len(data['key']) <= 80 or not 1 <= len(data['actor']) <= 120:
            raise HTTPException(400, 'invalid task identity')
        try:
            return jobs.create(data, data['actor'])
        except ValueError:
            raise HTTPException(409, 'active task or idempotency conflict')
    return app


class WorkflowBusy(Exception):
    pass


def execute_check(config, profile):
    """Execute a registered fixed action; never accept a shell or arbitrary path."""
    action = profile.get("_action", "check")
    if action not in {"check", "fetch", "build", "publish"} or action not in profile.get("capabilities", ["check"]):
        raise ValueError("capability unavailable")
    repository = Path(config['repository']).resolve()
    config_file = Path(profile['configFile']).resolve()
    raw = json.loads(config_file.read_text())
    configured_workspace = (repository / raw['workspace']).resolve()
    if configured_workspace != Path(profile['workspace']).resolve():
        raise ValueError('workflow workspace differs from registered profile')
    command = [sys.executable, '-m', 'tools.global_update', action, '--config', str(config_file)]
    if action == 'publish':
        candidate = profile.get('_candidate', '')
        if not re.fullmatch('[a-f0-9]{64}', candidate): raise ValueError('invalid candidate')
        command += ['--candidate-id', candidate]
    # Do not pass API or proxy credentials into resource tools.
    environment = {k: v for k, v in os.environ.items() if k in {'PATH', 'LANG', 'LC_ALL', 'TMPDIR'}}
    with tempfile.TemporaryFile() as output:
        process = subprocess.Popen(command, cwd=repository, env=environment, stdin=subprocess.DEVNULL,
                                   stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        deadline = time.monotonic() + (300 if action == "check" else 6*3600)
        try:
            while process.poll() is None:
                if time.monotonic() >= deadline or os.fstat(output.fileno()).st_size > 1024 * 1024:
                    raise TimeoutError('task exceeded its execution budget')
                time.sleep(.2)
            if process.returncode == 75: raise WorkflowBusy()
            return process.returncode == 0
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()


def run_worker(config, once=False, executor=execute_check):
    jobs = Jobs(config['database'])
    lock_path = Path(str(config['database']) + '.worker.lock')
    with lock_path.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with jobs.db:
            jobs.db.execute("UPDATE jobs SET status='interrupted',message='节点重启，请检查后手动重试',updated=? WHERE status='running'", (time.time(),))
        profiles = {p['id']: p for p in config.get('profiles', [])}
        while True:
            with jobs.db:
                row = jobs.db.execute("SELECT jobs.*,COALESCE(job_targets.candidate,'') candidate FROM jobs LEFT JOIN job_targets USING(id) WHERE status='queued' ORDER BY created LIMIT 1").fetchone()
                if row:
                    jobs.db.execute("UPDATE jobs SET status='running',message='正在执行资源任务',updated=? WHERE id=?", (time.time(), row['id']))
            if row:
                status, message = 'failed', '任务未完成；候选过期或校验失败时请重新拉取并构建，详情见节点工作流日志'
                try:
                    if row['action'] in profiles[row['profile']].get('capabilities', ['check']) and executor(config, {**profiles[row['profile']], '_action': row['action'], '_candidate': row['candidate']}):
                        status, message = 'succeeded', {'check':'版本检查完成', 'fetch':'资源拉取完成；尚未发布', 'build':'候选构建并校验完成；尚未发布', 'publish':'候选发布完成'}[row['action']]
                except WorkflowBusy:
                    status, message = 'queued', '自动更新正在运行；等待工作流锁'
                except (OSError, ValueError, TimeoutError, KeyError):
                    pass
                with jobs.db:
                    jobs.db.execute('UPDATE jobs SET status=?,message=?,updated=? WHERE id=?', (status, message, time.time(), row['id']))
                    jobs.db.execute('INSERT INTO audit VALUES(?,?,?,?)', (time.time(), row['actor'], row['action'], status))
            with jobs.db:
                jobs.db.execute("DELETE FROM jobs WHERE updated<? AND status NOT IN ('queued','running')", (time.time() - 90 * 86400,))
                jobs.db.execute('DELETE FROM job_targets WHERE id NOT IN (SELECT id FROM jobs)')
                jobs.db.execute('DELETE FROM audit WHERE at<?', (time.time() - 90 * 86400,))
            if once:
                break
            time.sleep(5 if row and status == 'queued' else 1)
    jobs.close()
