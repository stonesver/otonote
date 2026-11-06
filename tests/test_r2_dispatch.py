import fcntl
import json
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock
from urllib.error import HTTPError, URLError
from tools.r2_dispatch import CalendarUnavailable, NoRedirect, dispatch


class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.token = self.root / 'token'
        self.token.write_text('github_pat_test_secret')
        self.token.chmod(0o600)
        self.state = self.root / 'state'
        self.sent = []

    def tearDown(self):
        self.temp.cleanup()

    def send(self, request, timeout):
        self.sent.append((request, timeout))
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.getcode.return_value = 200
        response.read.return_value = b'{"workflow_run_id":123}'
        return response

    def run_dispatch(self, now=1800, region='global', send=None):
        return dispatch('stonesver/otonote', region, self.token, self.state,
                        now=now, send=send or self.send)

    def test_acceptance_is_not_completion_and_mode_respects_actions_policy(self):
        result = self.run_dispatch()
        self.assertEqual(result['status'], 'accepted')
        request, timeout = self.sent[0]
        self.assertEqual(timeout, 15)
        self.assertEqual(request.full_url, 'https://api.github.com/repos/stonesver/otonote/actions/workflows/content-r2.yml/dispatches')
        self.assertEqual(json.loads(request.data), {'ref': 'main', 'inputs': {'region': 'global', 'mode': 'auto', 'dispatch_id':'probe-1800', 'scheduled_for':''}, 'return_run_details':True})
        self.assertEqual(result['runId'],123)
        self.assertNotIn('secret', json.dumps(result))
        self.assertEqual(json.loads((self.state/'global-probe.json').read_text()), result)
        self.assertEqual((self.state/'global-probe.json').stat().st_mode & 0o777, 0o600)

    def test_one_attempt_per_slot_per_region_and_no_missed_slot_replay(self):
        self.run_dispatch()
        self.assertEqual(self.run_dispatch(1850)['runId'], 123)
        self.assertEqual(self.run_dispatch(1700)['reason'], 'clock_moved_backwards')
        self.run_dispatch(region='jp')
        self.run_dispatch(90000)
        self.assertEqual(len(self.sent), 3)

    def test_timeout_preserves_last_acceptance_and_does_not_retry_ambiguous_send(self):
        first = self.run_dispatch()
        send = Mock(side_effect=URLError('secret internal error'))
        result = self.run_dispatch(2700, send=send)
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['lastAcceptedAt'], first['lastAcceptedAt'])
        self.assertNotIn('secret', json.dumps(result))
        self.assertEqual(self.run_dispatch(2800, send=send)['status'], 'unknown')
        self.assertEqual(send.call_count, 2)
        self.assertEqual(send.call_args[0][0].get_method(), 'GET')

    def test_http_failure_reports_only_status_code(self):
        for index, body in enumerate((None, io.BytesIO(b'secret response body'))):
            send = Mock(side_effect=HTTPError('https://api.github.com', 401, 'secret', {}, body))
            result = self.run_dispatch(now=1800 + index * 900, send=send)
            self.assertEqual((result['status'], result['httpStatus']), ('failed', 401))
            self.assertNotIn('secret', json.dumps(result))
            if body is not None: self.assertTrue(body.closed)

    def test_redirects_are_rejected_before_credentials_can_leave_github(self):
        with self.assertRaises(HTTPError):
            NoRedirect().redirect_request(Mock(full_url='https://api.github.com'), None,
                                          302, 'redirect', {}, 'https://elsewhere.invalid')

    def test_concurrent_dispatch_is_skipped(self):
        self.state.mkdir(mode=0o700)
        with (self.state/'global.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.run_dispatch()['reason'], 'already_running')
        self.assertEqual(self.sent, [])

    def test_public_or_linked_credentials_and_state_are_rejected(self):
        self.token.chmod(0o644)
        with self.assertRaises(ValueError): self.run_dispatch()
        self.token.chmod(0o600)
        link = self.root/'linked-token'
        link.symlink_to(self.token)
        with self.assertRaises(OSError):
            dispatch('stonesver/otonote', 'global', link, self.state, now=1800, send=self.send)
        self.state.chmod(0o755)
        with self.assertRaises(ValueError): self.run_dispatch()
        self.assertEqual(self.sent, [])

    def test_invalid_target_and_corrupt_state_never_dispatch(self):
        for repo in ('a/..', 'a/b/c', 'https://elsewhere.invalid', 'a/b?token=x'):
            with self.assertRaises(ValueError):
                dispatch(repo, 'global', self.token, self.state, now=1800, send=self.send)
        self.state.mkdir(mode=0o700)
        (self.state/'global-probe.json').write_text('{')
        (self.state/'global-probe.json').chmod(0o600)
        with self.assertRaises(ValueError): self.run_dispatch()
        self.assertEqual(self.sent, [])

    def test_planned_slot_dedup_survives_quarter_hour_boundaries(self):
        args = ('stonesver/otonote', 'global', self.token, self.state)
        first = dispatch(*args, now=6*3600, send=self.send, scheduled=True, calendar={})
        second = dispatch(*args, now=6*3600+901, send=self.send, scheduled=True, calendar={})
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(first['scheduledFor'], '1970-01-01T06:00:00Z')
        self.assertEqual(second['runId'], first['runId'])
        dispatch(*args, now=11*3600, send=self.send, scheduled=True, calendar={})
        self.assertEqual(len(self.sent), 2)

    def test_ambiguous_post_reconciles_exact_run_without_another_post(self):
        self.run_dispatch(send=Mock(side_effect=URLError('lost acknowledgement')))
        def lookup(request, timeout):
            self.assertEqual(request.get_method(), 'GET')
            response = self.send(request, timeout)
            response.read.return_value = json.dumps({'workflow_runs':[
                {'id':99,'display_title':'unrelated','event':'workflow_dispatch','head_branch':'main'},
                {'id':321,'display_title':'Content update / global / probe-1800',
                 'event':'workflow_dispatch','head_branch':'main'}]}).encode()
            return response
        result = self.run_dispatch(1850, send=lookup)
        self.assertEqual((result['status'],result['runId']), ('accepted',321))
        self.assertEqual(self.run_dispatch(1860)['runId'],321)
        self.assertEqual(len(self.sent),1)

    def test_missing_run_is_not_permission_to_repeat_an_ambiguous_post(self):
        self.run_dispatch(send=Mock(side_effect=URLError('lost acknowledgement')))
        def lookup(request, timeout):
            self.assertEqual(request.get_method(),'GET')
            response=self.send(request,timeout)
            response.read.return_value=b'{"workflow_runs":[]}'
            return response
        self.assertEqual(self.run_dispatch(1850,send=lookup)['status'],'unknown')
        self.assertEqual(self.run_dispatch(1900,send=lookup)['status'],'unknown')

    def test_rate_limit_is_retried_with_a_bound(self):
        rejected=Mock(side_effect=HTTPError('https://api.github.com',429,'rate limit',{},None))
        self.run_dispatch(send=rejected)
        self.assertEqual(self.run_dispatch(1810,send=rejected)['attempts'],1)
        self.run_dispatch(1860,send=rejected)
        self.run_dispatch(2160,send=rejected)
        self.run_dispatch(2190,send=rejected)
        self.assertEqual(rejected.call_count,3)

    def test_probe_cannot_suppress_first_scheduled_check(self):
        self.run_dispatch(now=6*3600)
        dispatch('stonesver/otonote','global',self.token,self.state,now=6*3600+5,
                 send=self.send,scheduled=True,calendar={})
        self.assertEqual(len(self.sent),2)

    def test_calendar_fetch_does_not_receive_the_token(self):
        def serve(request,timeout):
            response=self.send(request,timeout)
            if '/contents/config/' in request.full_url:
                self.assertIsNone(request.get_header('Authorization'))
                response.read.return_value=b'{"schemaVersion":1,"activityChecks":[]}'
            return response
        result=dispatch('stonesver/otonote','global',self.token,self.state,now=6*3600,
                        send=serve,scheduled=True)
        self.assertEqual(result['status'],'accepted')
        self.assertEqual(len(self.sent),2)
        dispatch('stonesver/otonote','jp',self.token,self.state,now=6*3600+5,send=serve,scheduled=True)
        self.assertEqual(len(self.sent),3)  # The second edition shares the public calendar read.

    def test_probe_and_calendar_revision_cannot_replay_an_older_slot(self):
        calendar={'schemaVersion':1,'activityChecks':[{'at':'1970-01-01T06:05:00Z','regions':['global']}]}
        args=('stonesver/otonote','global',self.token,self.state)
        dispatch(*args,now=6*3600,send=self.send,scheduled=True,calendar=calendar)
        self.run_dispatch(now=6*3600+1)
        dispatch(*args,now=6*3600+2,send=self.send,scheduled=True,calendar=calendar)
        self.assertEqual(len(self.sent),2)
        dispatch(*args,now=6*3600+300,send=self.send,scheduled=True,calendar=calendar)
        dispatch(*args,now=6*3600+301,send=self.send,scheduled=True,calendar={})
        self.assertEqual(len(self.sent),3)

    def test_rate_limit_reset_is_respected(self):
        rejected=Mock(side_effect=HTTPError('https://api.github.com',403,'rate limit',
            {'X-RateLimit-Remaining':'0','X-RateLimit-Reset':'2500'},None))
        self.run_dispatch(send=rejected)
        self.run_dispatch(2400,send=rejected)
        self.assertEqual(rejected.call_count,1)
        self.run_dispatch(2500,send=rejected)
        self.assertEqual(rejected.call_count,2)

    def test_expired_calendar_failure_does_not_post_or_use_stale_dates(self):
        args=('stonesver/otonote','global',self.token,self.state)
        def serve(request,timeout):
            response=self.send(request,timeout)
            if '/contents/config/' in request.full_url:
                response.read.return_value=b'{"schemaVersion":1,"activityChecks":[]}'
            return response
        dispatch(*args,now=6*3600,send=serve,scheduled=True)
        unavailable=Mock(side_effect=URLError('network unavailable'))
        with self.assertRaises(CalendarUnavailable):
            dispatch(*args,now=6*3600+301,send=unavailable,scheduled=True)
        result=dispatch(*args,now=6*3600+302,send=serve,scheduled=True)
        self.assertEqual(result['runId'],123)
        self.assertEqual(sum(request.get_method()=='POST' for request,_ in self.sent),1)
