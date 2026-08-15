#!/usr/bin/env python3
"""Read-only, privacy-bounded Search Console monitor for worldhotlines.org."""
from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import math
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

try:
    from scripts.artifact_io import coordinated_write, guard_paths
    from scripts.monitor_delta import validate_result, threshold_crossed
except ModuleNotFoundError:
    from artifact_io import coordinated_write, guard_paths
    from monitor_delta import validate_result, threshold_crossed

PROPERTY = "sc-domain:worldhotlines.org"
SITEMAP = "https://worldhotlines.org/sitemap.xml"
REPRESENTATIVES = ("https://worldhotlines.org/", "https://worldhotlines.org/country/us",
                   "https://worldhotlines.org/category/emergency", "https://worldhotlines.org/status")
API_ROOT = "https://www.googleapis.com/webmasters/v3"
INSPECT_URL = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect"
MAX_RESPONSE_BYTES = 1_000_000
TIMEOUT = 15
MAX_ROWS = 1000
MAX_SITEMAPS = 1000
MAX_NESTED_ITEMS = 1000
ANALYTICS_PATH = "/webmasters/v3/sites/sc-domain%3Aworldhotlines.org/searchAnalytics/query"
SITEMAPS_PATH = "/webmasters/v3/sites/sc-domain%3Aworldhotlines.org/sitemaps"
INSPECTION_PATH = "/v1/urlInspection/index:inspect"
# Aggregate 28-day totals only. These deliberately ignore thin baselines and
# tolerate ordinary week-to-week noise before reporting a material decline.
MIN_PRIOR_CLICKS = 20.0
CLICK_DECLINE_THRESHOLD = 0.50
MIN_PRIOR_IMPRESSIONS = 200.0
IMPRESSION_DECLINE_THRESHOLD = 0.40
REPORTING_LAG_DAYS = 4
ANALYTICS_DAYS = 28

# URL Inspection v1 reference, checked 2026-08-15:
# https://developers.google.com/webmaster-tools/v1/urlInspection.index/UrlInspectionResult
# Documented enum values (including reserved values) are closed sets;
# coverageState is descriptive text, so it remains bounded free text.
VERDICT_STATES = frozenset({"VERDICT_UNSPECIFIED", "PASS", "PARTIAL", "FAIL", "NEUTRAL"})
ROBOTS_TXT_STATES = frozenset({"ROBOTS_TXT_STATE_UNSPECIFIED", "ALLOWED", "DISALLOWED"})
INDEXING_STATES = frozenset({
    "INDEXING_STATE_UNSPECIFIED", "INDEXING_ALLOWED", "BLOCKED_BY_META_TAG",
    "BLOCKED_BY_HTTP_HEADER", "BLOCKED_BY_ROBOTS_TXT",
})
PAGE_FETCH_STATES = frozenset({
    "PAGE_FETCH_STATE_UNSPECIFIED", "SUCCESSFUL", "SOFT_404", "BLOCKED_ROBOTS_TXT",
    "NOT_FOUND", "ACCESS_DENIED", "SERVER_ERROR", "REDIRECT_ERROR", "ACCESS_FORBIDDEN",
    "BLOCKED_4XX", "INTERNAL_CRAWL_ERROR", "INVALID_URL",
})
INDEXED_COVERAGE_STATES = frozenset({"INDEXED", "SUBMITTED AND INDEXED", "INDEXED, NOT SUBMITTED IN SITEMAP"})
NOINDEX_COVERAGE_STATES = frozenset({"EXCLUDED BY NOINDEX TAG", "EXCLUDED BY ‘NOINDEX’ TAG", "EXCLUDED BY 'NOINDEX' TAG"})
INDEXING_BLOCK_STATES = frozenset({"BLOCKED_BY_META_TAG", "BLOCKED_BY_HTTP_HEADER", "BLOCKED_BY_ROBOTS_TXT"})
ROBOTS_BLOCK_STATES = frozenset({"DISALLOWED"})
FETCH_FAILURE_STATES = frozenset({
    "SOFT_404", "BLOCKED_ROBOTS_TXT", "NOT_FOUND", "ACCESS_DENIED", "SERVER_ERROR",
    "REDIRECT_ERROR", "ACCESS_FORBIDDEN", "BLOCKED_4XX", "INTERNAL_CRAWL_ERROR", "INVALID_URL",
})


