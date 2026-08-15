import datetime as dt
import importlib.util
import json
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location("source_result",ROOT/"scripts/source_monitor_result.py")
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
from scripts import source_monitor as sm


class SourceMonitorResultTests(unittest.TestCase):
    def snapshots(self,prior_outcome="ok",current_outcome="ok",category="emergency",count=1):
        data={"countries":[{"country":"X","hotlines":[{"id":f"weh_{i}","name":str(i),"category":category,
              "website":f"https://example.org/{i}","sources":[],"voice_numbers":[str(100+i)]} for i in range(count)]}]}
        raw=json.dumps(data).encode()
        self.raw=raw
        def fetch(outcome):
            return lambda url:{"outcome":outcome,"http_status":200 if outcome=="ok" else None,"final_url":url,"text":"100" if outcome=="ok" else "","truncated":False,"error":None if outcome=="ok" else "failure"}
        prior=sm.build(data,raw,dt.date(2026,8,14),count,None,fetch(prior_outcome))
        current=sm.build(data,raw,dt.date(2026,8,15),count,prior,fetch(current_outcome))
        return prior,current

    def test_stable_critical_failure_continuing_recovery_and_blocked(self):
        prior,current=self.snapshots(); self.assertEqual(module.build(current,prior,self.raw)["status"],"ok")
        prior,failed=self.snapshots("ok","fetch_failure"); result=module.build(failed,prior,self.raw)
        self.assertIn("source_critical_fetch_failure",{x["code"] for x in result["issues"]})
        self.assertNotIn("example.org",json.dumps(result))
        later=json.loads(json.dumps(failed)); later["as_of"]=later["checked_at"]="2026-08-16"
        for row in later["observations"]: row["as_of"]=row["checked_at"]="2026-08-16"
        continuing=module.build(later,failed,self.raw); self.assertEqual(continuing["status"],"regression")
        failed_prior,recovered=self.snapshots("fetch_failure","ok"); self.assertEqual(module.build(recovered,failed_prior,self.raw)["status"],"ok")
        prior,blocked=self.snapshots("ok","blocked"); self.assertIn("source_critical_blocked",{x["code"] for x in module.build(blocked,prior,self.raw)["issues"]})

    def test_noncritical_failure_content_change_and_all_degraded_policy(self):
        prior,current=self.snapshots("ok","fetch_failure","general_support",2)
        # The deterministic cohort size is still one; failure is critical only by selected position,
        # while total degradation independently catches the complete collapse.
        result=module.build(current,prior,self.raw); self.assertIn("source_total_degradation",{x["code"] for x in result["issues"]})
        mixed=json.loads(json.dumps(current)); mixed["summary"]["degraded"]=False
        with self.assertRaises(ValueError): module.build(mixed,prior,self.raw)

    def test_baseline_failure_does_not_invent_new_failure(self):
        _,current=self.snapshots("fetch_failure","fetch_failure")
        result=module.build(current,None,self.raw)
        self.assertEqual({x["code"] for x in result["issues"]},{"source_total_degradation"})

    def test_critical_new_url_and_new_record_fail_with_usable_prior(self):
        old={"countries":[{"country":"X","hotlines":[
            {"id":"weh_a","name":"A","category":"emergency","website":"https://example.org/old","sources":[],"voice_numbers":["100"]},
            {"id":"weh_b","name":"B","category":"emergency","website":"https://example.org/healthy","sources":[],"voice_numbers":["101"]}]}]}
        prior=sm.build(old,json.dumps(old).encode(),dt.date(2026,8,14),2,None,
            lambda url:{"outcome":"ok","http_status":200,"final_url":url,"text":"100 101","truncated":False})
        for record_id in ("weh_a","weh_0_new"):
            current=json.loads(json.dumps(old)); current["countries"][0]["hotlines"][0].update(id=record_id,website="https://example.org/new")
            raw=json.dumps(current).encode()
            snapshot=sm.build(current,raw,dt.date(2026,8,15),2,prior,
                lambda url:{"outcome":"fetch_failure","http_status":None,"final_url":url,"text":"","truncated":False,"error":"failure"}
                    if url.endswith("/new") else {"outcome":"ok","http_status":200,"final_url":url,"text":"101","truncated":False})
            codes={issue["code"] for issue in module.build(snapshot,prior,raw)["issues"]}
            with self.subTest(record_id=record_id):
                self.assertIn("source_critical_fetch_failure",codes)
                self.assertNotIn("source_total_degradation",codes)

    def test_first_run_mixed_critical_failure_and_noncritical_churn_policy(self):
        _,current=self.snapshots("ok","ok",count=2)
        failed=json.loads(json.dumps(current)); row=failed["observations"][0]
        row.update(outcome="fetch_failure",http_status=None,contact_present=None,content_fingerprint=None,
                   error="failure",triage_state="review_prompt",changes=["fetch_failure"])
        failed["summary"].update(ok=1,failure=1,changed=1,new=0,degraded=False)
        self.assertEqual(module.build(failed,None,self.raw)["issues"],[])
        # A failure outside the deterministic critical prefix remains review-only.
        data={"countries":[{"country":"X","hotlines":[{"id":f"weh_{i}","name":str(i),"category":"general_support",
              "website":f"https://example.org/{i}","sources":[],"voice_numbers":[str(100+i)]} for i in range(2)]}]}
        raw=json.dumps(data).encode()
        prior=sm.build(data,raw,dt.date(2026,8,14),2,None,
            lambda url:{"outcome":"ok","http_status":200,"final_url":url,"text":"100 101","truncated":False})
        noncritical=sm.build(data,raw,dt.date(2026,8,15),2,prior,
            lambda url:{"outcome":"fetch_failure","http_status":None,"final_url":url,"text":"","truncated":False,"error":"failure"}
                if url.endswith("/1") else {"outcome":"ok","http_status":200,"final_url":url,"text":"100","truncated":False})
        self.assertEqual(module.build(noncritical,prior,raw)["issues"],[])

    def test_strict_snapshot_boundary_rejects_forged_or_incomplete_v3(self):
        prior,current=self.snapshots()
        mutations=(lambda x:x["summary"].update(ok=0),
                   lambda x:x["summary"].update(eligible=x["summary"]["eligible"]+1),
                   lambda x:x["observations"].append(dict(x["observations"][0])),
                   lambda x:x["observations"].clear(),
                   lambda x:x["population"].update(digest="sha256:"+"0"*64),
                   lambda x:x.update(unknown=True),
                   lambda x:x.update(as_of="2026-8-15"))
        for mutate in mutations:
            bad=json.loads(json.dumps(current)); mutate(bad)
            with self.assertRaises(ValueError): module.build(bad,prior,self.raw)

    def test_previous_must_be_strictly_older(self):
        _,current=self.snapshots()
        with self.assertRaisesRegex(ValueError,"predate"): module.build(current,current,self.raw)


if __name__=="__main__": unittest.main()
