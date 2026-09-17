#!/usr/bin/env python3
"""inspo-irrigation: fetch RSS feeds, score entries against briefs, emit digest."""

import argparse
import datetime as dt
import html
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from email.utils import parsedate_to_datetime
from pathlib import Path

import feedparser
import yaml
import urllib.request

BASE = Path(__file__).resolve().parent
UA = "inspo-irrigation/0.1 (+https://example.invalid; feed reader)"
TIMEOUT = 15


def load_config():
    with open(BASE / "briefs.yaml") as f:
        return yaml.safe_load(f)


def load_canon():
    path = BASE / "canon.yaml"
    if not path.exists():
        return []
    with open(path) as f:
        return yaml.safe_load(f).get("canon") or []


def fetch_feed(source):
    url = source["url"]
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            data = resp.read()
        feed = feedparser.parse(data)
        return source, feed, None
    except Exception as e:  # noqa: BLE001 - one dead feed must not kill the run
        return source, None, str(e)


def entry_date(entry):
    for key in ("published_parsed", "updated_parsed", "created_parsed"):
        t = getattr(entry, key, None)
        if t:
            return dt.datetime(*t[:6], tzinfo=dt.timezone.utc)
    for key in ("published", "updated", "date"):
        s = getattr(entry, key, None)
        if s:
            try:
                d = parsedate_to_datetime(s)
                return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)
            except Exception:
                pass
    return None


def strip_html(text):
    text = re.sub(r"<[^>]+>", " ", text or "")
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def summarize(text, sentences=2):
    text = strip_html(text)
    if not text:
        return ""
    parts = re.split(r"(?<=[.!?])\s+", text)
    out = " ".join(parts[:sentences])
    return out[:400]


def norm_url(url):
    url = (url or "").strip().lower()
    url = re.sub(r"^https?://(www\.)?", "", url)
    url = re.sub(r"[?#].*$", "", url)
    return url.rstrip("/")


def norm_title(title):
    t = re.sub(r"[^a-z0-9 ]+", " ", (title or "").lower())
    return re.sub(r"\s+", " ", t).strip()


WORD_RE_CACHE = {}


def kw_regex(kw):
    if kw not in WORD_RE_CACHE:
        WORD_RE_CACHE[kw] = re.compile(r"\b" + re.escape(kw.lower()) + r"\b")
    return WORD_RE_CACHE[kw]


def score_entry(entry, brief, scoring):
    title = (entry.get("title") or "").lower()
    summary = (entry.get("summary") or "").lower()
    score = 0
    matched = []
    strong_n = mw_n = 0
    for tier in ("strong", "medium", "weak"):
        for kw in brief["keywords"].get(tier) or []:
            rgx = kw_regex(kw)
            hits = len(rgx.findall(summary))
            t_hits = len(rgx.findall(title))
            if hits + t_hits:
                score += scoring[tier] * (hits + t_hits * scoring["title_multiplier"])
                matched.append(kw)
                if tier == "strong":
                    strong_n += 1
                else:
                    mw_n += 1
    for kw in brief.get("avoid") or []:
        rgx = kw_regex(kw)
        hits = len(rgx.findall(title)) + len(rgx.findall(summary))
        if hits:
            score += scoring["avoid"] * hits
            matched.append("avoid:" + kw)
    return {"score": score, "matched": matched, "strong": strong_n, "mw": mw_n}


def surfaces(pb, min_score):
    """Needs >=1 strong hit OR >=2 distinct medium/weak hits, plus min_score."""
    return pb["score"] >= min_score and (pb["strong"] >= 1 or pb["mw"] >= 2)


def canon_score(item, canon_entry):
    """signals on title+summary (title hits x2) + reuse of matched brief keywords.
    Returns (score, matched_signals, title_hit)."""
    score = 0
    title, summary = item["title"].lower(), item["summary"].lower()
    sigs = [s.lower() for s in canon_entry.get("signals") or []]
    sig_hits, title_hit = [], False
    for sig in sigs:
        rgx = kw_regex(sig)
        n_s = len(rgx.findall(summary))
        n_t = len(rgx.findall(title))
        if n_s + n_t:
            sig_hits.append(sig)
            score += n_s + 2 * n_t
            title_hit = title_hit or n_t > 0
    matched_kw = {k for b in item["briefs"].values() for k in b["matched"] if not k.startswith("avoid:")}
    score += sum(1 for k in matched_kw if any(k in sig or sig in k for sig in sigs))
    return score, sig_hits, title_hit