class MonitorError(Exception):
    def __init__(self, code, detail): self.code=code; self.detail=detail[:200]; super().__init__(self.detail)


def get_token(runner=subprocess.run):
    try:
        result=runner(["gcloud","auth","application-default","print-access-token"], capture_output=True, text=True, timeout=20, check=False)
    except FileNotFoundError as exc: raise MonitorError("gcloud_missing","gcloud command is unavailable") from exc
    except (subprocess.SubprocessError,OSError) as exc: raise MonitorError("adc_unavailable","ADC token command failed") from exc
    if result.returncode: raise MonitorError("adc_unavailable","ADC token command failed")
    token=result.stdout.strip()
    if not token: raise MonitorError("adc_empty","ADC token command returned no token")
    return token


def classify_api_error(status, reason):
    folded=reason.casefold()
    if status == 401: return "adc_unauthorized"
    if "quota project" in folded or "consumer" in folded and "invalid" in folded: return "quota_project_error"
    if "not been used" in folded or "disabled" in folded or "unregistered" in folded: return "api_disabled"
    if status == 403: return "property_permission_denied"
    return "api_error"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _open_no_redirect(request, timeout):
    return urllib.request.build_opener(_NoRedirect).open(request, timeout=timeout)


def _validate_request(method, url, body):
    try:
        parsed=urllib.parse.urlsplit(url); port=parsed.port
    except ValueError as exc: raise MonitorError("transport_rejected","request target rejected") from exc
    identity=(method,parsed.scheme,parsed.hostname,parsed.path)
    allowed={("POST","https","www.googleapis.com",ANALYTICS_PATH),
             ("GET","https","www.googleapis.com",SITEMAPS_PATH),
             ("POST","https","searchconsole.googleapis.com",INSPECTION_PATH)}
    if (identity not in allowed or port is not None or parsed.username is not None or parsed.password is not None
            or parsed.query or parsed.fragment):
        raise MonitorError("transport_rejected","request target rejected")
    if method == "GET":
        if body is not None: raise MonitorError("transport_rejected","GET body rejected")
    elif parsed.path == INSPECTION_PATH:
        if (not isinstance(body,dict) or set(body)!={"inspectionUrl","siteUrl"}
                or body.get("siteUrl") != PROPERTY or body.get("inspectionUrl") not in REPRESENTATIVES):
            raise MonitorError("transport_rejected","inspection body rejected")
    else:
        if not isinstance(body,dict) or set(body)!={"startDate","endDate","dimensions","rowLimit","startRow","dataState","aggregationType"}:
            raise MonitorError("transport_rejected","analytics body rejected")
        try: start=dt.date.fromisoformat(body["startDate"]); end=dt.date.fromisoformat(body["endDate"])
        except (TypeError,ValueError) as exc: raise MonitorError("transport_rejected","analytics dates rejected") from exc
        if (start>end or body["dataState"] != "final" or body["aggregationType"] != "byProperty"
                or body["dimensions"] != ["date"] or type(body["rowLimit"]) is not int or body["rowLimit"] != MAX_ROWS
                or type(body["startRow"]) is not int or body["startRow"] != 0):
            raise MonitorError("transport_rejected","analytics body rejected")


