import datetime as dt
import importlib.util
import subprocess
import tempfile
import unittest
import urllib.error
import json
from unittest import mock
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location("sc",ROOT/"scripts/search_console_monitor.py")
sc=importlib.util.module_from_spec(spec); spec.loader.exec_module(sc)


class Result:
    def __init__(self,code=0,out="token",err="sensitive"): self.returncode=code; self.stdout=out; self.stderr=err


class SearchConsoleTests(unittest.TestCase):
    def test_as_of_is_canonical_before_credentials_transport_or_publication(self):
        invalid=("not-a-date","2026-02-30","2026-08-15T00:00:00","2026-08-15 trailing"," 2026-08-15","2026-08-15 ","2026-8-5")
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for index,value in enumerate(invalid):
                out=root/f"bad-{index}.json"; report=root/f"bad-{index}.md"
                with mock.patch.object(sc,"guard_paths") as guard, mock.patch.object(sc,"get_token") as token, \
                     mock.patch.object(sc,"run") as run, mock.patch.object(sc,"coordinated_write") as write:
                    with self.assertRaises(SystemExit):
                        sc.main(["--quota-project","quota","--as-of",value,"--json-output",str(out),"--markdown-output",str(report)])
                guard.assert_not_called(); token.assert_not_called(); run.assert_not_called(); write.assert_not_called()
                self.assertFalse(out.exists()); self.assertFalse(report.exists())

    def test_canonical_date_boundaries_emit_shared_valid_results(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for index,value in enumerate(("0001-01-01","9999-12-31")):
                out=root/f"ok-{index}.json"; report=root/f"ok-{index}.md"
                fixture={"schema_version":"1.0","monitor":"search-console","as_of":value,"status":"ok","issues":[],"metrics":{}}
                with mock.patch.object(sc,"get_token",return_value="token"), mock.patch.object(sc,"run",return_value=fixture):
                    self.assertEqual(sc.main(["--quota-project","quota","--as-of",value,"--json-output",str(out),"--markdown-output",str(report)]),0)
                self.assertEqual(sc.validate_result(json.loads(out.read_text()))["as_of"],value)

    def test_adc_failures_are_distinct_and_do_not_include_output(self):
        cases=[(lambda *a,**k: (_ for _ in()).throw(FileNotFoundError()),"gcloud_missing"),
               (lambda *a,**k: Result(1,"secret","private path"),"adc_unavailable"),
               (lambda *a,**k: Result(0,""),"adc_empty")]
        for runner,code in cases:
            with self.assertRaises(sc.MonitorError) as caught: sc.get_token(runner)
            self.assertEqual(caught.exception.code,code); self.assertNotIn("secret",str(caught.exception))

    def test_api_error_classification(self):
        self.assertEqual(sc.classify_api_error(401,""),"adc_unauthorized")
        self.assertEqual(sc.classify_api_error(403,"API has not been used or is disabled"),"api_disabled")
        self.assertEqual(sc.classify_api_error(403,"invalid quota project consumer"),"quota_project_error")
        self.assertEqual(sc.classify_api_error(403,"denied"),"property_permission_denied")

    def test_complete_day_windows_exact_boundary(self):
        self.assertEqual(tuple(x.isoformat() for x in sc.windows(dt.date(2026,8,15))),
                         ("2026-06-17","2026-07-14","2026-07-15","2026-08-11"))
        body=sc.analytics_body(dt.date(2026,7,15),dt.date(2026,8,11))
        self.assertEqual(body["dimensions"],["date"]); self.assertEqual(body["dataState"],"final")
        self.assertNotIn("query",str(body).casefold())
        self.assertIsNone(sc.change(5,0)); self.assertEqual(sc.change(5,10),-.5)

    def test_read_only_fixed_calls_and_five_url_limit(self):
        calls=[]
        def request(method,url,token,quota,body=None):
            calls.append((method,url,body))
            if "searchAnalytics" in url:
                day=body["startDate"]
                return {"responseAggregationType":"byProperty","rows":[{"keys":[day],"clicks":1,"impressions":10,"ctr":.1,"position":2}]}
            if url.endswith("/sitemaps"): return {"sitemap":[{"path":sc.SITEMAP,"isPending":False}]}
            if body["inspectionUrl"].endswith("/status"):
                return {"inspectionResult":{"indexStatusResult":{"verdict":"NEUTRAL","coverageState":"Excluded by noindex tag","indexingState":"BLOCKED_BY_META_TAG"}}}
            return {"inspectionResult":{"indexStatusResult":{"verdict":"PASS","coverageState":"Indexed"}}}
        urls=list(sc.REPRESENTATIVES)+[sc.REPRESENTATIVES[0],"https://evil.invalid/"]
        report=sc.run(dt.date(2026,8,15),"quota","token",request,urls)
        self.assertEqual(report["status"],"ok")
        inspection=[c for c in calls if c[1]==sc.INSPECT_URL]
        self.assertLessEqual(len(inspection),5); self.assertEqual(len(inspection),len(sc.REPRESENTATIVES))
        self.assertTrue(all(c[0] in {"GET","POST"} for c in calls))
        self.assertNotIn("query",str(report).casefold())

    def test_sitemap_states_never_claim_indexing(self):
        self.assertEqual(sc.sitemap_state([])["registration"],"missing")
        self.assertEqual(sc.sitemap_state([{"path":sc.SITEMAP,"isPending":True}])["processing"],"pending")
        self.assertEqual(sc.sitemap_state([{"path":sc.SITEMAP,"warnings":2}])["processing"],"warning")
        self.assertEqual(sc.sitemap_state([{"path":sc.SITEMAP,"errors":1}])["processing"],"error")
        self.assertNotIn("indexed",str(sc.sitemap_state([{"path":sc.SITEMAP}])).casefold())

    def test_duplicate_sitemap_paths_fail_regardless_of_order(self):
        good={"path":sc.SITEMAP,"isPending":False}
        bad={"path":sc.SITEMAP,"errors":"1"}
        for rows in ([good,bad],[bad,good]):
            with self.assertRaisesRegex(sc.MonitorError,"duplicate sitemap"):
                sc.validate_sitemaps({"sitemap":rows})

    def test_property_aggregation_is_requested_and_strictly_required(self):
        body=sc.analytics_body(dt.date(2026,7,15),dt.date(2026,8,11))
        self.assertEqual(body["aggregationType"],"byProperty")
        for value in (None,True,False,"auto","byPage",""):
            response={"rows":[]}
            if value is not None: response["responseAggregationType"]=value
            with self.assertRaises(sc.MonitorError) as caught:
                sc.validate_analytics(response,dt.date(2026,7,15),dt.date(2026,8,11))
            self.assertEqual(caught.exception.code,"api_schema_invalid")

    def test_every_endpoint_rejects_malformed_and_extreme_responses(self):
        def valid_analytics(body):
            return {"responseAggregationType":"byProperty","rows":[{"keys":[body["startDate"]],"clicks":1,"impressions":10,"ctr":.1,"position":2}]}
        def run_with(replacement, endpoint):
            def request(method,url,token,quota,body=None):
                if "searchAnalytics" in url: return replacement if endpoint=="analytics" else valid_analytics(body)
                if url.endswith("/sitemaps"): return replacement if endpoint=="sitemap" else {"sitemap":[{"path":sc.SITEMAP,"isPending":False}]}
                return replacement if endpoint=="inspection" else {"inspectionResult":{"indexStatusResult":{"verdict":"PASS","coverageState":"Indexed"}}}
            with self.assertRaises(sc.MonitorError) as caught: sc.run(dt.date(2026,8,15),"quota","token",request)
            self.assertEqual(caught.exception.code,"api_schema_invalid")
        for value in ([],{"responseAggregationType":"byProperty","rows":"bad"},{"responseAggregationType":"byProperty","rows":[{"keys":["2026-99-99"],"clicks":1,"impressions":1,"ctr":1,"position":1}]},
                      {"responseAggregationType":"byProperty","rows":[{"keys":["2026-07-18"],"clicks":float("inf"),"impressions":1,"ctr":1,"position":1}]}):
            run_with(value,"analytics")
        for value in ([],{"sitemap":"bad"},{"sitemap":[{"path":sc.SITEMAP,"warnings":"9999999999"}]}): run_with(value,"sitemap")
        for value in ([],{}, {"inspectionResult":{"indexStatusResult":{"verdict":123}}}): run_with(value,"inspection")

    def test_full_documented_response_families_are_validated_then_discarded(self):
        sitemap={"sitemap":[{"path":sc.SITEMAP,"lastSubmitted":"2026-08-14T10:11:12Z","isPending":False,
            "isSitemapsIndex":False,"type":"sitemap","lastDownloaded":"2026-08-15T10:11:12+00:00","warnings":"2","errors":"0",
            "contents":[{"type":"web","submitted":"321","indexed":"300"}]}]}
        clean_sitemaps=sc.validate_sitemaps(sitemap)
        self.assertNotIn("contents",clean_sitemaps[0]); self.assertNotIn("type",clean_sitemaps[0])
        inspection={"inspectionResult":{"inspectionResultLink":"https://search.google.com/search-console/inspect?resource_id=x",
            "indexStatusResult":{"verdict":"PASS","coverageState":"Submitted and indexed","robotsTxtState":"ALLOWED",
                "indexingState":"INDEXING_ALLOWED","lastCrawlTime":"2026-08-14T10:11:12Z","pageFetchState":"SUCCESSFUL",
                "googleCanonical":"https://worldhotlines.org/","userCanonical":"https://worldhotlines.org/","crawledAs":"MOBILE",
                "referringUrls":["https://worldhotlines.org/country/us"],"sitemap":[sc.SITEMAP]},
            "mobileUsabilityResult":{"verdict":"PASS","issues":[{"issueType":"MOBILE_FRIENDLY_RULE","message":"ok"}]},
            "richResultsResult":{"verdict":"PASS","detectedItems":[{"richResultType":"Breadcrumbs","items":[
                {"name":"Breadcrumb","issues":[{"issueMessage":"informational","severity":"WARNING"}]}]}]}}}
        clean=sc.validate_inspection(inspection)
        self.assertEqual(set(clean["inspectionResult"]),{"indexStatusResult"})
        self.assertEqual(set(clean["inspectionResult"]["indexStatusResult"]),{"verdict","coverageState","robotsTxtState","indexingState","pageFetchState"})

    def test_aggregate_decline_policy_boundaries(self):
        self.assertEqual((sc.MIN_PRIOR_CLICKS,sc.CLICK_DECLINE_THRESHOLD),(20.0,.5))
        self.assertEqual((sc.MIN_PRIOR_IMPRESSIONS,sc.IMPRESSION_DECLINE_THRESHOLD),(200.0,.4))
        def report(prior_clicks,current_clicks,prior_impressions,current_impressions):
            calls=0
            def request(method,url,token,quota,body=None):
                nonlocal calls
                if "searchAnalytics" in url:
                    calls+=1; clicks=current_clicks if calls==1 else prior_clicks; impressions=current_impressions if calls==1 else prior_impressions
                    return {"responseAggregationType":"byProperty","rows":[{"keys":[body["startDate"]],"clicks":clicks,"impressions":impressions,"ctr":clicks/impressions if impressions else 0,"position":1}]}
                if url.endswith("/sitemaps"): return {"sitemap":[{"path":sc.SITEMAP}]}
                if body["inspectionUrl"].endswith("/status"): return {"inspectionResult":{"indexStatusResult":{"verdict":"NEUTRAL","coverageState":"Excluded by noindex tag","indexingState":"BLOCKED_BY_META_TAG"}}}
                return {"inspectionResult":{"indexStatusResult":{"verdict":"PASS","coverageState":"Indexed"}}}
            return sc.run(dt.date(2026,8,15),"quota","token",request)
        for values in ((0,0,0,0),(19,0,199,0),(20,11,200,121),(20,21,200,201)):
            self.assertEqual(report(*values)["status"],"ok")
        exact=report(20,10,200,120); self.assertEqual({x["code"] for x in exact["issues"]},{"aggregate_click_decline","aggregate_impression_decline"})
        collapse=report(100,0,1000,0); self.assertEqual(len(collapse["issues"]),2)

    def test_sample_classifier_exact_boundaries_and_malformed(self):
        excluded={"verdict":"NEUTRAL","coverage":"Excluded by noindex tag","robots":"ALLOWED","indexing":"BLOCKED_BY_HTTP_HEADER","page_fetch":"SUCCESSFUL"}
        indexed={**excluded,"verdict":"PASS","coverage":"Submitted and indexed","indexing":"INDEXING_ALLOWED"}
        unknown={**excluded,"coverage":"Unknown","indexing":"UNKNOWN"}
        self.assertEqual(sc.sample_evidence(excluded),"excluded_noindex")
        self.assertEqual(sc.sample_evidence(indexed),"indexed")
        self.assertEqual(sc.sample_evidence(unknown),"unknown")
        boundaries=[
            {**unknown,"indexing":"INDEXING_ALLOWED","robots":"ALLOWED","page_fetch":"SUCCESSFUL"},
            {**excluded,"coverage":"URL is not on Google"},
            {**excluded,"verdict":"PASS"},
            {**indexed,"indexing":"BLOCKED_BY_META_TAG"},
            {**indexed,"robots":"DISALLOWED"},
            {**indexed,"page_fetch":"SERVER_ERROR"},
            {**indexed,"page_fetch":"BLOCKED_ROBOTS_TXT"},
            {**indexed,"coverage":"Submitted and indexed-ish"},
        ]
        self.assertTrue(all(sc.sample_evidence(item)=="unknown" for item in boundaries))
        with self.assertRaises(sc.MonitorError): sc.validate_inspection({"inspectionResult":{"indexStatusResult":{"pageFetchState":3}}})

    def test_documented_inspection_enums_are_closed_exact_sets(self):
        self.assertEqual(sc.INDEXING_STATES,frozenset({
            "INDEXING_STATE_UNSPECIFIED", "INDEXING_ALLOWED", "BLOCKED_BY_META_TAG",
            "BLOCKED_BY_HTTP_HEADER", "BLOCKED_BY_ROBOTS_TXT",
        }))
        self.assertEqual(sc.PAGE_FETCH_STATES,frozenset({
            "PAGE_FETCH_STATE_UNSPECIFIED", "SUCCESSFUL", "SOFT_404", "BLOCKED_ROBOTS_TXT",
            "NOT_FOUND", "ACCESS_DENIED", "SERVER_ERROR", "REDIRECT_ERROR", "ACCESS_FORBIDDEN",
            "BLOCKED_4XX", "INTERNAL_CRAWL_ERROR", "INVALID_URL",
        }))
        enum_fields={
            "verdict":sc.VERDICT_STATES,
            "robotsTxtState":sc.ROBOTS_TXT_STATES,
            "indexingState":sc.INDEXING_STATES,
            "pageFetchState":sc.PAGE_FETCH_STATES,
        }
        for field,accepted in enum_fields.items():
            for value in accepted:
                clean=sc.validate_inspection({"inspectionResult":{"indexStatusResult":{field:value}}})
                self.assertEqual(clean["inspectionResult"]["indexStatusResult"][field],value)
            exemplar=next(iter(accepted))
            invalid_values={exemplar.lower(),exemplar+"_",exemplar.replace("_"," "),True,False}-set(accepted)
            for invalid in invalid_values:
                with self.subTest(field=field,value=invalid), self.assertRaises(sc.MonitorError):
                    sc.validate_inspection({"inspectionResult":{"indexStatusResult":{field:invalid}}})
        # Reserved-but-documented values remain accepted; foreign near-neighbors do not.
        reserved=sc.validate_inspection({"inspectionResult":{"indexStatusResult":{
            "indexingState":"BLOCKED_BY_ROBOTS_TXT"}}})
        self.assertEqual(reserved["inspectionResult"]["indexStatusResult"]["indexingState"],
                         "BLOCKED_BY_ROBOTS_TXT")
        for field,value in (("indexingState","BLOCKED_ROBOTS_TXT"),
                            ("pageFetchState","BLOCKED_BY_ROBOTS_TXT"),
                            ("pageFetchState","INDEXING_ALLOWED"),
                            ("pageFetchState","HTTP_ERROR")):
            with self.subTest(field=field,value=value), self.assertRaises(sc.MonitorError):
                sc.validate_inspection({"inspectionResult":{"indexStatusResult":{field:value}}})

    def test_enum_normalization_collisions_are_rejected_and_coverage_remains_free_text(self):
        for field,pairs in {
            "indexingState":(("BLOCKED_BY_META_TAG","BLOCKED BY META TAG"),),
            "pageFetchState":(("SOFT_404","SOFT 404"),("BLOCKED_ROBOTS_TXT","BLOCKED ROBOTS TXT")),
        }.items():
            for accepted,collision in pairs:
                sc.validate_inspection({"inspectionResult":{"indexStatusResult":{field:accepted}}})
                with self.assertRaises(sc.MonitorError):
                    sc.validate_inspection({"inspectionResult":{"indexStatusResult":{field:collision}}})
        clean=sc.validate_inspection({"inspectionResult":{"indexStatusResult":{"coverageState":"New descriptive coverage state"}}})
        self.assertEqual(clean["inspectionResult"]["indexStatusResult"]["coverageState"],"New descriptive coverage state")

    def test_final_analytics_completeness_zero_rows_and_omitted_dates(self):
        start,end=dt.date(2026,7,15),dt.date(2026,8,11)
        rows,complete=sc.validate_analytics({"responseAggregationType":"byProperty","rows":[]},start,end)
        self.assertEqual(sc.aggregate(rows,complete)["clicks"],0)
        self.assertEqual(complete,{"data_state":"final","reporting_lag_days":4,"requested_days":28,"returned_date_rows":0})
        recent_omitted={"responseAggregationType":"byProperty","rows":[{"keys":[start.isoformat()],"clicks":1,"impressions":2,"ctr":.5,"position":3}]}
        rows,complete=sc.validate_analytics(recent_omitted,start,end)
        self.assertEqual(complete["returned_date_rows"],1)
        self.assertEqual(sc.aggregate(rows,complete)["impressions"],2)

    def test_final_analytics_rejects_incomplete_duplicate_out_of_range_and_noncanonical_dates(self):
        start,end=dt.date(2026,7,15),dt.date(2026,8,11)
        row=lambda day: {"keys":[day],"clicks":1,"impressions":2,"ctr":.5,"position":3}
        invalid=[
            {"responseAggregationType":"byProperty","metadata":{"firstIncompleteDate":"2026-08-10"}},
            {"responseAggregationType":"byProperty","metadata":{"firstIncompleteHour":20}},
            {"responseAggregationType":"byProperty","rows":[row(start.isoformat()),row(start.isoformat())]},
            {"responseAggregationType":"byProperty","rows":[row("2026-07-14")]},
            {"responseAggregationType":"byProperty","rows":[row("2026-7-15")]},
        ]
        for response in invalid:
            with self.assertRaises(sc.MonitorError): sc.validate_analytics(response,start,end)

    def test_current_prior_requests_are_symmetric_and_complete(self):
        calls=[]
        def request(method,url,token,quota,body=None):
            if "searchAnalytics" in url:
                calls.append(body); return {"responseAggregationType":"byProperty","rows":[]}
            if url.endswith("/sitemaps"): return {"sitemap":[{"path":sc.SITEMAP}]}
            if body["inspectionUrl"].endswith("/status"):
                return {"inspectionResult":{"indexStatusResult":{"verdict":"NEUTRAL","coverageState":"Excluded by noindex tag","indexingState":"BLOCKED_BY_META_TAG"}}}
            return {"inspectionResult":{"indexStatusResult":{"verdict":"PASS","coverageState":"Indexed"}}}
        report=sc.run(dt.date(2026,8,15),"quota","token",request)
        self.assertEqual([(x["startDate"],x["endDate"]) for x in calls],
                         [("2026-07-15","2026-08-11"),("2026-06-17","2026-07-14")])
        self.assertTrue(all(x["dataState"]=="final" and x["dimensions"]==["date"] for x in calls))
        current=report["metrics"]["analytics"]["current"]["completeness"]
        prior=report["metrics"]["analytics"]["prior"]["completeness"]
        self.assertEqual(current,prior)

    def test_incomplete_final_response_stops_before_decline_policy(self):
        calls=0
        def request(method,url,token,quota,body=None):
            nonlocal calls
            if "searchAnalytics" in url:
                calls+=1
                return {"responseAggregationType":"byProperty","metadata":{"firstIncompleteDate":body["endDate"]},"rows":[]} if calls==1 else {"responseAggregationType":"byProperty","rows":[]}
            raise AssertionError("must stop after incomplete analytics")
        with self.assertRaises(sc.MonitorError) as caught:
            sc.run(dt.date(2026,8,15),"quota","token",request)
        self.assertEqual(caught.exception.code,"analytics_incomplete")
        self.assertEqual(calls,1)

    def test_route_roles_turn_ambiguous_and_contradictory_samples_into_bounded_issues(self):
        def report(url,status):
            def request(method,endpoint,token,quota,body=None):
                if "searchAnalytics" in endpoint: return {"responseAggregationType":"byProperty","rows":[]}
                if endpoint.endswith("/sitemaps"): return {"sitemap":[{"path":sc.SITEMAP}]}
                return {"inspectionResult":{"indexStatusResult":status}}
            return sc.run(dt.date(2026,8,15),"quota","token",request,[url])
        indexable_cases=[
            {"verdict":"NEUTRAL","coverageState":"URL is not on Google"},
            {"verdict":"NEUTRAL","coverageState":"Excluded by noindex tag","indexingState":"BLOCKED_BY_META_TAG"},
            {"verdict":"PASS","coverageState":"Submitted and indexed","indexingState":"BLOCKED_BY_META_TAG"},
            {"verdict":"NEUTRAL","coverageState":"Unknown","indexingState":"INDEXING_ALLOWED","robotsTxtState":"ALLOWED","pageFetchState":"SUCCESSFUL"},
        ]
        for state in indexable_cases:
            result=report(sc.REPRESENTATIVES[0],state)
            self.assertEqual([x["code"] for x in result["issues"]],["sample_indexability_evidence_unknown"])
            self.assertIn("no whole-site",result["issues"][0]["detail"])
        status_result=report(sc.REPRESENTATIVES[-1],{"verdict":"PASS","coverageState":"Excluded by noindex tag","indexingState":"BLOCKED_BY_META_TAG"})
        self.assertEqual(status_result["issues"],[]); self.assertEqual(status_result["status"],"ok")
        self.assertEqual(status_result["metrics"]["status_evidence_counts"]["ambiguous"],1)
        self.assertIn("Ambiguous or contradictory (informational): 1",sc.markdown(status_result))

    def test_status_mixed_affirmative_and_ambiguous_keeps_real_issue(self):
        calls=0
        def request(method,endpoint,token,quota,body=None):
            nonlocal calls
            if "searchAnalytics" in endpoint: return {"responseAggregationType":"byProperty","rows":[]}
            if endpoint.endswith("/sitemaps"): return {"sitemap":[{"path":sc.SITEMAP}]}
            calls+=1
            status=({"verdict":"PASS","coverageState":"Indexed","indexingState":"INDEXING_ALLOWED"} if calls == 1
                    else {"verdict":"NEUTRAL","coverageState":"Unknown"})
            return {"inspectionResult":{"indexStatusResult":status}}
        result=sc.run(dt.date(2026,8,15),"quota","token",request,[sc.REPRESENTATIVES[-1],sc.REPRESENTATIVES[0]])
        self.assertEqual([x["code"] for x in result["issues"]],["sample_indexability_evidence_unknown","sample_status_indexed"])
        self.assertEqual(result["metrics"]["status_evidence_counts"],{"indexed":1,"excluded_noindex":0,"ambiguous":0})

    def test_malformed_documented_nested_families_fail_closed(self):
        sitemap_bad=[{"contents":"bad"},{"contents":[{"type":1}]},{"contents":[{"type":"web","submitted":-1}]},
                     {"isSitemapsIndex":"false"},{"type":""}]
        for extra in sitemap_bad:
            with self.assertRaises(sc.MonitorError): sc.validate_sitemaps({"sitemap":[{"path":sc.SITEMAP,**extra}]})
        inspection_bad=[
            {"inspectionResultLink":"http://search.google.com/x"},
            {"indexStatusResult":{"lastCrawlTime":"yesterday"}},
            {"indexStatusResult":{"googleCanonical":"javascript:bad"}},
            {"indexStatusResult":{"referringUrls":"bad"}},
            {"mobileUsabilityResult":{"issues":[{"issueType":3}]}},
            {"richResultsResult":{"detectedItems":[{"richResultType":"x","items":[{"issues":[{"issueMessage":"x"}]}]}]}},
        ]
        for extra in inspection_bad:
            base={"indexStatusResult":{}}; base.update(extra)
            with self.assertRaises(sc.MonitorError): sc.validate_inspection({"inspectionResult":base})

    def test_transport_allowlist_rejects_before_connection_or_token_exposure(self):
        opened=[]
        def opener(request,timeout): opened.append(request); raise AssertionError("opened")
        valid_analytics=sc.analytics_body(dt.date(2026,7,18),dt.date(2026,8,14))
        sitemap_url="https://www.googleapis.com"+sc.SITEMAPS_PATH
        analytics_url="https://www.googleapis.com"+sc.ANALYTICS_PATH
        bad=[("GET",sitemap_url,"body"),
             ("DELETE",sitemap_url,None),
             ("GET","https://evil.invalid"+sc.SITEMAPS_PATH,None),
             ("GET","https://www.googleapis.com:443"+sc.SITEMAPS_PATH,None),
             ("GET","https://user@www.googleapis.com"+sc.SITEMAPS_PATH,None),
             ("GET",sitemap_url+"/near",None),
             ("GET",sitemap_url+"?x=1",None),
             ("GET",sitemap_url+"#x",None),
             ("POST",analytics_url,None),
             ("POST",sc.INSPECT_URL,{"inspectionUrl":"https://evil.invalid/","siteUrl":sc.PROPERTY})]
        for method,url,body in bad:
            with self.assertRaises(sc.MonitorError) as caught: sc.request_json(method,url,"secret-token","quota",body,opener)
            self.assertEqual(caught.exception.code,"transport_rejected")
        self.assertEqual(opened,[])

    def test_real_analytics_body_passes_production_transport_exactly_once(self):
        opened=[]
        expected=sc.analytics_body(dt.date(2026,7,15),dt.date(2026,8,11))
        analytics_url="https://www.googleapis.com"+sc.ANALYTICS_PATH
        class Response:
            def __enter__(self): return self
            def __exit__(self,*args): return False
            def read(self,size): return b'{"responseAggregationType":"byProperty","rows":[]}'
        def opener(request,timeout):
            opened.append((request,timeout))
            return Response()
        result=sc.request_json("POST",analytics_url,"test-token","quota-project",expected,opener)
        self.assertEqual(result,{"responseAggregationType":"byProperty","rows":[]})
        self.assertEqual(len(opened),1)
        request,timeout=opened[0]
        self.assertEqual(request.get_method(),"POST")
        self.assertEqual(request.full_url,analytics_url)
        self.assertEqual(timeout,sc.TIMEOUT)
        self.assertEqual(request.get_header("Authorization"),"Bearer test-token")
        self.assertEqual(request.get_header("X-goog-user-project"),"quota-project")
        self.assertEqual(request.get_header("Content-type"),"application/json")
        self.assertEqual(request.get_header("Accept"),"application/json")
        self.assertEqual(json.loads(request.data),expected)

    def test_analytics_aggregation_type_near_neighbors_are_rejected_before_open(self):
        expected=sc.analytics_body(dt.date(2026,7,15),dt.date(2026,8,11))
        analytics_url="https://www.googleapis.com"+sc.ANALYTICS_PATH
        opened=[]
        def opener(request,timeout): opened.append(request); raise AssertionError("opened")
        variants=[]
        missing=dict(expected); del missing["aggregationType"]; variants.append(missing)
        for value in ("byPage",True):
            wrong=dict(expected); wrong["aggregationType"]=value; variants.append(wrong)
        extra=dict(expected); extra["unexpectedAggregationType"]="byProperty"; variants.append(extra)
        for body in variants:
            with self.assertRaises(sc.MonitorError) as caught:
                sc.request_json("POST",analytics_url,"test-token","quota-project",body,opener)
            self.assertEqual(caught.exception.code,"transport_rejected")
        self.assertEqual(opened,[])

    def test_transport_does_not_follow_redirects(self):
        def redirect(request,timeout):
            raise urllib.error.HTTPError(request.full_url,302,"Found",{},None)
        with self.assertRaises(sc.MonitorError) as caught:
            sc.request_json("GET","https://www.googleapis.com"+sc.SITEMAPS_PATH,"secret","quota",None,redirect)
        self.assertEqual(caught.exception.code,"transport_rejected")

    def test_outer_boundary_sanitizes_unexpected_exception(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); out=root/"result.json"; report=root/"result.md"
            with mock.patch.object(sc,"get_token",return_value="secret"), mock.patch.object(sc,"run",side_effect=RuntimeError("credential secret traceback")):
                self.assertEqual(sc.main(["--quota-project","quota","--as-of","2026-08-15","--json-output",str(out),"--markdown-output",str(report)]),2)
            payload=out.read_text()
            self.assertIn("api_schema_invalid",payload); self.assertNotIn("credential",payload); self.assertNotIn("traceback",payload)

    def test_source_has_no_mutation_or_generic_override_surface(self):
        source=(ROOT/"scripts/search_console_monitor.py").read_text()
        forbidden=("sitemaps/submit","sitemaps/delete","indexing.googleapis.com","--method","--url","refresh_token","client_secret")
        self.assertTrue(all(term not in source for term in forbidden))


if __name__=="__main__": unittest.main()
