import copy
import datetime as dt
import json
import os
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.admin.app import create_admin
from backend.admin.collector import create_collector
from backend.admin.config import validate_config, loopback_url
from backend.admin.node import create_node, run_worker
from backend.admin.sampling import Sampler, ingest_log
from backend.admin.store import Store


class AdminAnalyticsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {'ADMIN_TEST_READ': 'r' * 40, 'ADMIN_TEST_WRITE': 'w' * 40, 'ADMIN_TEST_PROXY': 'p' * 40})
        self.env.start()
        self.now = dt.datetime(2026, 9, 28, 4, tzinfo=dt.timezone.utc).timestamp()
        self.site = {'id': 'test', 'name': '测试站点', 'timezone': 'Asia/Shanghai', 'origins': ['https://example.com'],
                     'paths': ['/', '/music/'], 'resources': ['/song.zip', 'live2d:1'], 'source': 'test', 'nodes': []}
        self.collector = {'schemaVersion': 1, 'role': 'collector', 'port': 18081, 'database': str(self.root / 'events.sqlite'),
                          'readTokenEnv': 'ADMIN_TEST_READ', 'sites': [self.site]}

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def event(self, **fields):
        return {'v': 1, 'site': 'test', 'id': 'a' * 32, 'type': 'page_view', 'path': '/', 'visitor': 'v' * 32, **fields}

    def client(self):
        return TestClient(create_collector(self.collector, sampling=False, clock=lambda:self.now))

    def test_public_ingress_deduplicates_and_private_queries_require_token(self):
        with self.client() as client:
            for _ in range(2):
                self.assertEqual(client.post('/events',json=self.event(),headers={'Origin':'https://example.com'}).status_code,204)
            self.assertEqual(client.get('/summary/test').status_code,401)
            summary=client.get('/summary/test',headers={'Authorization':'Bearer '+'r'*40}).json()
            self.assertEqual(summary['totals']['page_view'],1)
            self.assertEqual(summary['dailyVisitorsSum'],1)
            self.assertEqual(summary['activeVisitors5m'],1)

    def test_download_and_export_are_distinct_and_operation_is_idempotent(self):
        with self.client() as client:
            base=self.event(type='download_click',resource='live2d:1')
            self.assertEqual(client.post('/events',json=base,headers={'Origin':'https://example.com'}).status_code,204)
            for i in range(2):
                event={**base,'id':str(i)*32,'type':'export_result','operation':'o'*32,'result':'success'}
                self.assertEqual(client.post('/events',json=event,headers={'Origin':'https://example.com'}).status_code,204)
            data=client.get('/summary/test',headers={'Authorization':'Bearer '+'r'*40}).json()
            self.assertEqual(data['totals']['download_click'],1)
            self.assertEqual(data['totals']['export_result:success'],1)

    def test_invalid_events_and_other_origins_are_rejected(self):
        with self.client() as client:
            for extra in [{'path':'/unknown?secret=1'},{'resource':'arbitrary'},{'private':'secret'},{'id':'bad'},{'type':'run_command'}]:
                self.assertEqual(client.post('/events',json=self.event(**extra),headers={'Origin':'https://example.com'}).status_code,400)
            self.assertEqual(client.post('/events',json=self.event(),headers={'Origin':'https://evil.example'}).status_code,403)
            self.assertEqual(client.post('/events',content='x'*5000,headers={'Origin':'https://example.com'}).status_code,413)
            self.assertEqual(client.post('/events',json=self.event(site=[]),headers={'Origin':'https://example.com'}).status_code,403)
            self.assertEqual(client.post('/events',json=self.event(path={}),headers={'Origin':'https://example.com'}).status_code,400)

    def test_ingress_rate_limit(self):
        with self.client() as client:
            for i in range(20):
                self.assertEqual(client.post('/events',json=self.event(id=f'{i:032d}'),headers={'Origin':'https://example.com'}).status_code,204)
            self.assertEqual(client.post('/events',json=self.event(),headers={'Origin':'https://example.com'}).status_code,429)

    def test_registered_runtime_route_patterns_remain_bounded(self):
        self.site['pathPatterns']=[r'/global/(?:zh-CN|en)/music/music-[0-9]{1,10}/']
        self.site['resourcePatterns']=[r'/content/releases/[a-f0-9]{24}/public/gallery/stamps-[0-9]+\.png']
        with self.client() as client:
            headers={'Origin':'https://example.com'}
            event=self.event(path='/global/zh-CN/music/music-100047/',type='download_click',resource='/content/releases/'+'a'*24+'/public/gallery/stamps-56.png')
            self.assertEqual(client.post('/events',json=event,headers=headers).status_code,204)
            for path in ['/global/zh-CN/unknown/','/global/zh-CN/music/music-100047/?secret=1','/'+'x'*513]:
                self.assertEqual(client.post('/events',json={**event,'path':path},headers=headers).status_code,400)

    def test_storage_limit_fails_closed(self):
        app=create_collector(self.collector,sampling=False,clock=lambda:self.now)
        with TestClient(app) as client, patch.object(app.state.store,'size',return_value=2*1024**3):
            self.assertEqual(client.post('/events',json=self.event(),headers={'Origin':'https://example.com'}).status_code,507)

    def test_database_failure_reports_degraded_without_another_write(self):
        app=create_collector(self.collector,clock=lambda:self.now)
        attempted=threading.Event()
        def fail_prune():
            attempted.set()
            raise sqlite3.OperationalError('database or disk is full')
        with patch.object(app.state.store,'prune',side_effect=fail_prune), TestClient(app) as client:
            self.assertTrue(attempted.wait(2))
            health=client.get('/health',headers={'Authorization':'Bearer '+'r'*40}).json()
            self.assertEqual(health['status'],'degraded')
            self.assertEqual(health['samplingError']['code'],'sampling_unavailable')

    def test_daily_visitor_rollover_and_retention_preserve_aggregate(self):
        store=Store(self.root/'rollover.sqlite')
        try:
            midnight=dt.datetime(2026,9,27,16,tzinfo=dt.timezone.utc).timestamp()
            store.add_event(self.event(),'Asia/Shanghai',midnight-1)
            store.add_event(self.event(id='b'*32),'Asia/Shanghai',midnight+1)
            self.assertEqual(store.summary(self.site,'7d',midnight+2)['dailyVisitorsSum'],2)
            store.prune(midnight+3*86400)
            self.assertEqual(store.summary(self.site,'7d',midnight+3*86400)['dailyVisitorsSum'],2)
            self.assertEqual(store.db.execute('SELECT COUNT(*) FROM visitors').fetchone()[0],0)
            self.assertEqual(store.summary(self.site,'today',midnight+2)['totals']['page_view'],1)
        finally:store.close()

    def log_line(self, size=100, route='/music/'):
        return json.dumps({'time':'2026-09-28T12:00:00+08:00','path':route,'bytes':size,'status':200})+'\n'

    def test_log_rotation_replay_and_partial_lines(self):
        log=self.root/'access.log';site={**self.site,'accessLog':str(log)}
        store=Store(self.root/'logs.sqlite')
        try:
            log.write_text(self.log_line())
            ingest_log(store,site,self.now);ingest_log(store,site,self.now)
            with log.open('a') as f:f.write(self.log_line(200))
            log.rename(self.root/'access.log.1');log.write_text(self.log_line(300))
            ingest_log(store,site,self.now);ingest_log(store,site,self.now)
            result=store.summary(site,'today',self.now)
            self.assertEqual(result['traffic'][0]['bytes'],600)
            self.assertEqual(result['traffic'][0]['requests'],3)
            with log.open('a') as f:f.write(self.log_line(400)[:-1])
            ingest_log(store,site,self.now)
            self.assertEqual(store.summary(site,'today',self.now)['traffic'][0]['bytes'],600)
            with log.open('a') as f:f.write('\n')
            ingest_log(store,site,self.now)
            self.assertEqual(store.summary(site,'today',self.now)['traffic'][0]['bytes'],1000)
        finally:store.close()

    def test_sampler_rates_resets_gaps_and_unavailable_are_not_zero(self):
        counters={'rx':100,'tx':200,'identity':[('eth0','1')]};nginx={'active':10,'reading':1,'writing':3,'waiting':6,'requests':100}
        sampler=Sampler({'interfaces':['eth0'],'statusUrl':'http://127.0.0.1:18083/status'},lambda _:copy.deepcopy(counters),lambda _:copy.deepcopy(nginx))
        first=sampler.sample(self.now,0)
        self.assertIsNone(first['txMbps'])
        counters['tx']+=5_000_000;nginx['requests']+=50
        second=sampler.sample(self.now+5,5)
        self.assertEqual(second['txMbps'],8)
        self.assertEqual(second['rps'],10)
        self.assertEqual(second['active'],10)
        counters['tx']=0
        self.assertIsNone(sampler.sample(self.now+10,10)['txMbps'])
        counters['tx']=10_000_000
        self.assertIsNone(sampler.sample(self.now+50,50)['txMbps'])

    def admin_config(self,preview=False):
        return {'schemaVersion':1,'role':'admin','port':18080,'origin':'http://127.0.0.1:18080',
                'auth':{'mode':'preview' if preview else 'proxy','proxyTokenEnv':'ADMIN_TEST_PROXY','users':['owner@example.com']},
                'sites':[self.site],'sources':[{'id':'test','url':'http://127.0.0.1:18081','readTokenEnv':'ADMIN_TEST_READ'}],
                'nodes':[{'id':'node','url':'http://127.0.0.1:18082','writeTokenEnv':'ADMIN_TEST_WRITE','readTokenEnv':'ADMIN_TEST_READ','profiles':['global']}]}

    def test_proxy_identity_cannot_be_spoofed_and_preview_cannot_submit(self):
        app=create_admin(self.admin_config(),transport=lambda *a:{})
        with TestClient(app,base_url='http://127.0.0.1:18080') as client:
            self.assertEqual(client.get('/api/config',headers={'X-Admin-User':'owner@example.com'}).status_code,401)
            headers={'X-Admin-User':'owner@example.com','X-Admin-Proxy':'p'*40}
            self.assertEqual(client.get('/api/config',headers=headers).status_code,200)
            self.assertEqual(client.post('/api/nodes/node/tasks',json={},headers=headers).status_code,403)
            self.assertEqual(client.get('/api/config',headers={**headers,'Host':'attacker.test'}).status_code,403)
            self.assertNotIn('ADMIN_TEST',client.get('/api/config',headers=headers).text)
        with TestClient(create_admin(self.admin_config(True)),base_url='http://127.0.0.1:18080') as client:
            self.assertEqual(client.post('/api/nodes/node/tasks',json={}).status_code,403)

    def test_admin_never_substitutes_run_for_check_or_retries_uncertain_submission(self):
        calls=[]
        def transport(*args):calls.append(args);raise OSError('offline')
        with TestClient(create_admin(self.admin_config(),transport),base_url='http://127.0.0.1:18080') as client:
            headers={'X-Admin-User':'owner@example.com','X-Admin-Proxy':'p'*40,'Origin':'http://127.0.0.1:18080','X-OurNotes-Request':'1'}
            task={'profile':'global','action':'run','key':'a'*32}
            self.assertEqual(client.post('/api/nodes/node/tasks',json=task,headers=headers).status_code,403)
            self.assertFalse(calls)
            task['action']='check'
            self.assertEqual(client.post('/api/nodes/node/tasks',json=task,headers=headers).status_code,503)
            self.assertEqual(len(calls),1)

    def test_node_queue_idempotency_and_single_profile_execution(self):
        config={'schemaVersion':1,'role':'node','port':18082,'database':str(self.root/'node.sqlite'),
                'readTokenEnv':'ADMIN_TEST_READ','writeTokenEnv':'ADMIN_TEST_WRITE',
                'profiles':[{'id':'global','workspace':str(self.root),'configFile':str(self.root/'workflow.json')}]}
        app=create_node(config)
        try:
            with TestClient(app) as client:
                task={'profile':'global','action':'check','key':'a'*32,'actor':'owner'}
                read={'Authorization':'Bearer '+'r'*40};write={'Authorization':'Bearer '+'w'*40}
                self.assertEqual(client.post('/tasks',json=task,headers=read).status_code,401)
                first=client.post('/tasks',json=task,headers=write)
                self.assertEqual(first.status_code,200)
                self.assertEqual(client.post('/tasks',json=task,headers=write).json()['id'],first.json()['id'])
                self.assertEqual(client.post('/tasks',json={**task,'key':'b'*32},headers=write).status_code,409)
                self.assertEqual(client.post('/tasks',json={**task,'action':'run'},headers=write).status_code,403)
                run_worker(config,once=True,executor=lambda c,p:True)
                self.assertEqual(client.get('/state',headers=read).json()['tasks'][0]['status'],'succeeded')
        finally:app.state.jobs.close()

    def test_reject_public_urls_and_control_configuration_in_collector(self):
        for value in ['http://example.com:80','http://127.0.0.1.evil:80','http://user@127.0.0.1:80','file:///tmp/file','http://127.0.0.1:80?target=x']:
            with self.assertRaises(ValueError):loopback_url(value)
        with self.assertRaises(ValueError):validate_config({**self.collector,'host':'0.0.0.0'})
        with self.assertRaises(ValueError):validate_config({**self.collector,'nodes':[{'id':'node','url':'http://127.0.0.1:9999'}]})

    def test_collector_to_admin_roundtrip_keeps_source_credentials_private(self):
        with self.client() as collector:
            collector.post('/events',json=self.event(),headers={'Origin':'https://example.com'})
            def transport(source,path,*args):
                response=collector.get(path,headers={'Authorization':'Bearer '+'r'*40})
                response.raise_for_status()
                return response.json()
            with TestClient(create_admin(self.admin_config(True),transport),base_url='http://127.0.0.1:18080') as admin:
                result=admin.get('/api/summary/test').json()
                self.assertEqual(result['data']['totals']['page_view'],1)
                self.assertNotIn('readTokenEnv',json.dumps(result))
                self.assertNotIn(str(self.root),json.dumps(result))
                self.assertEqual(admin.get('/api/config').headers['x-frame-options'],'DENY')

    def test_growth_diagnostics_are_private_and_snapshot_must_be_fresh(self):
        snapshot=self.root/'growth.json'
        self.site['growthDiagnosticsFile']=str(snapshot)
        data={'schemaVersion':1,'generatedAt':dt.datetime.fromtimestamp(self.now,dt.timezone.utc).isoformat(),
              'requests':2,'statusCounts':{'422':1,'408':1},'errorCounts':{'sdk_service_500002':1},
              'recentFailures':[{'time':'2026-09-28T04:00:00+00:00','requestId':'a'*32,'status':422,
                                 'route':'growth','stage':'sdk_login','error':'sdk_service_500002','reason':'unclassified'}]}
        snapshot.write_text(json.dumps(data))
        with self.client() as collector:
            self.assertEqual(collector.get('/growth/test').status_code,401)
            def transport(source,path,*args):
                response=collector.get(path,headers={'Authorization':'Bearer '+'r'*40})
                response.raise_for_status()
                return response.json()
            with TestClient(create_admin(self.admin_config(True),transport),base_url='http://127.0.0.1:18080') as admin:
                response=admin.get('/api/growth/test')
                self.assertEqual(response.json()['data']['recentFailures'][0]['error'],'sdk_service_500002')
                self.assertNotIn(str(snapshot),response.text)
            data['generatedAt']=dt.datetime.fromtimestamp(self.now-301,dt.timezone.utc).isoformat()
            snapshot.write_text(json.dumps(data))
            self.assertEqual(collector.get('/growth/test',headers={'Authorization':'Bearer '+'r'*40}).json()['status'],'unavailable')

    def test_load_rollup_preserves_peak_and_does_not_count_both_resolutions(self):
        store=Store(self.root/'load.sqlite')
        try:
            for i,value in enumerate([1,8,3]):
                sample={'ts':self.now+i*5,'elapsed':5,'rxBytes':100,'txBytes':value*100,'rxMbps':.1,'txMbps':value,'active':5,'rps':10}
                store.add_load('nginx',sample)
                store.add_load('nginx',sample)
            short=store.loads('nginx',3600,self.now+15)
            long=store.loads('nginx',86400,self.now+15)
            self.assertEqual(len(short['points']),3)
            self.assertEqual(len(long['points']),1)
            self.assertEqual(long['points'][0]['txPeakMbps'],8)
            self.assertEqual(long['points'][0]['txMbps'],4)
            self.assertEqual(long['totals']['today']['txBytes'],1200)
            self.assertEqual(long['totals']['month']['txBytes'],1200)
            self.assertEqual(long['totals']['today']['coveredSeconds'],15)
        finally:store.close()


if __name__=='__main__':unittest.main()