def request_json(method, url, token, quota_project, body=None, opener=_open_no_redirect):
    _validate_request(method,url,body)
    if (not isinstance(token,str) or not 0<len(token)<=16_384 or "\r" in token or "\n" in token
            or not isinstance(quota_project,str) or not re.fullmatch(r"[a-z][a-z0-9-]{4,62}[a-z0-9]",quota_project)):
        raise MonitorError("transport_rejected","credential header rejected")
    encoded=None if body is None else json.dumps(body,separators=(",", ":")).encode()
    request=urllib.request.Request(url,data=encoded,method=method,headers={"Authorization":"Bearer "+token,
        "X-Goog-User-Project":quota_project,"Content-Type":"application/json","Accept":"application/json"})
    try:
        with opener(request,timeout=TIMEOUT) as response:
            raw=response.read(MAX_RESPONSE_BYTES+1)
            if len(raw)>MAX_RESPONSE_BYTES: raise MonitorError("api_response_oversized","API response exceeded byte cap")
            return json.loads(raw)
    except urllib.error.HTTPError as exc:
        if 300 <= exc.code < 400: raise MonitorError("transport_rejected","redirect rejected") from exc
        raw=exc.read(32_000)
        try: reason=json.loads(raw).get("error",{}).get("message","")
        except (json.JSONDecodeError,AttributeError): reason=""
        raise MonitorError(classify_api_error(exc.code,str(reason)),f"HTTP {exc.code}") from exc
    except (urllib.error.URLError,TimeoutError,OSError,json.JSONDecodeError) as exc:
        raise MonitorError("api_unavailable",type(exc).__name__) from exc


def windows(as_of):
    last=as_of-dt.timedelta(days=REPORTING_LAG_DAYS); current_start=last-dt.timedelta(days=ANALYTICS_DAYS-1)
    prior_end=current_start-dt.timedelta(days=1); prior_start=prior_end-dt.timedelta(days=27)
    return prior_start,prior_end,current_start,last


def analytics_body(start,end):
    # dataState=final returns only finalized data. Date rows with zero activity
    # are omitted by the API and are therefore aggregated as zero below.
    return {"startDate":start.isoformat(),"endDate":end.isoformat(),"dimensions":["date"],
            "rowLimit":1000,"startRow":0,"dataState":"final","aggregationType":"byProperty"}


def aggregate(rows, completeness):
    clicks=sum(float(row.get("clicks",0)) for row in rows); impressions=sum(float(row.get("impressions",0)) for row in rows)
    weighted=sum(float(row.get("position",0))*float(row.get("impressions",0)) for row in rows)
    return {"clicks":clicks,"impressions":impressions,"ctr":clicks/impressions if impressions else None,
            "position":weighted/impressions if impressions else None,"completeness":completeness}


def _number(value, name, low=0.0, high=1e15):
    if type(value) not in {int,float} or not math.isfinite(value) or not low <= value <= high:
        raise MonitorError("api_schema_invalid",f"invalid {name}")
    return float(value)


def _text(value,name,maximum=2048,allow_empty=False):
    if not isinstance(value,str) or len(value)>maximum or (not allow_empty and not value.strip()):
        raise MonitorError("api_schema_invalid",f"invalid {name}")
    return value


def _timestamp(value,name):
    value=_text(value,name,40)
    try: parsed=dt.datetime.fromisoformat(value.replace("Z","+00:00"))
    except ValueError as exc: raise MonitorError("api_schema_invalid",f"invalid {name}") from exc
    if parsed.tzinfo is None: raise MonitorError("api_schema_invalid",f"invalid {name}")
    return value


def _url(value,name):
    value=_text(value,name,2048)
    try: parsed=urllib.parse.urlsplit(value)
    except ValueError as exc: raise MonitorError("api_schema_invalid",f"invalid {name}") from exc
    try: port=parsed.port
    except ValueError as exc: raise MonitorError("api_schema_invalid",f"invalid {name}") from exc
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment or port not in {None,443}:
        raise MonitorError("api_schema_invalid",f"invalid {name}")
    return value


def _string_list(value,name,urls=False):
    if not isinstance(value,list) or len(value)>MAX_NESTED_ITEMS: raise MonitorError("api_schema_invalid",f"invalid {name}")
    return [(_url(item,name) if urls else _text(item,name,200)) for item in value]


