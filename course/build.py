"""Build "Order Books From Zero" into one self-contained HTML file.

    python course/build.py            # writes course/dist/order-books-from-zero.html + tests.html

Standard library only. Steps:

1. Generate the built-in data (course/data/builtin.json) from data/live-2026-10-18/:
   the playground.json export (v1) plus the raw Phoenix snapshot and a summary of it. If
   course/data/export.json exists (export v2, made by ``python -m impact_analyzer export``),
   it replaces playground.json as the built-in dataset.
2. Inline tokens.css + components.css, the JS files in dependency order, and the data into
   src/shell.html. Data goes in a <script type="application/json"> block: parsed, never run.
3. Run contract checks and fail loudly: missing files, colours outside tokens.css, external
   scripts, remote fetches, [[term]] links to unknown glossary ids, OBZ.<name> used but never
   defined, unbalanced HTML, size over 2 MB.
4. Build course/dist/tests.html the same way, with golden.json and tests.js.
"""

from __future__ import annotations

import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

COURSE = Path(__file__).resolve().parent
REPO = COURSE.parent
SRC = COURSE / "src"
JS = SRC / "js"
DIST = COURSE / "dist"
LIVE = REPO / "data" / "live-2026-10-18"
DATA_DIR = COURSE / "data"
OUT = DIST / "order-books-from-zero.html"
TESTS_OUT = DIST / "tests.html"
MAX_BYTES = 2 * 1024 * 1024

# Load order matters: each file may use what earlier files define.
CORE_JS = [
    "core/util.js",
    "core/engine.js",
    "core/amm.js",
    "core/store.js",
    "core/router.js",
    "core/glossary.js",
    "core/data.js",
    "core/ui.js",
]
CSS = ["css/tokens.css", "css/components.css"]

# Base-tier taker fees, mirrored from src/impact_analyzer/fees.py (checked below).
BASE_FEES = {"phoenix": 2.0, "kraken": 40.0, "coinbase": 120.0}


class BuildError(SystemExit):
    def __init__(self, msg: str) -> None:
        super().__init__(f"BUILD FAILED: {msg}")


def read(path: Path) -> str:
    if not path.is_file():
        raise BuildError(f"missing file {path.relative_to(REPO)}")
    return path.read_text(encoding="utf-8")


# --------------------------------------------------------------------------- JS order
def js_files() -> list[Path]:
    files = [JS / f for f in CORE_JS]
    files.append(JS / "chapters" / "registry.js")
    chapters = sorted((JS / "chapters").glob("[0-9][0-9]-*.js"))
    numbers = [int(p.name[:2]) for p in chapters]
    if sorted(set(numbers)) != list(range(1, 14)) or len(numbers) != 13:
        raise BuildError(f"expected one chapter file per number 01..13, found {numbers}")
    files += chapters
    files.append(JS / "play" / "registry.js")
    files += sorted(p for p in (JS / "play").glob("*.js") if p.name != "registry.js")
    files += sorted((JS / "interview").glob("*.js"))
    files.append(JS / "app.js")
    for f in files:
        if not f.is_file():
            raise BuildError(f"missing file {f.relative_to(REPO)}")
    return files


def bundle_js(files: list[Path]) -> str:
    parts = ["window.OBZ = window.OBZ || {};"]
    for f in files:
        src = read(f)
        if re.search(r"</script", src, re.I):
            raise BuildError(f"{f.name} contains '</script', which would end the inline script")
        parts.append(f"/* ==== {f.relative_to(SRC).as_posix()} ==== */\n{src}")
    return "\n".join(parts)


# --------------------------------------------------------------------------- data
def latest(pattern: str) -> Path:
    files = sorted(LIVE.glob(pattern))
    if not files:
        raise BuildError(f"no {pattern} in {LIVE.relative_to(REPO)}")
    return files[-1]


def check_fees() -> None:
    """Keep BASE_FEES in step with fees.py without importing the package."""
    src = read(REPO / "src" / "impact_analyzer" / "fees.py")
    for venue, bps in BASE_FEES.items():
        m = re.search(rf'"{venue}":\s*([0-9.]+)', src)
        if not m or float(m.group(1)) != bps:
            raise BuildError(f"BASE_FEES[{venue!r}] = {bps} no longer matches fees.py")