def canon_lineage(item, canon, limit=2):
    """A canon entry matches on >=2 distinct signal hits, or 1 signal hit in the title."""
    scored = sorted(
        ((c, s, sh, th) for c, (s, sh, th) in ((c, canon_score(item, c)) for c in canon)),
        key=lambda x: -x[1],
    )
    return [
        {"id": c["id"], "name": c["name"], "mechanism": c["mechanism"],
         "signals": sh, "score": s}
        for c, s, sh, th in scored[:limit] if len(sh) >= 2 or th
    ]


def canon_hits(item, canon, limit=3):
    """All canon matches under the lineage rule (for candidates.json)."""
    scored = sorted(
        ((c, s, sh, th) for c, (s, sh, th) in ((c, canon_score(item, c)) for c in canon)),
        key=lambda x: -x[1],
    )
    return [
        {"id": c["id"], "name": c["name"], "signals": sh, "score": s}
        for c, s, sh, th in scored[:limit] if len(sh) >= 2 or th
    ]


HN_POINTS = re.compile(r"Points:\s*(\d+)")
HN_COMMENTS = re.compile(r"#\s*Comments:\s*(\d+)")


def canon_pick(canon, n=3):
    """Rotate deterministically by ISO week so the pick changes weekly."""
    if not canon:
        return []
    week = dt.date.today().isocalendar()[1]
    return [canon[(week * 3 + i) % len(canon)] for i in range(n)]


def main():
    ap = argparse.ArgumentParser(description="inspo-irrigation digest")
    ap.add_argument("--out", default=os.getcwd(), help="output directory (default: cwd)")
    ap.add_argument("--lookback", type=int, default=None, help="override lookback_days")
    args = ap.parse_args()
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)

    cfg = load_config()
    canon = load_canon()
    scoring = dict(cfg["scoring"])
    if args.lookback is not None:
        scoring["lookback_days"] = args.lookback
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=scoring["lookback_days"])

    ok_sources, failed_sources, entries = [], [], []
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = [ex.submit(fetch_feed, s) for s in cfg["sources"]]
        for fut in as_completed(futs):
            source, feed, err = fut.result()
            if err is not None or feed is None:
                failed_sources.append({"name": source["name"], "url": source["url"], "error": err or "empty"})
                continue
            ok_sources.append(source["name"])
            for e in feed.entries:
                d = entry_date(e)
                if d is not None and d < cutoff:
                    continue  # keep entry if no date
                raw_summary = e.get("summary", "")
                item = {
                    "title": strip_html(e.get("title", "(untitled)")),
                    "url": e.get("link", ""),
                    "summary": summarize(raw_summary),
                    "date": d.isoformat() if d else "",
                    "source": source["name"],
                    "tag": "",
                }
                if "hacker news" in source["name"].lower():
                    pts = HN_POINTS.search(raw_summary)
                    cmts = HN_COMMENTS.search(raw_summary)
                    if pts or cmts:
                        item["tag"] = (f"HN · {pts.group(1) if pts else '?'} points"
                                       f" · {cmts.group(1) if cmts else '?'} comments")
                        item["summary"] = ""  # hnrss descriptions are pure boilerplate
                entries.append(item)

    total_scanned = len(entries)

    # dedupe by normalized URL, then near-identical title
    seen_urls, seen_titles, deduped = set(), set(), []
    for it in entries:
        nu, nt = norm_url(it["url"]), norm_title(it["title"])
        if (nu and nu in seen_urls) or (nt and nt in seen_titles):
            continue
        seen_urls.add(nu)
        seen_titles.add(nt)
        deduped.append(it)

    for it in deduped:
        it["briefs"] = {b["id"]: score_entry(it, b, scoring) for b in cfg["briefs"]}
        it["canon_hits"] = canon_hits(it, canon)

    lineage_count = 0
    bridges = {}
    for it in deduped:
        if not any(surfaces(v, scoring["min_score"]) for v in it["briefs"].values()):
            it["lineage"] = []
            continue
        it["lineage"] = canon_lineage(it, canon)
        for c in it["lineage"]:
            bridges.setdefault(c["id"], {"entry": c, "items": []})["items"].append(it)
            if len(bridges[c["id"]]["items"]) > 3:
                bridges[c["id"]]["items"] = bridges[c["id"]]["items"][:3]
        if it["lineage"]:
            lineage_count += 1

    sections = []
    for b in cfg["briefs"]:
        items = [
            {"item": it, "score": it["briefs"][b["id"]]["score"], "matched": it["briefs"][b["id"]]["matched"]}
            for it in deduped
            if surfaces(it["briefs"][b["id"]], scoring["min_score"])
        ]
        items.sort(key=lambda x: -x["score"])
        sections.append({"id": b["id"], "name": b["name"], "items": items[: scoring["max_per_brief"]]})

    run_date = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    data = {
        "run_date": run_date,
        "total_scanned": total_scanned,
        "sources_ok": ok_sources,
        "sources_failed": failed_sources,
        "sections": [
            {
                "id": s["id"], "name": s["name"],
                "items": [
                    {**{k: x["item"][k] for k in ("title", "url", "source", "date", "summary")},
                     "score": x["score"], "matched": x["matched"], "lineage": x["item"]["lineage"],
                     "tag": x["item"].get("tag", "")}
                    for x in s["items"]
                ],
            } for s in sections
        ],
        "canon_pick": {
            "applied_to": cfg["briefs"][0]["name"] if cfg["briefs"] else "",
            "entries": [
                {"id": c["id"], "name": c["name"], "era": c.get("era", ""),
                 "mechanism": c["mechanism"], "prompts": c.get("prompts") or []}
                for c in canon_pick(canon)
            ],
        },
        "bridges": [
            {"id": v["entry"]["id"], "name": v["entry"]["name"], "mechanism": v["entry"]["mechanism"],
             "items": [{"title": i["title"], "url": i["url"], "source": i["source"],
                        "date": i["date"]} for i in v["items"]]}
            for v in bridges.values()
        ],
        "lineage_count": lineage_count,
    }

    write_html(data, out)
    (out / "digest.json").write_text(json.dumps(data, indent=2))
    write_md(data, out)

    candidates = sorted(deduped, key=lambda it: -max(v["score"] for v in it["briefs"].values()))[:40]
    (out / "candidates.json").write_text(json.dumps([
        {"title": it["title"], "url": it["url"], "source": it["source"], "date": it["date"],
         "summary": it["summary"][:300],
         "briefs": {bid: {"score": v["score"], "matched": v["matched"]} for bid, v in it["briefs"].items()},
         "canon_hits": it["canon_hits"]}
        for it in candidates
    ], indent=2))
    print(f"scanned={total_scanned} deduped={len(deduped)} ok={len(ok_sources)} failed={len(failed_sources)}")
    print(f"lineage={lineage_count} bridges={len(data['bridges'])} canon_pick={[c['id'] for c in data['canon_pick']['entries']]}")
    for s in data["sections"]:
        print(f"  {s['id']}: {len(s['items'])} items")
    for b in data["bridges"]:
        print(f"  bridged: {b['name']} ({len(b['items'])} items)")
    for fsrc in data["sources_failed"]:
        print(f"  FAILED: {fsrc['name']} -> {fsrc['error']}")