def validate_analytics(value, start, end):
    if not isinstance(value,dict) or not set(value) <= {"rows","responseAggregationType","metadata"}:
        raise MonitorError("api_schema_invalid","analytics response schema invalid")
    if value.get("responseAggregationType") != "byProperty":
        raise MonitorError("api_schema_invalid","analytics response aggregation type invalid")
    if "metadata" in value:
        metadata=value["metadata"]
        if not isinstance(metadata,dict) or not set(metadata)<={"firstIncompleteDate","firstIncompleteHour"}:
            raise MonitorError("api_schema_invalid","analytics metadata invalid")
        if "firstIncompleteDate" in metadata:
            try: incomplete=dt.date.fromisoformat(_text(metadata["firstIncompleteDate"],"first incomplete date",10))
            except ValueError as exc: raise MonitorError("api_schema_invalid","analytics metadata date invalid") from exc
            if metadata["firstIncompleteDate"] != incomplete.isoformat(): raise MonitorError("api_schema_invalid","analytics metadata date invalid")
        if "firstIncompleteHour" in metadata and (type(metadata["firstIncompleteHour"]) is not int or not 0<=metadata["firstIncompleteHour"]<=23):
            raise MonitorError("api_schema_invalid","analytics metadata hour invalid")
        # firstIncompleteDate/hour describe incomplete data and contradict an
        # explicitly requested final-only response, regardless of the boundary.
        if metadata:
            raise MonitorError("analytics_incomplete","final analytics response reported incomplete data")
    rows=value.get("rows",[])
    if not isinstance(rows,list) or len(rows)>MAX_ROWS: raise MonitorError("api_schema_invalid","analytics rows invalid")
    clean=[]; seen=set()
    for row in rows:
        if not isinstance(row,dict) or not set(row) <= {"keys","clicks","impressions","ctr","position"} or set(row) != {"keys","clicks","impressions","ctr","position"}:
            raise MonitorError("api_schema_invalid","analytics row schema invalid")
        keys=row["keys"]
        if not isinstance(keys,list) or len(keys)!=1 or not isinstance(keys[0],str): raise MonitorError("api_schema_invalid","analytics date key invalid")
        try: day=dt.date.fromisoformat(keys[0])
        except ValueError as exc: raise MonitorError("api_schema_invalid","analytics date invalid") from exc
        if keys[0] != day.isoformat(): raise MonitorError("api_schema_invalid","analytics date is not canonical")
        if day < start or day > end or day in seen: raise MonitorError("api_schema_invalid","analytics date outside window or duplicate")
        seen.add(day)
        clicks=_number(row["clicks"],"clicks"); impressions=_number(row["impressions"],"impressions")
        ctr=_number(row["ctr"],"ctr",0,1); position=_number(row["position"],"position",0,1e6)
        if clicks>impressions or (impressions and abs(ctr-clicks/impressions)>1e-6): raise MonitorError("api_schema_invalid","analytics values inconsistent")
        clean.append({"clicks":clicks,"impressions":impressions,"position":position})
    completeness={"data_state":"final","reporting_lag_days":REPORTING_LAG_DAYS,
                  "requested_days":(end-start).days+1,"returned_date_rows":len(clean)}
    return clean,completeness


