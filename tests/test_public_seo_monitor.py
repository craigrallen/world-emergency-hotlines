import importlib.util
import json
import socket
import struct
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest import mock

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location("public",ROOT/"scripts/public_seo_monitor.py")
seo=importlib.util.module_from_spec(spec); spec.loader.exec_module(seo)


def html(route,noindex=False,category=False,country=False):
    url=seo.ORIGIN+route
    title=f"Route {route} | World Hotlines"; description=f"Emergency information for route {route}."; alt="World Hotlines social preview"
    values=[]
    if route == "/": values=[{"@context":"https://schema.org","@type":"WebSite","url":url},
                              {"@context":"https://schema.org","@type":"Organization","url":url}]
    elif country or category:
        values=[{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[
            {"@type":"ListItem","position":1,"name":"Home","item":seo.ORIGIN+"/"},
            {"@type":"ListItem","position":2,"name":"Current","item":url}]}]
    scripts="".join(f'<script type="application/ld+json">{json.dumps(value)}</script>' for value in values)
    common=(f'<title>{title}</title><meta name="description" content="{description}">'
            f'<meta property="og:title" content="{title}"><meta property="og:description" content="{description}">'
            f'<meta property="og:type" content="website"><meta property="og:image" content="{seo.SOCIAL_IMAGE}">'
            f'<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">'
            f'<meta property="og:image:type" content="image/png"><meta property="og:image:alt" content="{alt}">'
            f'<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="{title}">'
            f'<meta name="twitter:description" content="{description}"><meta name="twitter:image" content="{seo.SOCIAL_IMAGE}">'
            f'<meta name="twitter:image:alt" content="{alt}">')
    metadata=common+('<meta name="robots" content="noindex,follow">' if noindex else f'<meta name="robots" content="index,follow"><link rel="canonical" href="{url}"><meta property="og:url" content="{url}">{scripts}')
    extra=""
    if country: extra='<div data-general-emergency-listing data-country-code="US"><a href="tel:911" data-phone-contact="911" data-general-emergency-contact="911">911</a></div><a href="#record">jump</a><article id="record" class="scroll-mt-24" data-hotline-card data-record-id="weh_1"><a href="tel:+123" data-phone-contact="+123">123</a></article>'
    if category: extra='<div class="country-summary">summary</div>'
    return f"<html><head>{metadata}</head><body><h1>Route heading</h1>{extra}</body></html>".encode()


def chunk(kind,data=b""):
    return struct.pack(">I",len(data))+kind+data+struct.pack(">I",zlib.crc32(kind+data)&0xffffffff)


def png(width=1200,height=630,color=6,production=False):
    ihdr=chunk(b"IHDR",struct.pack(">IIBBBBB",width,height,8,color,0,0,0))
    if production:
        pixel=b"\x20\x40\x80\xff" if color == 6 else b"\x20\x40\x80"
        image=zlib.compress(b"".join(b"\x00"+pixel*width for _ in range(height)),9)
    else: image=zlib.compress(b"\x00")
    return seo.PNG_SIGNATURE+ihdr+chunk(b"IDAT",image)+chunk(b"IEND")


