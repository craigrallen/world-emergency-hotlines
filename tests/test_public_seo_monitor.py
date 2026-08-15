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
    if country: extra='<a href="#record">jump</a><article id="record" class="scroll-mt-24" data-hotline-card data-record-id="weh_1"><a href="tel:+123" data-phone-contact="+123">123</a></article>'
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
            "oversized_declaration":seo.PNG_SIGNATURE+struct.pack(">I",seo.MAX_BYTES)+b"IDAT",
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