def validate_sitemaps(value):
    if not isinstance(value,dict) or not set(value) <= {"sitemap"}: raise MonitorError("api_schema_invalid","sitemap response schema invalid")
    rows=value.get("sitemap",[])
    allowed={"path","lastSubmitted","isPending","isSitemapsIndex","type","lastDownloaded","warnings","errors","contents"}
    if not isinstance(rows,list) or len(rows)>MAX_SITEMAPS: raise MonitorError("api_schema_invalid","sitemap rows invalid")
    seen_paths=set()
    for row in rows:
        if not isinstance(row,dict) or not set(row)<=allowed or "path" not in row: raise MonitorError("api_schema_invalid","sitemap row schema invalid")
        path=_url(row["path"],"sitemap path")
        normalized=urllib.parse.urlunsplit(urllib.parse.urlsplit(path)._replace(scheme="https",netloc=urllib.parse.urlsplit(path).netloc.lower()))
        if normalized in seen_paths: raise MonitorError("api_schema_invalid","duplicate sitemap path")
        seen_paths.add(normalized)
        for key in ("warnings","errors"):
            if key in row and (not isinstance(row[key],str) or not row[key].isdigit() or int(row[key])>1_000_000): raise MonitorError("api_schema_invalid","sitemap count invalid")
        for key in ("isPending","isSitemapsIndex"):
            if key in row and type(row[key]) is not bool: raise MonitorError("api_schema_invalid",f"sitemap {key} invalid")
        if "type" in row: _text(row["type"],"sitemap type",100)
        for key in ("lastSubmitted","lastDownloaded"):
            if key in row:
                _timestamp(row[key],"sitemap date")
        if "contents" in row:
            contents=row["contents"]
            if not isinstance(contents,list) or len(contents)>MAX_NESTED_ITEMS: raise MonitorError("api_schema_invalid","sitemap contents invalid")
            for content in contents:
                if not isinstance(content,dict) or not set(content)<={"type","submitted","indexed"} or "type" not in content:
                    raise MonitorError("api_schema_invalid","sitemap content invalid")
                _text(content["type"],"sitemap content type",100)
                for key in ("submitted","indexed"):
                    if key in content and (not isinstance(content[key],str) or not content[key].isdigit() or int(content[key])>1_000_000_000):
                        raise MonitorError("api_schema_invalid","sitemap content count invalid")
    return [{key:row[key] for key in ("path","lastSubmitted","isPending","lastDownloaded","warnings","errors") if key in row} for row in rows]