def phoenix_summary(snap: dict) -> dict:
    tick = float(snap["tick_size"])
    lot = float(snap["lot_size"])
    bids, asks = snap["bids"], snap["asks"]
    best_bid, best_ask = bids[0][0], asks[0][0]
    mid = (best_bid + best_ask) * tick / 2
    meta = snap.get("meta", {})

    def usd(side, keep) -> float:
        return sum(p * tick * s * lot for p, s in side if keep(p * tick))

    return {
        "venue": "phoenix",
        "address": meta.get("address"),
        "slot": meta.get("slot"),
        "taker_fee_bps": meta.get("taker_fee_bps"),
        "market_sequence_number": meta.get("market_sequence_number"),
        "fetched_at": snap["fetched_at"],
        "tick_size": snap["tick_size"],
        "lot_size": snap["lot_size"],
        "n_bids": len(bids),
        "n_asks": len(asks),
        "best_bid_ticks": best_bid,
        "best_ask_ticks": best_ask,
        "mid": mid,
        "spread_bps": (best_ask - best_bid) * tick / mid * 10_000,
        "lowest_bid": bids[-1],
        "highest_ask": asks[-1],
        "junk": {
            "bids_below_half_mid": sum(1 for p, _ in bids if p * tick < mid / 2),
            "asks_above_double_mid": sum(1 for p, _ in asks if p * tick > mid * 2),
        },
        "notional_usd": {"bid": usd(bids, lambda p: True), "ask": usd(asks, lambda p: True)},
        "within_10pct_usd": {
            "bid": usd(bids, lambda p: p >= mid * 0.9),
            "ask": usd(asks, lambda p: p <= mid * 1.1),
        },
    }


def build_data() -> tuple[dict, list[str]]:
    sources = []
    export = DATA_DIR / "export.json"
    if export.is_file():
        builtin = json.loads(read(export))
        if builtin.get("kind") != "impact-analyzer-export" or builtin.get("version") not in (1, 2):
            raise BuildError("course/data/export.json is not an impact-analyzer export v1/v2")
        sources.append(export.relative_to(REPO).as_posix())
    else:
        pg = LIVE / "playground.json"
        builtin = json.loads(read(pg))
        sources.append(pg.relative_to(REPO).as_posix())
    check_fees()
    for v in builtin["venues"]:
        if "fee_bps" not in v:
            fee = (v.get("meta") or {}).get("taker_fee_bps", BASE_FEES.get(v["venue"]))
            if fee is not None:
                v["fee_bps"] = fee
    ph_path = latest("phoenix-*.json")
    raw = json.loads(read(ph_path))
    sources.append(ph_path.relative_to(REPO).as_posix())
    payload = {
        "builtin": builtin,
        "phoenix": {"snapshot": raw, "summary": phoenix_summary(raw)},
        "sources": sources,
    }
    DATA_DIR.mkdir(exist_ok=True)
    (DATA_DIR / "builtin.json").write_text(json.dumps(payload, separators=(",", ":")), "utf-8")
    return payload, sources


def json_for_html(obj) -> str:
    # "</" could close the <script> block early; "<\/" means the same thing to JSON.parse.
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False).replace("</", "<\\/")


