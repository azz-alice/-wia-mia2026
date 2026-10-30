from pathlib import Path
from datetime import datetime, timezone
import json, re

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT.parent / "data" / "raw" / "gvp-holocene.geojson"
OUTPUT = ROOT / "data" / "gunung-api-lokasi.json"

def normalize(v):
    return re.sub(r"[^a-z0-9]", "", str(v).lower())

def get_prop(props, *names):
    idx = {normalize(k): v for k, v in props.items()}
    for n in names:
        val = idx.get(normalize(n))
        if val not in (None, ""):
            return val
    return None

def as_num(v):
    try:
        n = float(v)
        return n if n == n else None
    except (ValueError, TypeError):
        return None

if not SOURCE.exists():
    raise FileNotFoundError(f"File sumber tidak ditemukan: {SOURCE}")

features = json.loads(SOURCE.read_text(encoding="utf-8-sig")).get("features")
if not isinstance(features, list):
    raise ValueError("File sumber bukan GeoJSON FeatureCollection yang memiliki daftar features.")

volcanoes, seen = [], set()
for feat in features:
    props = feat.get("properties") or {}
    if "indonesia" not in str(get_prop(props, "Country", "State") or "").lower():
        continue
    name = get_prop(props, "VolcanoName", "Volcano Name", "Name", "Volcano")
    geom = feat.get("geometry") or {}
    coords = geom.get("coordinates")
    lon = as_num(coords[0]) if geom.get("type") == "Point" and isinstance(coords, list) and len(coords) >= 2 else None
    lat = as_num(coords[1]) if lon is not None else None
    if lat is None or lon is None:
        lat = as_num(get_prop(props, "Latitude", "Lat"))
        lon = as_num(get_prop(props, "Longitude", "Lon", "Long"))
    if not name or lat is None or lon is None or not (-12 <= lat <= 7 and 94 <= lon <= 142):
        continue
    vid = get_prop(props, "VolcanoNumber", "Volcano Number", "Volcano_Number")
    key = str(vid or name).strip().lower()
    if key in seen:
        continue
    seen.add(key)
    volcanoes.append({
        "id": vid,
        "name": str(name).strip(),
        "country": "Indonesia",
        "latitude": lat,
        "longitude": lon,
        "region": get_prop(props, "VolcanicRegion", "Volcanic Region"),
        "landform": get_prop(props, "VolcanoLandform", "Volcano Landform"),
        "elevation_m": as_num(get_prop(props, "SummitElevM", "Elevation", "Elevation_m")),
        "status_level": None,
        "status_label": None,
        "status_updated_at": None,
        "report_url": None
    })

volcanoes.sort(key=lambda d: d["name"].lower())
if not volcanoes:
    raise ValueError("Tidak ada gunung api Indonesia dengan koordinat valid.")

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
OUTPUT.write_text(json.dumps({
    "meta": {
        "source": "Smithsonian Global Volcanism Program",
        "dataset": "Holocene Volcanoes",
        "source_version": "VOTW 5.4.0",
        "retrieved_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "count": len(volcanoes),
        "note": "Katalog lokasi gunung api dengan aktivitas Holocene. Status aktivitas terkini harus diverifikasi terpisah melalui MAGMA Indonesia."
    },
    "volcanoes": volcanoes
}, ensure_ascii=False, indent=2), encoding="utf-8")