def validate_inspection(value):
    if not isinstance(value,dict) or set(value)!={"inspectionResult"}: raise MonitorError("api_schema_invalid","inspection response schema invalid")
    result=value["inspectionResult"]
    allowed_result={"inspectionResultLink","indexStatusResult","mobileUsabilityResult","richResultsResult"}
    if not isinstance(result,dict) or not set(result)<=allowed_result or "indexStatusResult" not in result: raise MonitorError("api_schema_invalid","inspection result schema invalid")
    if "inspectionResultLink" in result: _url(result["inspectionResultLink"],"inspection result link")
    status=result["indexStatusResult"]
    allowed={"verdict","coverageState","robotsTxtState","indexingState","lastCrawlTime","pageFetchState",
             "googleCanonical","userCanonical","crawledAs","referringUrls","sitemap"}
    if not isinstance(status,dict) or not set(status)<=allowed: raise MonitorError("api_schema_invalid","inspection status schema invalid")
    enum_fields={"verdict":VERDICT_STATES,"robotsTxtState":ROBOTS_TXT_STATES,
                 "indexingState":INDEXING_STATES,"pageFetchState":PAGE_FETCH_STATES}
    for key,accepted in enum_fields.items():
        if key in status and (type(status[key]) is not str or status[key] not in accepted):
            raise MonitorError("api_schema_invalid",f"inspection {key} invalid")
    if "coverageState" in status and (type(status["coverageState"]) is not str or not 0<len(status["coverageState"])<=100):
        raise MonitorError("api_schema_invalid","inspection coverageState invalid")
    if "lastCrawlTime" in status: _timestamp(status["lastCrawlTime"],"last crawl time")
    if "crawledAs" in status: _text(status["crawledAs"],"crawledAs",100)
    for key in ("googleCanonical","userCanonical"):
        if key in status: _url(status[key],key)
    for key in ("referringUrls","sitemap"):
        if key in status: _string_list(status[key],key,urls=True)
    if "mobileUsabilityResult" in result:
        mobile=result["mobileUsabilityResult"]
        if not isinstance(mobile,dict) or not set(mobile)<={"verdict","issues"}: raise MonitorError("api_schema_invalid","mobile usability invalid")
        if "verdict" in mobile: _text(mobile["verdict"],"mobile verdict",100)
        issues=mobile.get("issues",[])
        if not isinstance(issues,list) or len(issues)>MAX_NESTED_ITEMS: raise MonitorError("api_schema_invalid","mobile issues invalid")
        for item in issues:
            if not isinstance(item,dict) or not set(item)<={"issueType","message"} or "issueType" not in item: raise MonitorError("api_schema_invalid","mobile issue invalid")
            _text(item["issueType"],"mobile issue type",100)
            if "message" in item: _text(item["message"],"mobile issue message",1000)
    if "richResultsResult" in result:
        rich=result["richResultsResult"]
        if not isinstance(rich,dict) or not set(rich)<={"verdict","detectedItems"}: raise MonitorError("api_schema_invalid","rich results invalid")
        if "verdict" in rich: _text(rich["verdict"],"rich verdict",100)
        detected=rich.get("detectedItems",[])
        if not isinstance(detected,list) or len(detected)>MAX_NESTED_ITEMS: raise MonitorError("api_schema_invalid","rich detected items invalid")
        for detected_item in detected:
            if not isinstance(detected_item,dict) or not set(detected_item)<={"richResultType","items"} or "richResultType" not in detected_item: raise MonitorError("api_schema_invalid","rich detected item invalid")
            _text(detected_item["richResultType"],"rich result type",100)
            items=detected_item.get("items",[])
            if not isinstance(items,list) or len(items)>MAX_NESTED_ITEMS: raise MonitorError("api_schema_invalid","rich items invalid")
            for item in items:
                if not isinstance(item,dict) or not set(item)<={"name","issues"}: raise MonitorError("api_schema_invalid","rich item invalid")
                if "name" in item: _text(item["name"],"rich item name",200)
                issues=item.get("issues",[])
                if not isinstance(issues,list) or len(issues)>MAX_NESTED_ITEMS: raise MonitorError("api_schema_invalid","rich issues invalid")
                for problem in issues:
                    if not isinstance(problem,dict) or not set(problem)<={"issueMessage","severity"} or set(problem)!={"issueMessage","severity"}: raise MonitorError("api_schema_invalid","rich issue invalid")
                    _text(problem["issueMessage"],"rich issue message",1000); _text(problem["severity"],"rich severity",100)
    clean={key:status[key] for key in ("verdict","coverageState","robotsTxtState","indexingState","pageFetchState") if key in status}
    return {"inspectionResult":{"indexStatusResult":clean}}


def change(current,prior): return None if prior == 0 else (current-prior)/prior


def sitemap_state(items):
    matches=[row for row in items if row.get("path")==SITEMAP]
    if not matches: return {"registration":"missing","processing":"unknown","warnings":0,"errors":0}
    if len(matches) != 1: raise MonitorError("api_schema_invalid","fixed sitemap match is ambiguous")
    row=matches[0]; warnings=int(row.get("warnings",0)); errors=int(row.get("errors",0))
    processing="error" if errors else ("warning" if warnings else ("pending" if row.get("isPending") else "processed"))
    return {"registration":"registered","processing":processing,"warnings":warnings,"errors":errors,
            "last_submitted":str(row.get("lastSubmitted", ""))[:30],"last_downloaded":str(row.get("lastDownloaded", ""))[:30]}


def inspection_state(value):
    result=value.get("inspectionResult",{}).get("indexStatusResult",{})
    verdict=str(result.get("verdict","UNKNOWN"))[:50]; coverage=str(result.get("coverageState","Unknown"))[:100]
    return {"verdict":verdict,"coverage":coverage,"robots":str(result.get("robotsTxtState","UNKNOWN"))[:50],
            "indexing":str(result.get("indexingState","UNKNOWN"))[:50],
            "page_fetch":str(result.get("pageFetchState","UNKNOWN"))[:50]}


