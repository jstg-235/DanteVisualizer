"""Tests for recognising Dante networks (workspaces). Run: python3 -m unittest server/test_workspaces.py"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from workspaces import Workspaces  # noqa: E402


def model(names, offline=(), leader=None):
    devs = [{"name": n, "online": True, "info": {"mac": "m-" + n, "clockRole": "Leader" if n == leader else "Follower"},
             "tx": [], "rx": []} for n in names]
    devs += [{"name": n, "online": False, "info": {}, "tx": [], "rx": []} for n in offline]
    return {"source": "live", "name": "Live network (en11)", "devices": devs}


HY4 = ["DSP-R10-HY4", "AXCore", "Fourier", "HarrisonD510", "Rio-A"]
HY2 = ["RXEX-HY2", "Broadcast", "Neve-1", "Neve-2", "Neve-3", "LOOMIS-UAD"]


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ws = Workspaces(self.tmp.name, log=lambda m: None, settle=0)
        self.switches = []
        self.ws.on_switch.append(lambda old, new, iface: self.switches.append((old, new)))

    def tearDown(self):
        self.tmp.cleanup()

    def test_first_network_starts_a_workspace_named_after_the_leader(self):
        out = self.ws.observe(model(HY4, leader="DSP-R10-HY4"), "en11")
        self.assertEqual(out["workspace"]["name"], "DSP-R10-HY4")
        self.assertEqual(out["name"], "DSP-R10-HY4 (en11)")
        self.assertTrue(out["networkKey"].startswith("ws:"))
        self.assertEqual(len(self.switches), 1)

    def test_a_different_network_is_asked_about_not_switched(self):
        self.ws.observe(model(HY4), "en11")
        first = self.ws.active("en11")["id"]
        self.ws.observe(model(HY2, offline=HY4), "en11")
        st = self.ws.status("en11")
        self.assertEqual(st["suggest"]["kind"], "new")
        self.assertEqual(st["active"]["id"], first)

    def test_old_networks_offline_devices_are_hidden_after_switching(self):
        self.ws.observe(model(HY4), "en11")
        self.ws.observe(model(HY2, offline=HY4), "en11")
        self.ws.switch("en11", new_name="HY2")
        out = self.ws.observe(model(HY2, offline=HY4), "en11")
        self.assertEqual(sorted(d["name"] for d in out["devices"]), sorted(HY2))
        self.assertEqual(out["hidden"], len(HY4))

    def test_coming_back_suggests_the_known_workspace(self):
        self.ws.observe(model(HY4), "en11")
        hy4 = self.ws.active("en11")["id"]
        self.ws.observe(model(HY2), "en11")
        self.ws.switch("en11", new_name="HY2")
        self.ws.observe(model(HY4, offline=HY2), "en11")
        sug = self.ws.status("en11")["suggest"]
        self.assertEqual((sug["kind"], sug["to"]), ("switch", hy4))

    def test_missing_devices_on_the_same_network_stay_and_ask_nothing(self):
        self.ws.observe(model(HY4), "en11")
        out = self.ws.observe(model(HY4[:3], offline=HY4[3:]), "en11")
        self.assertIsNone(self.ws.status("en11")["suggest"])
        self.assertEqual(len(out["devices"]), len(HY4))
        self.assertEqual(self.ws.status("en11")["active"]["missing"], sorted(HY4[3:]))

    def test_one_new_device_is_learned_a_crowd_is_asked_about(self):
        self.ws.observe(model(HY4), "en11")
        self.ws.observe(model(HY4 + ["NewMic"]), "en11")
        self.assertIn("NewMic", self.ws.active("en11")["devices"])
        self.ws.observe(model(HY4 + ["NewMic", "X1", "X2", "X3"]), "en11")
        self.assertEqual(self.ws.status("en11")["suggest"]["kind"], "add")

    def test_keep_stops_asking_until_the_network_changes(self):
        self.ws.observe(model(HY4), "en11")
        self.ws.observe(model(HY2), "en11")
        self.ws.keep("en11")
        self.ws.observe(model(HY2), "en11")
        self.assertIsNone(self.ws.status("en11")["suggest"])

    def test_clear_rebuilds_from_whats_online(self):
        self.ws.observe(model(HY4), "en11")
        self.ws.observe(model(HY4[:2], offline=HY4[2:]), "en11")
        self.ws.clear("en11")
        self.assertEqual(sorted(self.ws.active("en11")["devices"]), sorted(HY4[:2]))

    def test_forget_hides_an_offline_device(self):
        self.ws.observe(model(HY4), "en11")
        self.ws.forget("en11", "Rio-A")
        out = self.ws.observe(model(HY4[:-1], offline=["Rio-A"]), "en11")
        self.assertNotIn("Rio-A", [d["name"] for d in out["devices"]])

    def test_two_ports_keep_their_own_workspace_and_state_survives_a_restart(self):
        self.ws.observe(model(HY4), "en11")
        self.ws.observe(model(HY2), "en9")
        self.assertEqual(self.ws.status("en9")["suggest"]["kind"], "new")    # asks, even on another port
        self.ws.switch("en9", new_name="HY2")
        self.ws.set_layout(self.ws.active("en9")["id"], {"positions": {"a": 1}})
        again = Workspaces(self.tmp.name, log=lambda m: None, settle=0)
        self.assertEqual(again.active("en9")["name"], "HY2")
        self.assertNotEqual(again.active("en11")["id"], again.active("en9")["id"])
        self.assertEqual(again.get_layout(again.active("en9")["id"]), {"positions": {"a": 1}})


    def test_named_after_the_clock_leader_the_monitor_hears_without_its_serial_tag(self):
        names = ["AXCore-035b97", "Y001-Yamaha-DSP-R10-HY4-26a7da", "Fourier"]
        ws = Workspaces(None, log=lambda m: None, settle=0, leader=lambda: "Y001-Yamaha-DSP-R10-HY4-26a7da")
        out = ws.observe(model(names), "en11")
        self.assertEqual(out["workspace"]["name"], "Y001-Yamaha-DSP-R10-HY4")

    def test_first_workspace_waits_for_the_network_to_settle(self):
        ws = Workspaces(None, log=lambda m: None, settle=60)
        out = ws.observe(model(HY4), "en11")
        self.assertIsNone(out["networkKey"])


class HistoryMoveTests(unittest.TestCase):
    def test_move_takes_over_or_carries_recent_events(self):
        from monitor.engine import EventLog
        with tempfile.TemporaryDirectory() as d:
            log = EventLog(os.path.join(d, "old.sqlite"))
            log.add("info", "x", "a", "before", ts=100)
            log.add("info", "x", "b", "after start", ts=200)
            log.move_to(os.path.join(d, "taken.sqlite"), take_over=True)
            self.assertEqual(len(log.recent()), 2)
            log.move_to(os.path.join(d, "carried.sqlite"), carry_since=150)
            self.assertEqual([e["message"] for e in log.recent()], ["after start"])
            log.add("info", "x", "c", "new")
            self.assertEqual(len(log.recent()), 2)


if __name__ == "__main__":
    unittest.main()