def fixtures(overrides=None):
    urls=[seo.ORIGIN+p for p in ("/","/country/us","/category/emergency")]
    data={"home":html("/"),"robots":b"User-agent: *\nSitemap: https://worldhotlines.org/sitemap.xml\n",
          "sitemap":('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+"".join(f"<url><loc>{u}</loc></url>" for u in urls)+"</urlset>").encode(),
          "country":html("/country/us",country=True),"category":html("/category/emergency",category=True),
          "noindex":html("/status",noindex=True),"image":png()}
    data.update(overrides or {})
    def fetch(url,deadline=None):
        name=next(k for k,v in seo.ROUTES.items() if seo.ORIGIN+v==url); body=data[name]
        content_type="image/png" if name=="image" else ("application/xml" if name=="sitemap" else ("text/plain" if name=="robots" else "text/html"))
        return {"status":200,"final_url":url,"body":body,"truncated":False,"content_type":content_type,"redirect_count":0,"redirected":False}
    return fetch


class PublicSeoTests(unittest.TestCase):
    def test_valid_deterministic_fixture(self):
        first=seo.run("2026-08-15",fixtures()); second=seo.run("2026-08-15",fixtures())
        self.assertEqual(first,second); self.assertEqual(first["status"],"ok")

    def test_observed_scale_pages_remain_within_finite_collection_bounds(self):
        # Generated at the largest observed production scale (the US page).
        anchors=b'<a href="/country/us">route</a>'*1_057
        tokens=[f"c{i}".encode() for i in range(31_436)]
        classes=b"".join(b'<div class="'+b" ".join(tokens[i:i+75])+b'"></div>' for i in range(0,len(tokens),75))
        raw=html("/country/us",country=True)+anchors+classes
        self.assertLess(len(raw),seo.MAX_BYTES)
        report=seo.run("2026-08-15",fixtures({"country":raw}))
        self.assertNotIn("html_collection_overflow",{item["code"] for item in report["issues"]})

    def test_response_anchor_and_class_caps_accept_exactly_and_reject_one_over(self):
        class Response:
            fp=None
            def __init__(self,size): self.remaining=size
            def read(self,size=-1):
                amount=min(self.remaining,size); self.remaining-=amount; return b"x"*amount
        exact=seo._read_bounded(Response(seo.MAX_BYTES),10**20,seo.MAX_BYTES)
        over=seo._read_bounded(Response(seo.MAX_BYTES+1),10**20,seo.MAX_BYTES)
        self.assertEqual((len(exact[0]),exact[1]),(seo.MAX_BYTES,False))
        self.assertEqual((len(over[0]),over[1]),(seo.MAX_BYTES,True))
        image_exact=seo._read_bounded(Response(seo.MAX_IMAGE_BYTES),10**20,seo.MAX_IMAGE_BYTES)
        image_over=seo._read_bounded(Response(seo.MAX_IMAGE_BYTES+1),10**20,seo.MAX_IMAGE_BYTES)
        self.assertEqual((len(image_exact[0]),image_exact[1]),(seo.MAX_IMAGE_BYTES,False))
        self.assertEqual((len(image_over[0]),image_over[1]),(seo.MAX_IMAGE_BYTES,True))
        with self.assertRaises(ValueError): seo._read_bounded(Response(1),10**20,seo.MAX_BYTES+1)
        for maximum,fragment,collection,label in (
                (seo.MAX_PARSED_ANCHORS,b'<a href="/x">x</a>',"links","anchors"),
                (seo.MAX_PARSED_CLASSES,b'<i class="x"></i>',"classes","classes")):
            parser=seo.PageParser(); parser.feed((fragment*maximum).decode())
            self.assertEqual(len(getattr(parser,collection)),maximum); self.assertNotIn(label,parser.overflows)
            parser=seo.PageParser(); parser.feed((fragment*(maximum+1)).decode())
            self.assertEqual(len(getattr(parser,collection)),maximum); self.assertIn(label,parser.overflows)

    def test_sitemap_xml_media_types_and_route_coverage(self):
        base=fixtures()
        accepted=("text/xml","TEXT/XML; Charset=UTF-8","application/xml; charset=\"utf-8\"","Application/XML ; CHARSET=utf-8",
                  "application/xml;\tcharset=utf-8", "application/xml\t;\tcharset\t=\tutf-8",
                  "\tapplication/xml\t; charset =\tutf-8\t", 'application/xml; profile="a;b"',
                  'text/xml; profile="a\\\"b\\\\c"; version=one')
        for content_type in accepted:
            def fetch(url,deadline=None,content_type=content_type):
                value=base(url,deadline)
                if url.endswith("/sitemap.xml"): value["content_type"]=content_type
                return value
            report=seo.run("2026-08-15",fetch)
            self.assertEqual(report["status"],"ok"); self.assertEqual(report["metrics"]["sitemap_urls"],3)
            self.assertNotIn("sitemap_missing_route",{item["code"] for item in report["issues"]})
        for content_type in ("","text/html","application/json","application/sitemap+xml","not a/type",
                             "text/xml; charset","text/xml;",'text/xml; charset="unterminated',
                             'text/xml; charset=utf-8; charset=utf-8',
                             'text/xml; charset=utf-8; CHARSET=us-ascii',
                             'text/xml; profile="bad\\q"', 'text/xml; profile="bad\\"',
                             'text/xml; profile="ok"garbage', 'text/xml;;charset=utf-8',
                             'text/xml; profile="line\nbreak"', 'text/xml; profile="tab\tvalue"',
                             'text/xml; profile="vertical\vtab"', 'text/xml; profile="form\ffeed"',
                             'text/xml; profile="carriage\rreturn"', 'text/xml; profile="control\x00value"',
                             'text/xml; profile="delete\x7fvalue"', 'text/xml; profile="control\x85value"'):
            def fetch(url,deadline=None,content_type=content_type):
                value=base(url,deadline)
                if url.endswith("/sitemap.xml"): value["content_type"]=content_type
                return value
            codes={item["code"] for item in seo.run("2026-08-15",fetch)["issues"]}
            self.assertIn("sitemap_content_type",codes); self.assertNotIn("sitemap_missing_route",codes)
        prefix='application/xml; profile="'
        exact=prefix+"a"*(seo.MAX_CONTENT_TYPE_CHARS-len(prefix)-1)+'"'
        self.assertEqual(len(exact),seo.MAX_CONTENT_TYPE_CHARS)
        self.assertTrue(seo._sitemap_mime(exact)); self.assertFalse(seo._sitemap_mime(exact[:-1]+'a"'))

    def test_fetch_rejects_oversized_malformed_and_duplicate_content_type(self):
        class Response:
            status=200; fp=None
            def __init__(self,headers): self.headers=headers
            def getheaders(self): return self.headers
            def getheader(self,name,default=None):
                values=[v for k,v in self.headers if k.casefold()==name.casefold()]
                return values[0] if values else default
            def read(self,size=-1): return b"ok"
        class Connection:
            def __init__(self,response,*args): self.response=response
            def request(self,*args,**kwargs): pass
            def getresponse(self): return self.response
            def close(self): pass
        def fetch(headers):
            response=Response(headers)
            return seo.fetch_resource(seo.ORIGIN+"/sitemap.xml",resolver=lambda *a,**k:[(None,None,None,None,("8.8.8.8",443))],
                connection_factory=lambda *args:Connection(response))
        exact="application/xml"+" "*(seo.MAX_CONTENT_TYPE_CHARS-len("application/xml"))
        self.assertEqual(fetch([("Content-Type",exact)])["content_type"],exact.strip())
        for headers in ([('Content-Type',exact+'x')], [('Content-Type','application/xml'),('content-type','text/html')],
                        [('Content-Type',None)], []):
            self.assertFalse(seo._sitemap_mime(fetch(headers)["content_type"]))

    def test_fetch_applies_image_transport_cap_before_page_allowance(self):
        class Response:
            status=200; fp=None
            def __init__(self,size): self.remaining=size; self.consumed=0
            def getheaders(self): return [("Content-Type","image/png")]
            def getheader(self,name,default=None): return "image/png" if name=="Content-Type" else default
            def read(self,size=-1):
                amount=min(self.remaining,size); self.remaining-=amount; self.consumed+=amount; return b"x"*amount
        response=Response(seo.MAX_BYTES)
        class Connection:
            def __init__(self,*args): pass
            def request(self,*args,**kwargs): pass
            def getresponse(self): return response
            def close(self): pass
        result=seo.fetch_resource(seo.ORIGIN+seo.ROUTES["image"],resolver=lambda *a,**k:[(None,None,None,None,("8.8.8.8",443))],connection_factory=Connection)
        self.assertTrue(result["truncated"]); self.assertEqual(len(result["body"]),seo.MAX_IMAGE_BYTES)
        self.assertEqual(response.consumed,seo.MAX_IMAGE_BYTES+1)
        self.assertGreater(response.remaining,0)

    def test_duplicate_security_sensitive_attributes_are_rejected_before_collapse(self):
        valid=html("/country/us",country=True)
        cases=[
            (b'data-country-code="US"',b'data-country-code="US" DATA-COUNTRY-CODE="US"'),
            (b'data-country-code="US"',b'data-country-code="US" data-country-code="CA"'),
            (b'data-phone-contact="911"',b'data-phone-contact="911" DATA-PHONE-CONTACT="&#57;&#49;&#49;"'),
            (b'data-phone-contact="911"',b'data-phone-contact="911" data-message-contact="911" DATA-MESSAGE-CONTACT="112"'),
            (b'data-general-emergency-listing',b'data-general-emergency-listing DATA-GENERAL-EMERGENCY-LISTING'),
            (b'data-record-id="weh_1"',b'data-record-id="weh_1" data-record-id="other"'),
            (b'data-record-id="weh_1"',b'data-prioritized-record-id="one" DATA-PRIORITIZED-RECORD-ID="two" data-record-id="weh_1"'),
            (b'href="tel:911"',b'href="tel:911" HREF="tel:112"'),
        ]
        for old,new in cases:
            codes={x["code"] for x in seo.run("2026-08-15",fixtures({"country":valid.replace(old,new,1)}))["issues"]}
            self.assertIn("html_collection_overflow",codes)

    def test_invalid_sitemap_reports_root_cause_without_missing_route_cascade(self):
        report=seo.run("2026-08-15",fixtures({"sitemap":b"<bad>"}))
        codes={item["code"] for item in report["issues"]}
        self.assertIn("sitemap_xml",codes); self.assertNotIn("sitemap_missing_route",codes)

    def test_x_robots_normalization_applicability_conflicts_and_bounds(self):
        sitemap={seo.ORIGIN+p for p in ("/","/country/us","/category/emergency")}
        def codes(name,route,values,error=None):
            return {x["code"] for x in seo.inspect_html(name,route,html(route,noindex=name=="noindex",country=name=="country",category=name=="category"),sitemap,values,error)}
        self.assertNotIn("x_robots_tag_directive",codes("home","/",["bingbot: noindex", "googlebot: index, follow"]))
        for values in (["noindex"],["none"],["index","noindex"],["googlebot: noindex"],["googlebot: index, nofollow"]):
            found=codes("home","/",values)
            self.assertTrue({"x_robots_tag_directive","robots_conflict"}&found)
        self.assertNotIn("robots_directive",codes("noindex","/status",["googlebot: noindex, follow"]))
        self.assertIn("robots_conflict",codes("noindex","/status",["index", "noindex, follow"]))
        self.assertIn("x_robots_tag_malformed",codes("home","/",["googlebot:"]))
        self.assertIn("x_robots_tag_oversized",codes("home","/",[],"x_robots_tag_oversized"))

    def test_robots_groups_longest_match_and_strict_sitemap(self):
        valid=b"User-agent: *\nDisallow: /country/\nAllow: /country/us$\nSitemap: https://worldhotlines.org/sitemap.xml\n"
        self.assertNotIn("robots_blocked",{x["code"] for x in seo.inspect_robots(valid)})
        cases=[
            (b"User-agent: *\nDisallow: /\nSitemap: https://worldhotlines.org/sitemap.xml\n","robots_blocked"),
            (b"User-agent: *\nDisallow: /category/emergency\nSitemap: https://worldhotlines.org/sitemap.xml\n","robots_blocked"),
            (b"User-agent: *\nDisallow:\nUser-agent: Googlebot\nDisallow: /sitemap.xml\nSitemap: https://worldhotlines.org/sitemap.xml\n","robots_blocked"),
            (b"Disallow: /\nSitemap: https://worldhotlines.org/sitemap.xml\n","robots_malformed"),
            (b"User-agent: *\nSitemap: https://worldhotlines.org/sitemap.xml\nSitemap: https://worldhotlines.org/sitemap.xml\n","robots_sitemap"),
            (b"User-agent: *\nSitemap: https://evil.invalid/sitemap.xml\n","robots_sitemap"),
            (b"User-agent: *\nSitemap: https://worldhotlines.org/sitemap.xml?x=1\n","robots_sitemap"),
            (b"User-agent: *\nSitemap: https://worldhotlines.org/sitemap.xml#x\n","robots_sitemap"),
        ]
        for raw,code in cases: self.assertIn(code,{x["code"] for x in seo.inspect_robots(raw)})

    def test_robots_independently_rejects_blocked_fixed_social_image(self):
        raw=b"User-agent: *\nDisallow: /social-card.png\nSitemap: https://worldhotlines.org/sitemap.xml\n"
        issues=seo.inspect_robots(raw)
        self.assertEqual({item["subject"] for item in issues if item["code"] == "robots_blocked"},{seo.ROUTES["image"]})

    def test_transport_retains_only_bounded_x_robots_headers(self):
        class Response:
            status=200; fp=None
            def getheader(self,name,default=None): return "text/html" if name=="Content-Type" else default
            def getheaders(self): return [("Server","secret"),("X-Robots-Tag","index"),("x-robots-tag","googlebot: follow")]
            def read(self,size=-1): return b"ok"
        class Connection:
            def __init__(self,*args): pass
            def request(self,*args,**kwargs): pass
            def getresponse(self): return Response()
            def close(self): pass
        result=seo.fetch_resource(seo.ORIGIN+"/",resolver=lambda *a,**k:[(None,None,None,None,("8.8.8.8",443))],connection_factory=Connection)
        self.assertEqual(result["x_robots_tag"],["index","googlebot: follow"]); self.assertNotIn("headers",result); self.assertNotIn("server",str(result).casefold())

    def test_sitemap_malformed_duplicate_foreign_query_and_count(self):
        for raw,code in ((b"<bad>","sitemap_xml"),
            (b'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://worldhotlines.org/</loc></url><url><loc>https://worldhotlines.org/</loc></url></urlset>',"sitemap_duplicate"),
            (b'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://evil.invalid/</loc></url></urlset>',"sitemap_url"),
            (b'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://worldhotlines.org/?x=1</loc></url></urlset>',"sitemap_url")):
            report=seo.run("2026-08-15",fixtures({"sitemap":raw}))
            self.assertIn(code,{x["code"] for x in report["issues"]})
        raw=('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+"".join(f"<url><loc>{seo.ORIGIN}/x{i}</loc></url>" for i in range(seo.MAX_SITEMAP_URLS+1))+"</urlset>").encode()
        self.assertIn("sitemap_count",{x["code"] for x in seo.run("2026-08-15",fixtures({"sitemap":raw}))["issues"]})

    def test_sitemap_requires_exact_schema_namespace_and_content_type(self):
        cases=[
            (b'<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://worldhotlines.org/sitemap.xml</loc></sitemap></sitemapindex>',"sitemap_schema"),
            (b'<html><loc>https://worldhotlines.org/</loc></html>',"sitemap_schema"),
            (b'<root xmlns="urn:other"><loc>https://worldhotlines.org/</loc></root>',"sitemap_schema"),
            (b'<urlset><url><loc>https://worldhotlines.org/</loc></url></urlset>',"sitemap_schema"),
            (b'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc> </loc></url></urlset>',"sitemap_schema"),
            (b'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://worldhotlines.org/</loc><changefreq>daily</changefreq></url></urlset>',"sitemap_schema"),
        ]
        for raw,code in cases:
            self.assertIn(code,{x["code"] for x in seo.run("2026-08-15",fixtures({"sitemap":raw}))["issues"]})
        base=fixtures()
        def wrong_type(url,deadline=None):
            value=base(url,deadline)
            if url.endswith("sitemap.xml"): value["content_type"]="text/html"
            return value
        self.assertIn("sitemap_content_type",{x["code"] for x in seo.run("2026-08-15",wrong_type)["issues"]})

    def test_contact_links_require_exact_hierarchical_attribution(self):
        prefix=html("/country/us",country=True)
        valid_card=b'<article data-hotline-card data-record-id="weh_2"><a href="sms:123" data-message-contact="123">text</a></article>'
        self.assertNotIn("contact_attribution",{x["code"] for x in seo.run("2026-08-15",fixtures({"country":prefix+valid_card}))["issues"]})
        negatives=[
            b'<a href="tel:123" data-phone-contact="123">x</a>',
            b'<article data-hotline-card data-record-id=""><a href="tel:123" data-phone-contact="123">x</a></article>',
            b'<article data-hotline-card data-record-id="a"><div data-prioritized-listing data-prioritized-record-id="b"><a href="tel:123" data-phone-contact="123">x</a></div></article>',
            b'<article data-hotline-card data-record-id="a"><a href="tel:123" data-phone-contact="999">x</a></article>',
            b'<article data-hotline-card data-record-id="a"><a href="tel:123" data-phone-contact="123">x</a><a href="tel:123" data-phone-contact="123">x</a></article>',
        ]
        for fragment in negatives:
            report=seo.run("2026-08-15",fixtures({"country":prefix+fragment}))
            self.assertIn("contact_attribution",{x["code"] for x in report["issues"]})

    def test_country_general_emergency_attribution_contract(self):
        valid=html("/country/us",country=True)
        self.assertNotIn("contact_attribution",{x["code"] for x in seo.run("2026-08-15",fixtures({"country":valid}))["issues"]})
        replacements=[
            (b'data-general-emergency-listing data-country-code="US"',b''),
            (b'data-country-code="US"',b'data-country-code=""'),
            (b'data-country-code="US"',b'data-country-code="USA"'),
            (b'data-country-code="US"',b'data-country-code="CA"'),
            (b'data-phone-contact="911"',b''),
            (b'data-phone-contact="911"',b'data-phone-contact="112"'),
            (b'data-general-emergency-contact="911"',b''),
            (b'data-general-emergency-contact="911"',b'data-general-emergency-contact=""'),
            (b'data-general-emergency-contact="911"',b'data-general-emergency-contact="112"'),
            (b'data-general-emergency-contact="911"',b'data-general-emergency-contact="&#57;11"'),
            (b'data-general-emergency-contact="911"',b'data-general-emergency-contact="911" data-general-emergency-contact="911"'),
            (b'>911</a></div>',b'>112</a></div>'),
            (b'<div data-general-emergency-listing',b'<article data-hotline-card data-record-id="nested"><div data-general-emergency-listing'),
            (b'<div data-general-emergency-listing',b'<div data-prioritized-listing data-prioritized-record-id="nested"><div data-general-emergency-listing'),
            (b'data-general-emergency-listing data-country-code="US"',b'data-general-emergency-listing data-hotline-card data-record-id="nested" data-country-code="US"'),
        ]
        for old,new in replacements:
            raw=valid.replace(old,new,1)
            if b'<article data-hotline-card data-record-id="nested">' in raw: raw += b'</article>'
            if b'<div data-prioritized-listing data-prioritized-record-id="nested">' in raw: raw += b'</div>'
            self.assertIn("contact_attribution",{x["code"] for x in seo.run("2026-08-15",fixtures({"country":raw}))["issues"]})
        multiple=valid.replace(b'</body>',b'<div data-general-emergency-listing data-country-code="US"></div></body>')
        self.assertIn("contact_attribution",{x["code"] for x in seo.run("2026-08-15",fixtures({"country":multiple}))["issues"]})
        duplicate=valid.replace(b'</a></div>',b'</a><a href="tel:911" data-phone-contact="911">911</a></div>',1)
        self.assertIn("contact_attribution",{x["code"] for x in seo.run("2026-08-15",fixtures({"country":duplicate}))["issues"]})
        for misplaced in (
            b'<article data-hotline-card data-record-id="x"><a href="tel:112" data-phone-contact="112" data-general-emergency-contact="112">112</a></article>',
            b'<div data-prioritized-listing data-prioritized-record-id="x"><a href="tel:112" data-phone-contact="112" data-general-emergency-contact="112">112</a></div>',
            b'<a href="tel:112" data-phone-contact="112" data-general-emergency-contact="112">112</a>',
        ):
            self.assertIn("contact_attribution",{x["code"] for x in seo.run("2026-08-15",fixtures({"country":valid+misplaced}))["issues"]})
        non_country=html("/")+b'<div data-general-emergency-listing data-country-code="US"><a href="tel:911" data-phone-contact="911">911</a></div>'
        self.assertIn("contact_attribution",{x["code"] for x in seo.run("2026-08-15",fixtures({"home":non_country}))["issues"]})

    def test_raw_contact_attributes_reject_character_references_before_decoding(self):
        base=html("/country/us",country=True)
        href_cases=(
            '<article data-hotline-card data-record-id="x"><a href="tel&#58;123" data-phone-contact="123">x</a></article>',
            "<article data-hotline-card data-record-id=x><a HREF='tel&#x3A;123' DATA-PHONE-CONTACT=123>x</a></article>",
            '<article data-hotline-card data-record-id=x><a href=tel&colon;123 data-phone-contact=123>x</a></article>',
            '<article data-hotline-card data-record-id=x><a href="tel:&#43;123" data-phone-contact="+123">x</a></article>',
            '<article data-hotline-card data-record-id=x><a href=tel:12&#51 data-phone-contact=123>x</a></article>',
            '<article data-hotline-card data-record-id=x><a href="sms:12&#51;" data-message-contact="123">x</a></article>',
        )
        for fragment in href_cases:
            with self.subTest(fragment=fragment):
                codes={x["code"] for x in seo.inspect_html("country","/country/us",base+fragment.encode(),{seo.ORIGIN+"/country/us"})}
                self.assertIn("unsafe_contact_uri",codes)
        marker_cases=(
            '<article data-hotline-card data-record-id=x><a href="tel:123" data-phone-contact="12&#51;">x</a></article>',
            '<article data-hotline-card data-record-id=x><a href=tel:+123 data-phone-contact=&#43;123>x</a></article>',
            '<article data-hotline-card data-record-id=x><a href=sms:123 DATA-MESSAGE-CONTACT=12&#51>x</a></article>',
        )
        for fragment in marker_cases:
            codes={x["code"] for x in seo.inspect_html("country","/country/us",base+fragment.encode(),{seo.ORIGIN+"/country/us"})}
            self.assertIn("contact_attribution",codes)
        encoded_general=base.replace(b'data-general-emergency-contact="911"',b'data-general-emergency-contact="9&#49;1"')
        self.assertIn("contact_attribution",{x["code"] for x in seo.inspect_html("country","/country/us",encoded_general,{seo.ORIGIN+"/country/us"})})
        decoy=base+b'<article data-hotline-card data-record-id=x><a title="> &#58;" href="tel:123" data-phone-contact="123">x</a></article>'
        codes={x["code"] for x in seo.inspect_html("country","/country/us",decoy,{seo.ORIGIN+"/country/us"})}
        self.assertNotIn("unsafe_contact_uri",codes)
        ordinary=html("/")+b'<a href="https://example.test/?a=1&amp;b=2">ordinary</a>'
        self.assertNotIn("unsafe_contact_uri",{x["code"] for x in seo.inspect_html("home","/",ordinary,{seo.ORIGIN+"/"})})

    def test_void_elements_and_malformed_closes_cannot_forge_attribution(self):
        valid=html("/country/us",country=True)
        open_panel=b'<div data-general-emergency-listing data-country-code="US">'
        fragments=(
            valid.replace(open_panel,b'<img data-general-emergency-listing data-country-code="US">').replace(b'</a></div>',b'</a></img>',1),
            valid.replace(open_panel,b'<input data-general-emergency-listing data-country-code="US">').replace(b'</a></div>',b'</a>',1),
            valid.replace(open_panel,b'<meta data-general-emergency-listing data-country-code="US">').replace(b'</a></div>',b'</a>',1),
            valid.replace(open_panel,b'<br data-general-emergency-listing data-country-code="US">').replace(b'</a></div>',b'</a>',1),
            valid+b'<img data-phone-contact="911"><input data-message-contact="911"><meta data-prioritized-listing data-prioritized-record-id="fake"><br data-general-emergency-contact="911">',
            valid+b'<div data-hotline-card data-record-id="fake"/><a href="tel:123" data-phone-contact="123">x</a>',
        )
        for raw in fragments:
            self.assertIn("contact_attribution",{x["code"] for x in seo.inspect_html("country","/country/us",raw,{seo.ORIGIN+"/country/us"})})
        nested=valid.replace(b'>911</a></div>',b'><img data-hotline-card data-record-id="fake">911</a></div>',1)
        self.assertIn("contact_attribution",{x["code"] for x in seo.inspect_html("country","/country/us",nested,{seo.ORIGIN+"/country/us"})})
        stray=valid+b'</img></input></meta></br></unknown><article data-hotline-card data-record-id="ok"><a href="tel:123" data-phone-contact="123">x</a></article>'
        codes={x["code"] for x in seo.inspect_html("country","/country/us",stray,{seo.ORIGIN+"/country/us"})}
        self.assertNotIn("contact_attribution",codes)
        self.assertNotIn("html_collection_overflow",codes)
        self.assertNotIn("contact_attribution",{x["code"] for x in seo.inspect_html("country","/country/us",valid,{seo.ORIGIN+"/country/us"})})

    def test_attribution_critical_malformed_html_has_one_root_issue(self):
        fragments=(
            '<article data-hotline-card data-record-id="x"><a href="tel:123" data-phone-contact="123">x</a>',
            '<div data-prioritized-listing data-prioritized-record-id="x"><a href="sms:123" data-message-contact="123">x</a>',
            '<div data-general-emergency-listing data-country-code="US"><a href="tel:911" data-phone-contact="911" data-general-emergency-contact="911">911</a>',
            '<article data-hotline-card data-record-id="x"><a href="tel:123" data-phone-contact="123">x</article>',
            '<article data-hotline-card data-record-id="x"><span data-phone-contact="123">x',
            '<article data-hotline-card data-record-id="x"><div></article></div>',
            '<div><article data-hotline-card data-record-id="x"></div></article>',
            '<article data-hotline-card data-record-id="x"><div data-prioritized-listing data-prioritized-record-id="y"></article></div>',
            '<div data-prioritized-listing data-prioritized-record-id="x"><article data-hotline-card data-record-id="y"></div></article>',
            '<article data-hotline-card data-record-id="x"></section></article>',
        )
        for fragment in fragments:
            with self.subTest(fragment=fragment):
                raw=html("/")+fragment.encode()
                found=[x for x in seo.inspect_html("home","/",raw,{seo.ORIGIN+"/"})
                       if x["code"] == "contact_attribution"]
                self.assertEqual(found,[seo.issue("contact_attribution","/","malformed HTML makes contact attribution structure untrustworthy")])
        ordinary=html("/")+b'<ul><li>one<li>two</ul><p>one<div>two</div><article data-hotline-card data-record-id="x"><p>optional</article>'
        self.assertNotIn("contact_attribution",{x["code"] for x in seo.inspect_html("home","/",ordinary,{seo.ORIGIN+"/"})})

    def test_depth_overflow_preserves_tracked_ancestry_without_cascade(self):
        card='<article data-hotline-card data-record-id="x">'
        contact='<a href="tel:123" data-phone-contact="123">x</a>'
        exact=seo.PageParser(); exact.feed(card+'<div>'*(seo.MAX_HTML_DEPTH-2)+contact+'</div>'*(seo.MAX_HTML_DEPTH-2)+'</article>'); exact.close()
        self.assertNotIn("depth",exact.overflows)
        cases=(
            card+'<div>'*(seo.MAX_HTML_DEPTH-1)+'<article></article>'+contact+'</div>'*(seo.MAX_HTML_DEPTH-1)+'</article>',
            card+'<div>'*(seo.MAX_HTML_DEPTH-1)+'<section><article></article></section>'+contact+'</div>'*(seo.MAX_HTML_DEPTH-1)+'</article>',
            card+'<div>'*(seo.MAX_HTML_DEPTH-1)+'<br><i />'+contact+'</div>'*(seo.MAX_HTML_DEPTH-1)+'</article>'+'<article data-hotline-card data-record-id="y">'+contact+'</article>',
        )
        for fragment in cases:
            with self.subTest(fragment=fragment[-120:]):
                issues=seo.inspect_html("home","/",html("/")+fragment.encode(),{seo.ORIGIN+"/"})
                self.assertIn("html_collection_overflow",{x["code"] for x in issues})
                self.assertNotIn("contact_attribution",{x["code"] for x in issues})

    def test_parser_close_is_idempotent_and_preserves_closed_jsonld(self):
        parser=seo.PageParser(); parser.feed('<script type="application/ld+json">{"@type":"WebSite"}</script>')
        parser.close(); first=(list(parser.jsonld),set(parser.overflows)); parser.close()
        self.assertEqual((parser.jsonld,parser.overflows),first)

    def test_contact_uri_and_marker_digit_boundaries(self):
        base=html("/country/us",country=True)
        cases=(("tel",1,False),("tel",2,True),("tel",15,True),("tel",16,False),
               ("sms",2,False),("sms",3,True),("sms",15,True),("sms",16,False))
        for scheme,count,accepted in cases:
            marker="data-phone-contact" if scheme == "tel" else "data-message-contact"
            container='data-hotline-card data-record-id="bounds"'
            for plus in ("","+"):
                value=plus+("1"*count)
                variants=(
                    f'<article {container}><a href="{scheme}:{value}" {marker}="{value}">x</a></article>',
                    f'<article {container}><a href="{scheme}:{value}" {marker}="1{value[1:] if plus else value[1:]}">x</a></article>',
                )
                uri_codes={x["code"] for x in seo.inspect_html("country","/country/us",base+variants[0].encode(),{seo.ORIGIN+"/country/us"})}
                self.assertEqual("unsafe_contact_uri" not in uri_codes,accepted,(scheme,count,plus,"uri"))
                self.assertEqual("contact_attribution" not in uri_codes,accepted,(scheme,count,plus,"marker"))
                marker_value=("9" if not plus else "+9")+("1"*(count-1))
                marker_html=f'<article {container}><a href="{scheme}:{value}" {marker}="{marker_value}">x</a></article>'
                marker_codes={x["code"] for x in seo.inspect_html("country","/country/us",base+marker_html.encode(),{seo.ORIGIN+"/country/us"})}
                self.assertIn("contact_attribution",marker_codes,(scheme,count,plus,"marker"))

    def test_html_semantic_failures_and_category_boundaries(self):
        cases=[("home",b"<meta name='robots' content='index'>","canonical_mismatch"),
               ("noindex",b'<meta name="robots" content="noindex"><link rel="canonical" href="https://worldhotlines.org/status">',"noindex_url_metadata"),
               ("home",html("/").replace(b'{"@context": "https://schema.org"',b'{bad',1),"jsonld_invalid"),
               ("category",html("/category/emergency",category=True)+b'<a href="tel:123">x</a>',"category_contact_leak"),
               ("country",html("/country/us",country=True).replace(b"#record",b"#missing"),"country_fragment"),
               ("country",html("/country/us",country=True).replace(b"tel:+123",b"tel:+1 23"),"unsafe_contact_uri")]
        for name,raw,code in cases:
            self.assertIn(code,{x["code"] for x in seo.run("2026-08-15",fixtures({name:raw}))["issues"]})
        base=html("/category/emergency",category=True)
        accepted=base+b" "*(499_999-len(base)); rejected=accepted+b" "
        self.assertNotIn("category_oversized",{x["code"] for x in seo.run("2026-08-15",fixtures({"category":accepted}))["issues"]})
        self.assertIn("category_oversized",{x["code"] for x in seo.run("2026-08-15",fixtures({"category":rejected}))["issues"]})

    def test_origin_redirect_and_transport_boundaries(self):
        for url in ("http://worldhotlines.org/","https://user@worldhotlines.org/","https://worldhotlines.org:444/","https://worldhotlines.org/?x=1","https://evil.invalid/"):
            with self.assertRaises(ValueError): seo.validate_origin_url(url)
        def failed(url,deadline=None): return {"error":"total_deadline","status":None,"final_url":url,"body":b"","truncated":False,"content_type":"","redirected":False}
        self.assertEqual(seo.run("2026-08-15",failed)["status"],"unavailable")

    def test_exact_robots_and_route_bound_jsonld_contract(self):
        for replacement,code in ((b'',"robots_meta_count"),(b'<meta name="robots" content="">',"robots_directive"),
                (b'<meta name="robots" content="nofollow">',"robots_directive"),
                (b'<meta name="robots" content="index,follow"><meta name="robots" content="index,follow">',"robots_meta_count")):
            raw=html("/"); start=raw.index(b'<meta name="robots"'); end=raw.index(b'>',start)+1
            self.assertIn(code,{x["code"] for x in seo.run("2026-08-15",fixtures({"home":raw[:start]+replacement+raw[end:]}))["issues"]})
        home=html("/")
        script_start=home.index(b'<script'); script_end=home.index(b'</script>',script_start)+9
        self.assertIn("jsonld_required",{x["code"] for x in seo.run("2026-08-15",fixtures({"home":home[:script_start]+home[script_end:]}))["issues"]})
        wrong=html("/country/us",country=True).replace(b'"BreadcrumbList"',b'"WebSite"')
        self.assertIn("jsonld_required",{x["code"] for x in seo.run("2026-08-15",fixtures({"country":wrong}))["issues"]})
        offroute=html("/category/emergency",category=True).replace(b'https://worldhotlines.org/category/emergency',b'https://worldhotlines.org/country/us')
        self.assertIn("jsonld_route_binding",{x["code"] for x in seo.run("2026-08-15",fixtures({"category":offroute}))["issues"]})

    def test_redirect_count_rejects_one_hop_and_return_to_origin(self):
        base=fixtures()
        for count,final,expected in ((0,seo.ORIGIN+"/",False),(1,seo.ORIGIN+"/temporary",True),(2,seo.ORIGIN+"/",True)):
            def fetch(url,deadline=None,count=count,final=final):
                value=base(url,deadline)
                if url == seo.ORIGIN+"/": value.update(final_url=final,redirect_count=count,redirected=bool(count))
                return value
            codes={x["code"] for x in seo.run("2026-08-15",fetch)["issues"]}
            self.assertEqual("redirect" in codes,expected)

    def test_fetch_resource_direct_one_hop_return_and_max_hop(self):
        class Response:
            def __init__(self,status,location=None): self.status=status; self.location=location; self.fp=None
            def getheader(self,name,default=None):
                if name == "Location": return self.location
                if name == "Content-Type": return "text/html"
                return default
            def read(self,size=-1): return b"ok"
        def exercise(routes):
            class Connection:
                def __init__(self,*args): self.path=None
                def request(self,method,path,headers=None): self.path=path
                def getresponse(self):
                    value=routes[self.path]
                    return value.pop(0) if isinstance(value,list) else value
                def close(self): pass
            resolver=lambda host,port,*args,**kwargs: [(socket.AF_INET,socket.SOCK_STREAM,6,"",("93.184.216.34",port))]
            return seo.fetch_resource(seo.ORIGIN+"/",resolver=resolver,connection_factory=Connection)
        direct=exercise({"/":Response(200)})
        self.assertEqual((direct["redirect_count"],direct["redirected"]),(0,False))
        one=exercise({"/":Response(302,"/temporary"),"/temporary":Response(200)})
        self.assertEqual((one["redirect_count"],one["redirected"]),(1,True))
        returned=exercise({"/":[Response(302,"/temporary"),Response(200)],"/temporary":Response(302,"/")})
        self.assertEqual((returned["final_url"],returned["redirect_count"]),(seo.ORIGIN+"/",2))
        loop=exercise({"/":Response(302,"/temporary"),"/temporary":Response(302,"/")})
        # The repeating map reaches the bounded redirect gate rather than spinning.
        self.assertEqual(loop["error"],"redirect_limit")

    def test_social_image_and_truncation(self):
        self.assertIn("social_image_invalid",{x["code"] for x in seo.run("2026-08-15",fixtures({"image":png(10,10)}))["issues"]})
        base=fixtures()
        def truncated(url,deadline=None):
            value=base(url,deadline)
            if url.endswith("sitemap.xml"): value["truncated"]=True
            return value
        self.assertIn("response_oversized",{x["code"] for x in seo.run("2026-08-15",truncated)["issues"]})

    def test_social_image_transport_cap_does_not_cascade_validation(self):
        base=png(production=True)
        payload_size=seo.MAX_IMAGE_BYTES-len(base)-12
        exact=base[:-12]+chunk(b"tEXt",b"x"*payload_size)+base[-12:]
        self.assertEqual(len(exact),seo.MAX_IMAGE_BYTES); self.assertTrue(seo.valid_social_png(exact))
        exact_report=seo.run("2026-08-15",fixtures({"image":exact}))
        self.assertNotIn("response_oversized",{x["code"] for x in exact_report["issues"]})
        self.assertNotIn("social_image_invalid",{x["code"] for x in exact_report["issues"]})
        normal=fixtures()
        def one_over(url,deadline=None):
            response=normal(url,deadline)
            if url.endswith("/social-card.png"):
                response["body"]=exact[:-1]; response["truncated"]=True
            return response
        codes={x["code"] for x in seo.run("2026-08-15",one_over)["issues"]}
        self.assertIn("response_oversized",codes); self.assertNotIn("social_image_invalid",codes)

    def test_social_png_complete_structure_and_exact_dimensions(self):
        valid=png(production=True)
        self.assertTrue(seo.valid_social_png(valid))
        ihdr_end=8+12+13
        cases={
            "bad_signature":b"not-png!"+valid[8:],
            "truncated":valid[:-1],
            "duplicate_ihdr":valid[:ihdr_end]+valid[8:ihdr_end]+valid[ihdr_end:],
            "missing_idat":seo.PNG_SIGNATURE+chunk(b"IHDR",struct.pack(">IIBBBBB",1200,630,8,6,0,0,0))+chunk(b"IEND"),
            "empty_idat":seo.PNG_SIGNATURE+chunk(b"IHDR",struct.pack(">IIBBBBB",1200,630,8,6,0,0,0))+chunk(b"IDAT")+chunk(b"IEND"),
            "missing_iend":valid[:-12],
            "duplicate_iend":valid+chunk(b"IEND"),
            "nonterminal_iend":valid+chunk(b"tEXt",b"x"),
            "bad_crc":valid[:ihdr_end-1]+bytes([valid[ihdr_end-1]^1])+valid[ihdr_end:],
            "wrong_dimensions":png(600,300),
            "oversized_declaration":seo.PNG_SIGNATURE+struct.pack(">I",seo.MAX_IMAGE_BYTES)+b"IDAT",
            "trailing_bytes":valid+b"x",
            "invalid_ihdr":seo.PNG_SIGNATURE+chunk(b"IHDR",struct.pack(">IIBBBBB",1200,630,4,6,1,1,2))+chunk(b"IDAT",b"x")+chunk(b"IEND"),
            "unknown_critical":valid[:-12]+chunk(b"ABCD",b"x")+chunk(b"IEND"),
            "duplicate_plte":valid[:ihdr_end]+chunk(b"PLTE",b"\x00\x00\x00")*2+valid[ihdr_end:],
            "plte_after_idat":valid[:-12]+chunk(b"PLTE",b"\x00\x00\x00")+chunk(b"IEND"),
            "malformed_plte":valid[:ihdr_end]+chunk(b"PLTE",b"\x00")+valid[ihdr_end:],
        }
        for name,raw in cases.items():
            with self.subTest(name=name): self.assertFalse(seo.valid_social_png(raw))

    def test_independent_page_metadata_contract_negatives(self):
        valid=html("/")
        cases=[
            (valid.replace(b"<title>",b"<title></title><title>",1),"title_contract"),
            (valid.replace(b'<meta name="description" content="Emergency information for route /.\">',b'<meta name="description" content="">'),"description_contract"),
            (valid.replace(b"<h1>Route heading</h1>",b"<h1></h1>"),"h1_contract"),
            (valid.replace(b'<meta property="og:title"',b'<meta property="og:title" content="duplicate"><meta property="og:title"',1),"social_metadata_contract"),
            (valid.replace(b'content="Route / | World Hotlines"><meta property="og:description"',b'content="Mismatch"><meta property="og:description"',1),"social_title_mismatch"),
            (valid.replace(b'content="Emergency information for route /.\"><meta property="og:type"',b'content="Mismatch"><meta property="og:type"',1),"social_description_mismatch"),
            (valid.replace(b'content="website"',b'content="article"',1),"social_type_mismatch"),
            (valid.replace(b'content="summary_large_image"',b'content="summary"',1),"twitter_card_mismatch"),
            (valid.replace(seo.SOCIAL_IMAGE.encode(),b"https://evil.invalid/image.png",1),"social_image_mismatch"),
            (valid.replace(b'content="1200"',b'content="0"',1),"social_image_declaration"),
            (valid.replace(b'content="World Hotlines social preview"',b'content=""',1),"social_metadata_contract"),
            (valid.replace(b'href="https://worldhotlines.org/"',b'href="https://evil.invalid/"',1),"canonical_mismatch"),
            (valid.replace(b'property="og:url" content="https://worldhotlines.org/"',b'property="og:url" content="https://worldhotlines.org/?x=1"',1),"og_url_mismatch"),
        ]
        for raw,code in cases:
            self.assertIn(code,{item["code"] for item in seo.run("2026-08-15",fixtures({"home":raw}))["issues"]})

    def test_html_and_robots_mime_contract(self):
        base=fixtures()
        def with_types(html_type="text/html; charset=UTF-8",robots_type="text/plain; charset=\"utf-8\""):
            def fetch(url,deadline=None):
                value=base(url,deadline); name=next(k for k,v in seo.ROUTES.items() if seo.ORIGIN+v==url)
                if name in {"home","country","category","noindex"}: value["content_type"]=html_type
                if name=="robots": value["content_type"]=robots_type
                return value
            return fetch
        self.assertEqual(seo.run("2026-08-15",with_types())["status"],"ok")
        for mime in ("","application/octet-stream","image/png","text/html, application/xhtml+xml","text/html; boundary=x"):
            self.assertIn("html_content_type",{x["code"] for x in seo.run("2026-08-15",with_types(html_type=mime))["issues"]})
        for mime in ("","application/octet-stream","text/html","text/plain, text/html","text/plain; boundary=x"):
            self.assertIn("robots_content_type",{x["code"] for x in seo.run("2026-08-15",with_types(robots_type=mime))["issues"]})

    def test_pathological_html_collections_and_outputs_are_bounded(self):
        anchor=b'<a id="x" class="c" href="TEL:123" data-phone-contact="123">x</a>'
        raw=(html("/country/us",country=True)+anchor*10_000)[:seo.MAX_BYTES]
        parser=seo.PageParser(); parser.feed(raw.decode())
        self.assertLessEqual(len(parser.links),seo.MAX_PARSED_ANCHORS)
        self.assertLessEqual(len(parser.ids),seo.MAX_PARSED_IDS)
        self.assertLessEqual(len(parser.classes),seo.MAX_PARSED_CLASSES)
        first=seo.run("2026-08-15",fixtures({"country":raw})); second=seo.run("2026-08-15",fixtures({"country":raw}))
        self.assertEqual(first,second); self.assertLessEqual(len(first["issues"]),seo.MAX_ISSUES)
        self.assertEqual(seo.validate_result(first),first)
        self.assertLessEqual(len((json.dumps(first,sort_keys=True,indent=2)+"\n").encode()),seo.MAX_JSON_BYTES)
        self.assertLessEqual(len(seo.markdown(first).encode()),seo.MAX_MARKDOWN_BYTES)
        candidates=[seo.issue(f"code-{index}","/",f"detail-{index}") for index in range(seo.MAX_ISSUES+23)]
        bounded=seo.bounded_issues(candidates+candidates)
        self.assertEqual(len(bounded),seo.MAX_ISSUES)
        self.assertEqual(bounded[-1],seo.issue("issues_truncated","public-seo","24 additional unique issues omitted"))

    def test_contact_href_decoding_case_whitespace_controls_and_neighbors(self):
        base=html("/country/us",country=True)
        def issues(href,marker="123",twice=False):
            link=f'<article data-hotline-card data-record-id="x"><a href="{href}" data-phone-contact="{marker}">x</a>'
            if twice: link+=f'<a href="tel:123" data-phone-contact="123">x</a>'
            link+="</article>"
            return seo.inspect_html("country","/country/us",base+link.encode(),{seo.ORIGIN+"/country/us"})
        for href in ("TEL:123","TeL:123"," tel:123","tel:123 ","tel:12&#10;3","tel:12&#x1f;3","tel:12&#160;3","tel:12\u20283"):
            self.assertIn("unsafe_contact_uri",{x["code"] for x in issues(href)})
        self.assertIn("contact_attribution",{x["code"] for x in issues("TEL:123",twice=True)})
        for href in ("telephone:123","tels:123","x:tel:123","telx:123"):
            self.assertNotIn("unsafe_contact_uri",{x["code"] for x in issues(href)})

    def test_sitemap_rejects_entities_declarations_and_resource_overflows(self):
        attacks=[
            b'<!DOCTYPE x [<!ENTITY x "lol">]><urlset>&x;</urlset>',
            b'<!DOCTYPE x SYSTEM "file:///etc/passwd"><urlset/>',
            b'<!ENTITY % x SYSTEM "https://evil.invalid/x">%x;<urlset/>',
            b'<xi:include xmlns:xi="http://www.w3.org/2001/XInclude" href="x"/>',
            b'<?xml version="1.1"?><urlset/>', b'<?xml-stylesheet href="x"?><urlset/>',
        ]
        for raw in attacks: self.assertEqual(seo.inspect_sitemap(raw)[1][0]["code"],"sitemap_xml")
        deep=(b'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+b'<x>'*20+b'</x>'*20+b'</urlset>')
        huge=(b'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>'+b'a'*(seo.MAX_SITEMAP_FIELD_BYTES+1)+b'</loc></url></urlset>')
        attrs=(b'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" '+b' '.join(f'a{x}="x"'.encode() for x in range(20))+b'/>')
        many=(b'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+b'<url><loc>x</loc></url>'*(seo.MAX_SITEMAP_ELEMENTS//2+1)+b'</urlset>')
        for raw in (deep,huge,attrs,many): self.assertEqual(seo.inspect_sitemap(raw)[1][0]["code"],"sitemap_bounds")
        urls="".join(f"<url><loc>{seo.ORIGIN}/country/{i:04d}</loc></url>" for i in range(seo.MAX_SITEMAP_URLS))
        valid=(f'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{urls}</urlset>').encode()
        parsed,found=seo.inspect_sitemap(valid); self.assertEqual((len(parsed),found),(seo.MAX_SITEMAP_URLS,[]))

    def test_cli_rejects_noncanonical_dates_before_fetch_or_publication(self):
        invalid=("20260815"," 2026-08-15","2026-08-15 ","2026-08-15T00:00:00","2026-02-30")
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for value in invalid:
                with mock.patch.object(seo,"run",side_effect=AssertionError("fetch called")):
                    with self.assertRaises(SystemExit): seo.main(["--as-of",value,"--json-output",str(root/"x.json"),"--markdown-output",str(root/"x.md")])
                self.assertFalse((root/"x.json").exists()); self.assertFalse((root/"x.md").exists())


if __name__=="__main__": unittest.main()