def _normalized_coverage(value):
    return " ".join(value.strip().upper().split())


def sample_evidence(item):
    """Classify one sampled inspection from exact, documented state combinations."""
    verdict=item["verdict"]; coverage=_normalized_coverage(item["coverage"])
    indexing=item["indexing"]; robots=item["robots"]; fetched=item["page_fetch"]
    contradicted=indexing in INDEXING_BLOCK_STATES or robots in ROBOTS_BLOCK_STATES or fetched in FETCH_FAILURE_STATES
    if verdict == "PASS" and coverage in INDEXED_COVERAGE_STATES and not contradicted:
        return "indexed"
    if verdict == "NEUTRAL" and coverage in NOINDEX_COVERAGE_STATES and indexing in INDEXING_BLOCK_STATES:
        return "excluded_noindex"
    return "unknown"


def run(as_of, quota_project, token, requester=request_json, representatives=REPRESENTATIVES):
    prior_start,prior_end,current_start,current_end=windows(as_of)
    property_path=urllib.parse.quote(PROPERTY,safe="")
    analytics_url=f"{API_ROOT}/sites/{property_path}/searchAnalytics/query"
    current,current_completeness=validate_analytics(requester("POST",analytics_url,token,quota_project,analytics_body(current_start,current_end)),current_start,current_end)
    prior,prior_completeness=validate_analytics(requester("POST",analytics_url,token,quota_project,analytics_body(prior_start,prior_end)),prior_start,prior_end)
    current_total=aggregate(current,current_completeness); prior_total=aggregate(prior,prior_completeness)
    sitemap_url=f"{API_ROOT}/sites/{property_path}/sitemaps"
    sitemaps=validate_sitemaps(requester("GET",sitemap_url,token,quota_project)); sitemap=sitemap_state(sitemaps)
    fixed=[]
    for url in representatives:
        if url not in fixed and url in REPRESENTATIVES: fixed.append(url)
    inspections=[]
    for url in fixed[:5]:
        response=validate_inspection(requester("POST",INSPECT_URL,token,quota_project,{"inspectionUrl":url,"siteUrl":PROPERTY}))
        inspections.append({"url":url,**inspection_state(response)})
    issues=[]
    if threshold_crossed(current_total["clicks"],prior_total["clicks"],relative_drop=CLICK_DECLINE_THRESHOLD,minimum_baseline=MIN_PRIOR_CLICKS):
        issues.append({"code":"aggregate_click_decline","subject":"search-analytics","detail":"current aggregate clicks met the material decline threshold"})
    if threshold_crossed(current_total["impressions"],prior_total["impressions"],relative_drop=IMPRESSION_DECLINE_THRESHOLD,minimum_baseline=MIN_PRIOR_IMPRESSIONS):
        issues.append({"code":"aggregate_impression_decline","subject":"search-analytics","detail":"current aggregate impressions met the material decline threshold"})
    if sitemap["registration"]=="missing": issues.append({"code":"sitemap_missing","subject":"sitemap","detail":"fixed sitemap is not registered"})
    elif sitemap["processing"] in {"error","warning","pending"}: issues.append({"code":"sitemap_processing","subject":"sitemap","detail":sitemap["processing"]})
    status_evidence={"indexed":0,"excluded_noindex":0,"ambiguous":0}
    for item in inspections:
        expected_noindex=item["url"].endswith("/status")
        evidence=sample_evidence(item)
        if expected_noindex:
            item["intended_noindex_evidence"]=evidence
            status_evidence["ambiguous" if evidence == "unknown" else evidence] += 1
            if evidence == "indexed": issues.append({"code":"sample_status_indexed","subject":item["url"],"detail":"this sampled URL has affirmative indexed evidence; no whole-site indexation inference is made"})
        else:
            item["intended_indexability_evidence"]=evidence
            if evidence != "indexed": issues.append({"code":"sample_indexability_evidence_unknown","subject":item["url"],"detail":"this sampled URL lacks unambiguous indexed evidence; no whole-site indexation inference is made"})
    metrics={"analytics":{"current":current_total,"prior":prior_total,"changes":{"clicks":change(current_total["clicks"],prior_total["clicks"]),"impressions":change(current_total["impressions"],prior_total["impressions"])},
              "windows":{"prior":[prior_start.isoformat(),prior_end.isoformat()],"current":[current_start.isoformat(),current_end.isoformat()]}},
             "sitemap":sitemap,"sample_inspections":inspections,"status_evidence_counts":status_evidence,
             "sample_scope":"Fixed representative URLs only; never site-wide evidence."}
    return {"schema_version":"1.0","monitor":"search-console","as_of":as_of.isoformat(),"status":"regression" if issues else "ok","issues":sorted(issues,key=lambda x:(x["code"],x["subject"])),"metrics":metrics}