CSS = """
body{font-family:-apple-system,'Segoe UI',Georgia,serif;max-width:680px;margin:0 auto;padding:1.2rem;color:#1a1a1a;background:#fafaf7}
h1{font-size:1.5rem;border-bottom:2px solid #222;padding-bottom:.4rem}
.meta{color:#666;font-size:.85rem;margin-bottom:1.5rem}
h2{font-size:1.2rem;margin-top:2rem;border-bottom:1px solid #ddd;padding-bottom:.3rem}
.item{margin:1rem 0;padding-bottom:1rem;border-bottom:1px dotted #ddd}
.item a{color:#111;font-weight:600;font-size:1.05rem;text-decoration:none}
.item a:hover{text-decoration:underline}
.sm{color:#777;font-size:.8rem;margin:.2rem 0}
.chip{display:inline-block;background:#eee;border-radius:10px;padding:0 .5em;font-size:.72rem;color:#444;margin:.1em .15em 0 0}
.summary{font-size:.9rem;color:#333;margin-top:.3rem}
.lineage{font-size:.8rem;color:#5a4a7a;margin-top:.25rem}
.prompt{font-size:.85rem;color:#333;font-style:italic;margin:.2rem 0}
footer{margin-top:2.5rem;color:#666;font-size:.8rem;border-top:1px solid #ddd;padding-top:1rem}
"""


