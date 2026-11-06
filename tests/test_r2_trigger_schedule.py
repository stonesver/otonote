import unittest
from tools.r2_schedule import due_slot, slot_time
from tools.arena_sync import select_regions


class TriggerScheduleTests(unittest.TestCase):
    def test_fixed_slots_and_latest_only_catchup(self):
        self.assertEqual(due_slot(12*3600, 'global', {}), 11*3600)
        self.assertEqual(due_slot(5*3600, 'jp', {}), -5*3600)
        self.assertEqual(due_slot(4*86400+12*3600, 'jp', {}), 4*86400+11*3600)

    def test_activity_boundary_is_regional_and_never_early(self):
        calendar = {'schemaVersion':1,'activityChecks':[{'at':'1970-01-01T12:05:00Z','regions':['jp']}]}
        point = 12*3600+5*60
        self.assertEqual(due_slot(point-1, 'jp', calendar), 11*3600)
        self.assertEqual(due_slot(point, 'jp', calendar), point)
        self.assertEqual(due_slot(point, 'global', calendar), 11*3600)
        self.assertEqual(select_regions(['global','jp'],event='workflow_dispatch',requested='jp',
            calendar=calendar,now=point+20,scheduled_for=slot_time(point)), ['jp'])
        self.assertEqual(select_regions(['jp'],event='workflow_dispatch',requested='jp',
            calendar=calendar,now=19*3600+5,scheduled_for=slot_time(point)), [])
        self.assertEqual(select_regions(['jp'],event='workflow_dispatch',requested='jp',
            calendar=calendar,now=point-1,scheduled_for=slot_time(point)), [])