def markdown(report):
    lines=["# Search Console monitor","",f"- As of: `{report['as_of']}`",f"- Status: **{report['status']}**","","> Sitemap registration and processing do not establish indexing. URL Inspection results are sampled evidence only and are never generalized site-wide."]
    counts=report.get("metrics",{}).get("status_evidence_counts")
    if counts is not None:
        lines += ["", "## /status sampled evidence", "",
                  f"- Affirmative indexed: {counts['indexed']}",
                  f"- Affirmative noindex exclusion: {counts['excluded_noindex']}",
                  f"- Ambiguous or contradictory (informational): {counts['ambiguous']}"]
    if report["issues"]: lines += ["","## Issues",""]+[f"- `{html.escape(row['code'])}`: {html.escape(row['detail'])}" for row in report["issues"]]
    return "\n".join(lines)+"\n"


def external_path(value):
    path=Path(value)
    if not path.is_absolute(): raise argparse.ArgumentTypeError("output paths must be absolute and external to the repository")
    try: path.resolve().relative_to(Path(__file__).resolve().parent.parent)
    except ValueError: return path
    raise argparse.ArgumentTypeError("output paths must be external to the repository")


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument("--quota-project",required=True)
    parser.add_argument("--as-of",required=True); parser.add_argument("--json-output",type=external_path,required=True); parser.add_argument("--markdown-output",type=external_path,required=True)
    args=parser.parse_args(argv)
    try:
        as_of=dt.date.fromisoformat(args.as_of)
    except (TypeError,ValueError):
        parser.error("--as-of must be a canonical YYYY-MM-DD date")
    if args.as_of != as_of.isoformat():
        parser.error("--as-of must be a canonical YYYY-MM-DD date")
    try: guard_paths([],[(args.json_output,".json"),(args.markdown_output,".md")],external_root=Path(__file__).resolve().parent.parent)
    except (OSError,ValueError) as exc: parser.error(str(exc))
    try:
        token=get_token(); report=run(as_of,args.quota_project,token)
    except MonitorError as exc:
        report={"schema_version":"1.0","monitor":"search-console","as_of":as_of.isoformat(),"status":"unavailable","issues":[{"code":exc.code,"subject":"search-console","detail":exc.detail}],"metrics":{}}
    except Exception:
        report={"schema_version":"1.0","monitor":"search-console","as_of":as_of.isoformat(),"status":"unavailable","issues":[{"code":"api_schema_invalid","subject":"search-console","detail":"unexpected local monitoring failure"}],"metrics":{}}
    finally:
        if "token" in locals(): token=""
    report=validate_result(report)
    coordinated_write([(args.json_output,(json.dumps(report,sort_keys=True,indent=2)+"\n").encode()),
                       (args.markdown_output,markdown(report).encode())],
                      external_root=Path(__file__).resolve().parent.parent)
    print(json.dumps({"status":report["status"],"code":report["issues"][0]["code"] if report["issues"] else "ok"},sort_keys=True))
    return 2 if report["status"]=="unavailable" else (1 if report["status"]=="regression" else 0)


if __name__=="__main__": raise SystemExit(main())
