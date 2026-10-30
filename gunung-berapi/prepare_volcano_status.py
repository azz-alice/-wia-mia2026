from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import urljoin
import json, re, requests
from bs4 import BeautifulSoup

OUTPUT = Path(__file__).resolve().parent / "data" / "status-gunung-api.json"
URL = "https://magma.esdm.go.id/v1/gunung-api/tingkat-aktivitas"
LEVELS = {
    "IV": {"number": 4, "label": "Awas"},
    "III": {"number": 3, "label": "Siaga"},
    "II": {"number": 2, "label": "Waspada"},
    "I": {"number": 1, "label": "Normal"},
}

res = requests.get(URL, headers={"User-Agent": "Mozilla/5.0"}, timeout=30)
res.raise_for_status()
soup = BeautifulSoup(res.text, "html.parser")
tables = soup.select("div.table-responsive tbody") or soup.select("table tbody")
if not tables:
    raise RuntimeError("Tabel MAGMA tidak ditemukan. Output tidak dibuat.")

def report_links(node):
    return [a for a in node.find_all("a", href=True) if "lihat laporan" in a.get_text(" ", strip=True).lower()]

table = max(tables, key=lambda n: len(report_links(n)))
if len(report_links(table)) < 40:
    raise RuntimeError("Tautan laporan tidak mencukupi.")

records, groups, current = {}, set(), None
for row in table.find_all("tr"):
    m = re.search(r"Level\s*(IV|III|II|I)\s*\((Awas|Siaga|Waspada|Normal)\)", row.get_text(" ", strip=True), re.I)
    if m:
        roman = m.group(1).upper()
        current = LEVELS[roman]
        groups.add(roman)
    if not current:
        continue
    for cell in row.find_all("td", recursive=False):
        links = report_links(cell)
        if not links:
            continue
        txt = " ".join(re.sub(r"\bLihat laporan\b", "", cell.get_text(" ", strip=True), flags=re.I).split())
        if " - " not in txt:
            continue
        name, loc = [p.strip() for p in txt.split(" - ", 1)]
        if not name or not loc:
            continue
        key = re.sub(r"[^a-z0-9]", "", name.lower())
        rec = {
            "name": name,
            "location": loc,
            "status_level": current["number"],
            "status_label": current["label"],
            "status_updated_at": None,
            "report_url": urljoin(URL, links[0]["href"])
        }
        if key not in records or rec["report_url"]:
            records[key] = rec

if len(records) < 40 or len(groups) < 3:
    raise RuntimeError(f"Hasil belum lengkap: {len(records)} gunung dan {len(groups)} kelompok status.")

volcanoes = sorted(records.values(), key=lambda d: d["name"].lower())
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
OUTPUT.write_text(json.dumps({
    "meta": {
        "source": "MAGMA Indonesia - PVMBG",
        "source_url": URL,
        "retrieved_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "count": len(volcanoes),
        "counts_by_level": {lvl["label"]: sum(v["status_label"] == lvl["label"] for v in volcanoes) for lvl in LEVELS.values()},
        "note": "Snapshot daftar tingkat aktivitas MAGMA. Waktu pengambilan bukan waktu pembaruan status setiap gunung. Periksa laporan resmi untuk detail."
    },
    "volcanoes": volcanoes
}, ensure_ascii=False, indent=2), encoding="utf-8")
