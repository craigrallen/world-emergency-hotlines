#!/usr/bin/env python3
"""
Walk every hotline in hotlines.json, recompute its category using an expanded
keyword table, and update it if the new guess is more specific than the old
`general_support` fallback.

Never downgrades a record that already has a specific category or is
verified_knowledge/verified_web — only touches `general_support` legacy entries.
"""
from __future__ import annotations

import json
import pathlib
import re

ROOT = pathlib.Path(__file__).parent.parent
OUT = ROOT / "hotlines.json"

# Category rules — ordered, first match wins.
# Each entry is (category, [regex patterns]).
RULES = [
    ("suicide_crisis", [
        r"\bsuicid", r"\blifeline\b", r"samarit", r"befriender", r"\bcrisis\b",
        r"hopelin", r"hopeline", r"\bespera(nza|nce)\b", r"esperan", r"sumithrayo",
        r"salva-?vidas", r"salvavida", r"sos vida", r"linha da vida", r"línea de vida",
        r"línea de la vida", r"suicide prevention", r"chi hoc ?e", r"kaan pete",
        r"\b988\b", r"\b13[ -]?11[ -]?14\b", r"maytree", r"pieta", r"eluliin",
        r"livsli", r"vilti?es", r"dargebotene hand", r"telefonseelsorge",
        r"mind.*(helpline|line)", r"\bkirans?\b", r"aasra", r"vandrevala",
        r"asistencia al suicid", r"centro.*valoriza", r"svarta.*frelsis",
        r"\bsamu.*soc", r"valoriza.*vida", r"\bcvv\b", r"línea de emergencia emocional",
        r"\briranshofnin"
    ]),
    ("emergency", [
        r"^emergency$", r"\bpolice\b", r"^police", r"\bambulan", r"^ambulance",
        r"\bfire\b", r"^fire\b", r"rescue\b", r"coast guard", r"poison\b",
        r"\b(112|911|999|000|110|119|113|118|108|102|114)\b"
    ]),
    ("child_protection", [
        r"\bchildlin", r"\bkids help", r"\bkidsline\b", r"kinder.?notruf",
        r"kinder.?telefon", r"bri[sz] bar", r"lina bezpe[čc]", r"linie detsk",
        r"allo enfan", r"allô enfan", r"enfance en dan", r"telefon.*nzog",
        r"alo niños?", r"niñez", r"fono niñ", r"\bchild abuse\b", r"cybertip",
        r"nspcc\b", r"childline", r"child.* help", r"child.* protect",
        r"child.* welfare", r"minor(s|es) en riesgo", r"menores?\b",
        r"runaway", r"\byouth abuse", r"\bchildren's?\b", r"teleayudas niños?",
        r"tithandizane", r"bantay bata", r"tinkle friend", r"1098\b",
        r"116 ?111", r"jóvenes en crisis"
    ]),
    ("youth", [
        r"\byouth\b", r"\bteen\b", r"young people", r"under[- ]?\d+ ?yr",
        r"\bjuvenil\b", r"\bjeuness?e?\b", r"jongeren", r"the mix",
        r"get connected", r"youthline", r"youthl", r"jaunimo", r"awel"
    ]),
    ("domestic_violence", [
        r"domest(ic)? abuse", r"domest(ic)? violence", r"family violence", r"gbv\b",
        r"gender.?based violence", r"violence against women", r"wom(a|e)n'?s? (aid|shelter|helpline|refuge|center|line)",
        r"violencia (doméstica|familiar|de género|hacia la mujer)", r"mujer.*violenc",
        r"abused women", r"refugio", r"shelter.*women", r"mujeres? víctimas",
        r"refuge\b", r"frauenhelp", r"frauen.*notruf", r"violences? femmes",
        r"violence conjug", r"gewalt.*fraue", r"linha?s? mujer",
        r"femmes en d[ée]tress", r"1522\b", r"\b016\b", r"3919\b", r"8350\b",
        r"národní linka.*zen", r"nane\b"
    ]),
    ("sexual_violence", [
        r"\brape\b", r"sexual assault", r"sexual abuse", r"sexual violence",
        r"violaci[óo]n sexual", r"aggression sexuelle", r"victim.*sexual",
        r"rainn\b", r"survivors?.*sexual", r"agresion sexual", r"sexueller?\s?missbrauch",
        r"centrum seksueel", r"rape crisis", r"dublin rape"
    ]),
    ("lgbtqia", [
        r"\blgbt", r"lgbtiq", r"lgbtq", r"queer\b", r"\btrans\b", r"gay\b",
        r"lesbian", r"rainbow", r"trevor", r"stonewall", r"switchboard.*lgbt",
        r"galop\b", r"hoslgs?i wien", r"hosi\b", r"kaos gl", r"switchboard",
        r"oogachaga", r"qlife", r"outline", r"rosa l[ëe]", r"mermaids"
    ]),
    ("substance_use", [
        r"alcohol", r"drug", r"narcot", r"addict", r"\bfrank\b", r"\bsucht\b",
        r"drogue", r"adicc", r"adikció", r"toxicoman", r"cocain", r"heroin",
        r"substance", r"anonymous alcoholic", r"al.?anon", r"\bna\b", r"\baa\b",
        r"sedrona", r"senda\b", r"conadic", r"rozan\b", r"rustelefonen", r"talktofrank",
        r"druglink", r"drogas? info", r"\bpéihde", r"drop.?in"
    ]),
    ("gambling", [
        r"gambl", r"apuest", r"ludopath", r"problem gambling",
        r"gamcare", r"joueur", r"jogo (compuls|patol)", r"peluuri",
        r"hjälplinjen.*spel", r"stödlinjen"
    ]),
    ("eating_disorders", [
        r"eating disord", r"anorex", r"bulim", r"binge eating", r"beat\b",
        r"feast\b", r"trastorno.*aliment", r"alimentación"
    ]),
    ("bereavement", [
        r"bereav", r"\bgrief\b", r"\bcruse\b", r"\bsands\b", r"widow", r"viuda",
        r"pet loss", r"duel[oe]\b", r"deuil", r"trauerfall", r"survivors? of bereav",
        r"winston.*wish", r"grief encounter", r"compassionate friends",
        r"loss.*pregnanc", r"pregnancy loss", r"stillbirth"
    ]),
    ("self_harm", [
        r"self.?harm", r"self.?injur", r"cutters?\b", r"autoagressi[óo]n"
    ]),
    ("veterans", [
        r"veteran", r"military", r"armed forces", r"combat stress", r"open arms",
        r"service member"
    ]),
    ("human_trafficking", [
        r"traffick", r"modern.?slavery", r"trata\b", r"tráfico humano", r"la strada",
        r"unseen\b", r"polaris"
    ]),
    ("missing_persons", [
        r"missing person", r"missing people", r"\bmissing\b", r"runaway", r"despareci",
        r"116 ?000", r"asfaddes"
    ]),
    ("elder_abuse", [
        r"elder", r"older people", r"\bage(ing)? uk\b", r"age concern",
        r"silver line", r"hourglass", r"adulto mayor", r"anciano", r"senior"
    ]),
    ("stalking", [
        r"stalk"
    ]),
    ("perinatal", [
        r"postpartum", r"postnatal", r"perinatal", r"pregnancy support", r"maternal",
        r"new parent"
    ]),
    ("disability", [
        r"disability", r"disabled", r"hearing loss", r"visually impaired",
        r"chronic illness", r"\bms\b society", r"cancer", r"hiv", r"aids ?(info|helpline|line)",
        r"dementia", r"autism"
    ]),
    ("male_victims", [
        r"\bmen'?s\b", r"male\s+(victim|advice|helpline|line|hotline)",
        r"mensline", r"männer", r"hommes? en détress"
    ]),
    ("refugee_migrant", [
        r"refugee", r"asylum", r"migrant", r"refugi"
    ]),
    ("mental_health", [
        r"mental health", r"mental illness", r"psycholog", r"psychiatric",
        r"psychosoci", r"\bmind\b", r"anxiety", r"depress", r"\bsane\b",
        r"wellbeing", r"psychique", r"psíquic", r"salud mental", r"santé mentale",
        r"distress line", r"crisis line", r"\bhelp\bline", r"emotional support"
    ]),
]


def classify(name: str) -> str | None:
    low = (name or "").lower()
    for cat, pats in RULES:
        for p in pats:
            if re.search(p, low):
                return cat
    return None


def main():
    data = json.loads(OUT.read_text(encoding="utf-8"))
    moved = 0
    by_new_cat = {}
    for c in data["countries"]:
        for h in c["hotlines"]:
            if h.get("verification_status") != "legacy_unverified":
                continue
            if h.get("category") != "general_support":
                continue
            guess = classify(h.get("name", ""))
            if guess and guess != "general_support":
                h["category"] = guess
                moved += 1
                by_new_cat[guess] = by_new_cat.get(guess, 0) + 1
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Recategorised {moved} records:")
    for cat, n in sorted(by_new_cat.items(), key=lambda kv: -kv[1]):
        print(f"  {cat}: {n}")


if __name__ == "__main__":
    main()