# --------------------------------------------------------------------------- checks
class Balance(HTMLParser):
    VOID = {"meta", "link", "br", "img", "input", "hr", "source", "area", "base", "col", "wbr"}
    SVG_SELF = {"rect", "circle", "path", "line", "polyline", "polygon", "stop", "use", "ellipse"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[tuple[str, int]] = []
        self.errors: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag not in self.VOID:
            self.stack.append((tag, self.getpos()[0]))

    def handle_startendtag(self, tag, attrs):
        pass

    def handle_endtag(self, tag):
        if tag in self.VOID:
            return
        if not self.stack or self.stack[-1][0] != tag:
            open_tag = self.stack[-1] if self.stack else None
            self.errors.append(f"line {self.getpos()[0]}: </{tag}> closes {open_tag}")
            # recover: pop to the matching tag if present
            for i in range(len(self.stack) - 1, -1, -1):
                if self.stack[i][0] == tag:
                    del self.stack[i:]
                    break
            return
        self.stack.pop()


def check_balanced(html: str, name: str) -> None:
    p = Balance()
    p.feed(html)
    p.close()
    leftovers = [t for t in p.stack if t[0] not in ("html", "body", "head")]
    if p.errors or leftovers:
        raise BuildError(f"{name}: unbalanced HTML: {p.errors[:5]} unclosed {leftovers[:5]}")


def check_css(css_files: dict[str, str]) -> None:
    colour = re.compile(r"#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(")
    for name, text in css_files.items():
        if name.endswith("tokens.css"):
            continue
        body = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
        m = colour.search(body)
        if m:
            raise BuildError(
                f"{name} contains a colour value ({m.group(0)}); colours live in tokens.css"
            )


def check_js(bundle: str, files: list[Path], glossary_ids: set[str]) -> None:
    code = re.sub(r"/\*.*?\*/", "", bundle, flags=re.S)
    if re.search(r"\bfetch\s*\(|XMLHttpRequest|importScripts\s*\(\s*['\"]http", code):
        raise BuildError("the bundle makes a network request (fetch/XMLHttpRequest)")
    if re.search(r"<script[^>]+src=", bundle):
        raise BuildError("the bundle references an external script")
    defined = set(re.findall(r"\bOBZ\.([A-Za-z_]\w*)\s*=(?!=)", code))
    used = set(re.findall(r"\bOBZ\.([A-Za-z_]\w*)", code))
    missing = sorted(used - defined)
    if missing:
        raise BuildError(f"OBZ.{', OBZ.'.join(missing)} used but never defined")
    # [[term]] links in authored strings must exist in the glossary.
    bad = []
    lesson_files = [f for f in files if f.parent.name in ("chapters", "play", "interview")]
    for f in lesson_files:
        text = re.sub(r"/\*.*?\*/", "", read(f), flags=re.S)  # skip doc comments
        for m in re.finditer(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]", text):
            term = m.group(1).strip()
            if term not in glossary_ids:
                bad.append(f"{f.name}: [[{term}]]")
    # Term("id") calls with a literal id.
    for f in files:
        for m in re.finditer(r"\bTerm\(\s*\"([a-z0-9-]+)\"", read(f)):
            if m.group(1) not in glossary_ids and f.parent.name != "tests":
                bad.append(f'{f.name}: Term("{m.group(1)}")')
    if bad:
        raise BuildError("unknown glossary terms: " + "; ".join(sorted(set(bad))))


def glossary_ids() -> set[str]:
    src = read(JS / "core" / "glossary.js")
    body = src[src.index("const E = {") : src.index("// ---- lookup helpers")]
    ids = set(re.findall(r"^\s{4}(?:\"([a-z0-9-]+)\"|([a-z0-9]+)):\s*\{", body, flags=re.M))
    return {a or b for a, b in ids}


def check_shell(html: str) -> None:
    if "<title>Order Books From Zero</title>" not in html:
        raise BuildError("shell.html must have <title>Order Books From Zero</title>")
    for m in re.finditer(r"<link[^>]+href=\"([^\"]+)\"", html):
        href = m.group(1)
        if not href.startswith(("https://fonts.googleapis.com", "https://fonts.gstatic.com")):
            raise BuildError(f"external stylesheet/link not allowed: {href}")
    if re.search(r"<script[^>]+src=", html):
        raise BuildError("external <script src> is not allowed")


# --------------------------------------------------------------------------- assemble
def fill(template: str, parts: dict[str, str], name: str) -> str:
    def repl(m: re.Match) -> str:
        key = m.group(1)
        if key not in parts:
            raise BuildError(f"{name}: unknown placeholder BUILD:{key}")
        return parts[key]

    out = re.sub(r"/\*BUILD:([A-Z]+)\*/", repl, template)
    left = re.findall(r"/\*BUILD:[A-Z]+\*/", out)
    if left:
        raise BuildError(f"{name}: placeholders left over: {left}")
    return out


def main() -> None:
    files = js_files()
    css_texts = {f: read(SRC / f) for f in CSS}
    check_css(css_texts)
    css = "\n".join(css_texts.values())
    bundle = bundle_js(files)
    gids = glossary_ids()
    if len(gids) < 100:
        raise BuildError(f"glossary parse found only {len(gids)} ids")
    check_js(bundle, files, gids)
    payload, sources = build_data()
    data_json = json_for_html(payload)

    shell = read(SRC / "shell.html")
    check_shell(shell)
    html = fill(shell, {"CSS": css, "DATA": data_json, "JS": bundle}, "shell.html")
    check_balanced(
        re.sub(r"<(script|style)\b[^>]*>.*?</\1>", "<\\1></\\1>", html, flags=re.S | re.I), "page"
    )
    DIST.mkdir(exist_ok=True)
    OUT.write_text(html, encoding="utf-8", newline="\n")
    size = OUT.stat().st_size
    if size > MAX_BYTES:
        raise BuildError(f"{OUT.name} is {size / 1048576:.2f} MB, over the 2 MB limit")

    golden_path = COURSE / "tests" / "golden.json"
    if not golden_path.is_file():
        raise BuildError("course/tests/golden.json missing: run python course/tests/make_golden.py")
    tests_js = read(COURSE / "tests" / "tests.js")
    if re.search(r"</script", tests_js, re.I):
        raise BuildError("tests.js contains '</script', which would end the inline script")
    tests_html = fill(
        read(COURSE / "tests" / "tests.html"),
        {
            "CSS": css,
            "DATA": data_json,
            "JS": bundle,
            "GOLDEN": read(golden_path).replace("</", "<\\/"),
            "TESTS": tests_js,
        },
        "tests.html",
    )
    TESTS_OUT.write_text(tests_html, encoding="utf-8", newline="\n")

    print(f"data      {', '.join(sources)}")
    print(f"js        {len(files)} files, {len(bundle) / 1024:.0f} KB")
    print(f"css       {len(css) / 1024:.0f} KB")
    print(f"data      {len(data_json) / 1024:.0f} KB")
    print(f"glossary  {len(gids)} terms")
    print(f"wrote     {OUT.relative_to(REPO)}  {size / 1024:.0f} KB ({size:,} bytes)")
    print(f"wrote     {TESTS_OUT.relative_to(REPO)}  {TESTS_OUT.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    try:
        main()
    except BuildError as e:
        print(e.code, file=sys.stderr)
        sys.exit(1)
