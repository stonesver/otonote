"""Loopback-only account exporter with a browser UI and no ADB dependency.

Passwords and tokens remain in process memory and are never written to status
or export files. The official SDK profile comes from locally inspected APK
resources. By default results stay in memory until the user downloads JSON.
"""
from __future__ import annotations

from dataclasses import replace

from tools.global_game_config import GLOBAL_SERVERS

import argparse
import json
import secrets
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from tools.growth_export import ExportError, write_snapshot
from tools.growth_login import GameClient, LoginError, Profile, SdkClient

PAGE = r'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Our Notes · 本地养成导出</title>
<style nonce="NONCE">
:root{font:15px/1.7 system-ui;color:#24212a;background:#f0eee8}*{box-sizing:border-box}body{margin:0;padding:32px 18px}main{max-width:680px;margin:auto}header{margin:0 0 22px}small,.help{color:#716b70;font-size:13px}h1{font-size:27px;margin:6px 0}h2{font-size:17px;margin:0 0 10px}p{margin:8px 0}section,details{background:#fffdf7;border:1px solid #dfd7dc;border-radius:14px;padding:22px;margin:14px 0}summary{cursor:pointer;font-weight:600}label{display:grid;gap:6px;margin:14px 0;font-size:13px}input{width:100%;min-height:44px;border:1px solid #cfc4cc;border-radius:8px;padding:10px;font:inherit;background:white}button,a.download{display:inline-block;min-height:44px;padding:10px 18px;border:0;border-radius:8px;background:#7a3155;color:white;font:600 14px system-ui;text-decoration:none;cursor:pointer}button:disabled{opacity:.45;cursor:default}fieldset{border:0;padding:0;margin:0}#status{white-space:pre-wrap;background:#f6f0f4;border-radius:8px;padding:14px;font-size:13px}#download{margin-top:16px}[hidden]{display:none!important}:focus-visible{outline:2px solid #315f73;outline-offset:3px}@media(max-width:480px){body{padding:20px 12px}section,details{padding:16px}h1{font-size:23px}}
</style>
<main><header><small>OUR NOTES · 国际服</small><h1>把你的养成带到配卡工具</h1><p class="help">在自己的电脑登录，导出角色卡、留影、乐器、角色评级与 TGW。</p></header>
<details id="config-panel" open><summary>本地工具配置 <span id="config-state">· 尚未配置</span></summary><p class="help">首次使用请选择 SDK 应用配置 XML。它标识游戏和渠道，不是你的账号密码。配置只用于本次运行；也可以将有效配置放在工具旁，命名为 sdk.xml。</p><label>SDK 配置文件<input id="config-file" type="file" accept=".xml,text/xml,application/xml"></label><p id="config-message" role="status">未配置时不能登录。请使用工具维护者提供的配置。</p></details>
<section><h2>1. 登录并读取养成</h2><p class="help">电脑直接连接官方服务，无需手机或 ADB；密码不会发送到资料站，也不会写入导出文件。</p><form id="form"><fieldset id="login-fields" disabled><label for="server">账号所属区服<select id="server"><option value="global-hmt">港澳台</option><option value="global-en">EN</option><option value="global-kr">韩服</option></select></label><label for="account">BHK 账号邮箱<input id="account" name="account" type="email" required maxlength="320" autocomplete="off"></label><label for="password">密码<input id="password" name="password" type="password" required maxlength="4096" autocomplete="off"></label><button id="submit" type="submit">登录并读取养成</button></fieldset></form><p class="help">登录可能使游戏中的会话失效。仅支持 BHK 邮箱密码；遇到验证码或额外验证时停止，不自动重试。</p></section>
<section><h2>2. 下载并导入网站</h2><div id="status" role="status" aria-live="polite">等待工具就绪。</div><a id="download" class="download" href="/download" download="ournotes-growth.json" hidden>下载养成 JSON</a><p class="help">在配卡工具的「选卡库 → 我的卡库 → 从游戏导入我的养成」选择文件，预览后应用。未知项目不会补成满级；回忆加成等未读取项目需要自行设置。</p></section><p class="help">默认仅在内存中保留本次结果，关闭工具即清除；下载的 JSON 由你自己保管。关闭终端窗口或按 Ctrl+C 退出工具。</p></main>
<script nonce="NONCE">
const q=id=>document.getElementById(id);
const labels={waiting:'等待在本机输入账号。',discovering:'确认所选服务器及客户端版本…',sdk_login:'正在通过官方服务登录…',checking_existing_account:'检查已有角色…',game_login:'正在建立游戏会话…',reading_growth:'正在读取养成…',complete:'养成已读取。请下载 JSON，再到网站预览和应用。',failed:'读取未完成，已停止。'};
const reasons={credentials_rejected:'账号或密码校验未通过。',account_not_found:'账号不存在。',verification_required:'官方服务要求额外验证，请回到官方客户端处理。',rate_limited:'请求过于频繁，请稍后手动尝试。'};
const groups={memberCards:'角色卡',supportCards:'留影',bandItems:'乐器',characterRanks:'角色评级'};
let submissionError='',configured=false,requestBusy=false;
async function refresh(){try{const r=await fetch('/status',{cache:'no-store'});if(!r.ok)throw Error();const s=await r.json();q('login-fields').disabled=requestBusy||s.busy||!s.sdkConfigured;q('config-file').disabled=requestBusy||s.busy;if(s.sdkConfigured&&!configured){q('config-panel').open=false;q('config-state').textContent='· 已就绪';}configured=s.sdkConfigured;q('status').textContent=submissionError||(!configured?'先选择 SDK 应用配置，再登录账号。':(labels[s.stage]||'等待操作。')+(s.failedStage?'\n失败阶段：'+(labels[s.failedStage]||s.failedStage):'')+(s.error?'\n状态代码：'+s.error:'')+(s.reason?'\n'+(reasons[s.reason]||'读取失败'):'')+(s.counts?'\n'+Object.entries(s.counts).map(([k,v])=>(groups[k]||k)+' '+v).join(' · '):''));q('download').hidden=s.stage!=='complete'||requestBusy;}catch{q('status').textContent='本地工具已关闭或连接中断，请重新启动。';q('login-fields').disabled=true;q('download').hidden=true;}}
q('config-file').addEventListener('change',async()=>{const file=q('config-file').files[0];if(!file)return;requestBusy=true;await refresh();let body='';try{if(file.size>6000)throw Error();body=JSON.stringify({xml:await file.text()});const r=await fetch('/configure',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Nonce':'NONCE'},body});if(!r.ok)throw Error();q('config-message').textContent='配置已载入本次运行。';submissionError='';}catch{q('config-message').textContent='配置未载入，请选择所支持国际服渠道的 SDK 配置 XML（不超过 6 KB）。';}finally{body='';q('config-file').value='';requestBusy=false;await refresh();}});
q('form').addEventListener('submit',async e=>{e.preventDefault();submissionError='';requestBusy=true;let body=JSON.stringify({serverId:q('server').value,account:q('account').value.trim(),password:q('password').value});q('password').value='';q('login-fields').disabled=true;q('download').hidden=true;try{const r=await fetch('/export',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Nonce':'NONCE'},body});if(r.status!==202)submissionError=r.status===403?'页面已过期，请刷新后重新输入。':r.status===409?'读取正在进行或缺少 SDK 配置，请检查后重试。':'输入未被接受，请检查邮箱和密码。';}catch{submissionError='提交失败，请检查本地工具是否仍在运行。';}finally{body='';requestBusy=false;await refresh();}});
setInterval(refresh,1500);refresh();
</script></html>
'''


class LoginServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, profile=None, output=None, status_file=None, sdk_factory=SdkClient, game_factory=GameClient, port=0, levels=None):
        self.profile, self.output, self.status_file = profile, output, status_file
        self.levels = levels
        self.sdk_factory, self.game_factory = sdk_factory, game_factory
        self.nonce = secrets.token_hex(24)
        self.lock = threading.Lock()
        self.snapshot = None
        self.attempt = 0
        self.state = {'stage': 'waiting', 'busy': False}
        super().__init__(('127.0.0.1', port), Handler)
        self.authority = '127.0.0.1:' + str(self.server_port)
        self.origin = 'http://' + self.authority
        self.update('waiting', busy=False)

    def update(self, stage, **extra):
        self.state = {'stage': stage, 'busy': stage not in ('waiting', 'failed', 'complete'),
                      'attempt': self.attempt, 'sdkConfigured': self.profile is not None, **extra}
        if self.status_file:
            # This file contains only allowlisted state, never remote response text.
            self.status_file.write_text(json.dumps(self.state, ensure_ascii=False) + '\n')

    def export(self, account, password, server_id='global-hmt'):
        try:
            self.attempt += 1
            self.snapshot = None
            if self.output is not None and (self.output.exists() or self.output.is_symlink()):
                raise LoginError('output_already_exists')
            if self.profile is None:
                raise LoginError('sdk_profile_required')
            self.update('discovering')
            game = self.game_factory(server_id=server_id)
            host = game.discover()
            self.update('sdk_login')
            sdk = self.sdk_factory(replace(self.profile, version=game.client_version,language=GLOBAL_SERVERS[server_id]['language']))
            identity = sdk.login(account, password)
            password = account = ''
            snapshot = game.export(identity, sdk.device_id, host, self.update)
            identity = None
            if self.levels is not None:
                snapshot['derived'] = self.levels.derive(snapshot['growth'])
            if self.output is not None:
                write_snapshot(self.output, snapshot)
            self.snapshot = snapshot
            self.update('complete', counts={k: len(v) for k, v in snapshot['growth'].items() if isinstance(v, list)})
        except (LoginError, ExportError) as exc:
            self.update('failed', error=str(exc), failedStage=self.state['stage'],
                        reason=getattr(exc, 'reason', None))
        except Exception:
            self.update('failed', error='local_export_failed', failedStage=self.state['stage'])
        finally:
            password = account = ''
            self.lock.release()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def respond(self, code, payload, content_type='application/json; charset=utf-8'):
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        nonce = self.server.nonce
        self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'nonce-" + nonce + "'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
        self.end_headers()
        self.wfile.write(payload)

    def host_valid(self):
        return self.headers.get('Host') == self.server.authority

    def do_GET(self):
        if not self.host_valid():
            self.respond(403, b'{}')
        elif self.path == '/':
            self.respond(200, PAGE.replace('NONCE', self.server.nonce).encode(), 'text/html; charset=utf-8')
        elif self.path == '/status':
            self.respond(200, json.dumps(self.server.state, ensure_ascii=False).encode())
        elif self.path == '/download' and self.server.snapshot is not None:
            self.respond(200, json.dumps(self.server.snapshot, ensure_ascii=False, indent=2).encode())
        else:
            self.respond(404, b'{}')

    def do_POST(self):
        if (not self.host_valid() or self.path not in ('/export', '/configure')
                or self.headers.get('Origin') != self.server.origin
                or self.headers.get('X-Local-Nonce') != self.server.nonce
                or self.headers.get('Content-Type') != 'application/json'
                or self.headers.get('Transfer-Encoding')
                or len(self.headers.get_all('Content-Length', [])) != 1):
            self.respond(403, b'{}')
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 8192:
                raise ValueError()
            self.connection.settimeout(5)
            body = json.loads(self.rfile.read(size))
            required = ({'xml'},) if self.path == '/configure' else ({'account', 'password'}, {'account', 'password', 'serverId'})
            if (not isinstance(body, dict) or set(body) not in required
                    or not all(isinstance(v, str) and v.strip() for v in body.values())):
                raise ValueError()
            if self.path == '/export' and (len(body['account']) > 320 or len(body['password'].encode()) > 4096
                    or body.get('serverId', 'global-hmt') not in GLOBAL_SERVERS):
                raise ValueError()
        except (ValueError, OSError):
            self.respond(400, b'{}')
            return
        if not self.server.lock.acquire(blocking=False):
            self.respond(409, b'{}')
            return
        if self.path == '/configure':
            try:
                self.server.profile = Profile.from_xml(body['xml'].encode())
                self.server.snapshot = None
                self.server.update('waiting', busy=False)
                self.respond(200, b'{"configured":true}')
            except LoginError:
                self.respond(400, b'{"error":"invalid_sdk_profile"}')
            finally:
                body.clear()
                self.server.lock.release()
            return
        if self.server.profile is None:
            self.server.lock.release()
            self.respond(409, b'{"error":"sdk_profile_required"}')
            return
        threading.Thread(target=self.server.export, args=(body['account'], body['password'],body.get('serverId','global-hmt')), daemon=True).start()
        body.clear()
        self.respond(202, b'{}')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sdk-resources', type=Path, help='local SDK XML; can also be selected in the browser')
    parser.add_argument('--output', type=Path, help='optional new snapshot file; default: download in browser')
    parser.add_argument('--open-browser', action='store_true')
    parser.add_argument('--status-file', type=Path)
    parser.add_argument('--port', type=int, default=0)
    parser.add_argument('--master-dir', type=Path, help='optional local Master JSON tables for projected levels')
    args = parser.parse_args(argv)
    if args.output is not None and (args.output.exists() or args.output.is_symlink()):
        parser.error('choose a new output file')
    levels = None
    if args.master_dir:
        from tools.growth_levels import GrowthLevels
        levels = GrowthLevels(args.master_dir)
    try:
        profile = Profile.from_resources(args.sdk_resources) if args.sdk_resources else None
    except (LoginError, OSError):
        parser.error('cannot load SDK configuration; check the selected XML file')
    server = LoginServer(profile, args.output, args.status_file,
                         port=args.port, levels=levels)
    print('Local login ready: ' + server.origin, flush=True)
    if args.open_browser:
        webbrowser.open(server.origin)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