def write_html(data, out):
    p = [f"<!doctype html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>Inspo digest {html.escape(data['run_date'])}</title><style>{CSS}</style></head><body>"]
    p.append(f"<h1>Inspo digest</h1><div class=meta>{html.escape(data['run_date'])} &middot; {data['total_scanned']} items scanned &middot; {len(data['sources_ok'])} sources ok &middot; {len(data['sources_failed'])} failed</div>")
    for s in data["sections"]:
        p.append(f"<h2>{html.escape(s['name'])}</h2>")
        if not s["items"]:
            p.append("<p><em>No items cleared the bar.</em></p>")
        for it in s["items"]:
            chips = " ".join(f"<span class=chip>{html.escape(k)}</span>" for k in it["matched"])
            date = it["date"][:10] if it["date"] else "no date"
            lin = "".join(
                f"<div class=lineage>Lineage: {html.escape(c['name'])} &mdash; {html.escape(c['mechanism'])}</div>"
                for c in it["lineage"]
            )
            p.append(
                f"<div class=item><a href='{html.escape(it['url'], quote=True)}'>{html.escape(it['title'])}</a>"
                f"<div class=sm>{html.escape(it['source'])}{' &middot; ' + html.escape(it['tag']) if it.get('tag') else ''} &middot; {date} &middot; score {it['score']}</div>"
                f"<div>{chips}</div>{lin}<div class=summary>{html.escape(it['summary'])}</div></div>"
            )
    cp = data["canon_pick"]
    p.append(f"<h2>From the canon <small style='font-weight:400;color:#777;font-size:.8rem'>&mdash; applied to {html.escape(cp['applied_to'])}</small></h2>")
    for c in cp["entries"]:
        p.append(f"<div class=item><strong>{html.escape(c['name'])}</strong> <span class=sm>({html.escape(c['era'])})</span>"
                 f"<div class=summary>{html.escape(c['mechanism'])}</div>")
        for q in c["prompts"]:
            p.append(f"<div class=prompt>&rarr; {html.escape(q)}</div>")
        p.append("</div>")
    if data["bridges"]:
        p.append("<h2>Bridges <small style='font-weight:400;color:#777;font-size:.8rem'>&mdash; classic &harr; current</small></h2>")
        for b in data["bridges"]:
            p.append(f"<div class=item><strong>{html.escape(b['name'])}</strong>"
                     f"<div class=summary>{html.escape(b['mechanism'])}</div>")
            for i in b["items"]:
                p.append(f"<div class=sm>&bull; <a href='{html.escape(i['url'], quote=True)}'>{html.escape(i['title'])}</a> ({html.escape(i['source'])})</div>")
            p.append("</div>")
    p.append("<footer><strong>Sources</strong><br>OK: " + html.escape(", ".join(data["sources_ok"])) + "<br>")
    if data["sources_failed"]:
        p.append("Failed: " + html.escape("; ".join(f"{f['name']} ({f['error']})" for f in data["sources_failed"])))
    else:
        p.append("Failed: none")
    p.append("</footer></body></html>")
    (out / "digest.html").write_text("\n".join(p))


def write_md(data, out):
    p = [f"# Inspo digest — {data['run_date']}", "",
         f"*{data['total_scanned']} items scanned · {len(data['sources_ok'])} sources ok · {len(data['sources_failed'])} failed*", ""]
    for s in data["sections"]:
        p += [f"## {s['name']}", ""]
        if not s["items"]:
            p.append("_No items cleared the bar._")
        for it in s["items"]:
            date = it["date"][:10] if it["date"] else "no date"
            chips = " ".join(f"`{k}`" for k in it["matched"])
            src = it["source"] + (f" · {it['tag']}" if it.get("tag") else "")
            p += [f"- **[{it['title']}]({it['url']})** — {src} · {date} · score {it['score']}",
                  f"  {chips}"]
            for c in it["lineage"]:
                p.append(f"  _Lineage: {c['name']} — {c['mechanism']}_")
            p.append(f"  {it['summary']}")
        p.append("")
    cp = data["canon_pick"]
    p += [f"## From the canon — applied to {cp['applied_to']}", ""]
    for c in cp["entries"]:
        p += [f"- **{c['name']}** ({c['era']}): {c['mechanism']}"]
        p += [f"  - _{q}_" for q in c["prompts"]]
    p.append("")
    if data["bridges"]:
        p += ["## Bridges — classic ↔ current", ""]
        for b in data["bridges"]:
            p.append(f"- **{b['name']}**: {b['mechanism']}")
            for i in b["items"]:
                p.append(f"  - [{i['title']}]({i['url']}) ({i['source']})")
        p.append("")
    p += ["---", "**Sources**",
          "OK: " + ", ".join(data["sources_ok"]),
          "Failed: " + ("; ".join(f"{f['name']} ({f['error']})" for f in data["sources_failed"]) or "none")]
    (out / "digest.md").write_text("\n".join(p) + "\n")


if __name__ == "__main__":
    main()
