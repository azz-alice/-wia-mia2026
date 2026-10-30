from pathlib import Path
from datetime import datetime, timezone
import json, re, unicodedata

DATA = Path(__file__).resolve().parent / "data"
LOCATION_FILE = DATA / "gunung-api-lokasi.json"
STATUS_FILE = DATA / "status-gunung-api.json"
OUTPUT_FILE = DATA / "gunung-api-map.json"

def normalize(value):
    val = "".join(c for c in unicodedata.normalize("NFKD", str(value or "")) if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]", "", val.lower())

ALIASES = {
    "dieng": ("diengvolcaniccomplex", "complex"),
    "gede": ("gedepangrango", "complex"),
    "ilewerung": ("iliwerung", "alias"),
    "anakkrakatau": ("krakatau", "complex"),
    "ililewotolok": ("lewotolok", "alias"),
    "lokon": ("lokonempung", "complex"),
    "peutsague": ("peuetsague", "alias"),
    "rokatenda": ("paluweh", "alias"),
    "anakranakah": ("ranakah", "alias"),
    "tandikat": ("tandikatsinggalang", "complex"),
    "tangkoko": ("tangkokoduasudara", "complex"),
    "burnitelong": ("telongburni", "alias"),
    "bromo": ("tenggercaldera", "complex"),
}

for path in (LOCATION_FILE, STATUS_FILE):
    if not path.exists():
        raise FileNotFoundError(f"File tidak ditemukan: {path}")

location_data = json.loads(LOCATION_FILE.read_text(encoding="utf-8"))
status_data = json.loads(STATUS_FILE.read_text(encoding="utf-8"))
locations = location_data.get("volcanoes", [])
statuses = status_data.get("volcanoes", [])
if not locations or not statuses:
    raise ValueError("Dataset lokasi atau status kosong.")

locations_by_name = {}
for loc in locations:
    key = normalize(loc.get("name"))
    if key:
        locations_by_name.setdefault(key, []).append(loc)

volcanoes, missing_coordinates = [], []
counts = {"exact": 0, "alias": 0, "complex": 0}

for status in statuses:
    name = status.get("name", "")
    key = normalize(name)
    matches = locations_by_name.get(key, [])
    match_type = "exact"
    if not matches and key in ALIASES:
        loc_key, match_type = ALIASES[key]
        matches = locations_by_name.get(loc_key, [])
    loc = matches[0] if matches else None
    lat = loc.get("latitude") if loc else None
    lon = loc.get("longitude") if loc else None

    if loc and lat is not None and lon is not None:
        counts[match_type if match_type in counts else "complex"] += 1
    else:
        lat = lon = None
        missing_coordinates.append(name)
        match_type = "missing"

    volcanoes.append({
        "id": key,
        "name": name,
        "province": status.get("location"),
        "latitude": lat,
        "longitude": lon,
        "elevation_m": loc.get("elevation_m") if loc else None,
        "status_level": status.get("status_level"),
        "status_label": status.get("status_label"),
        "status_updated_at": status.get("status_updated_at"),
        "status_report_url": status.get("report_url"),
        "coordinate_source": (loc.get("coordinate_source") or "Smithsonian Global Volcanism Program") if loc else None,
        "coordinate_match": match_type,
        "coordinate_note": "Koordinat katalog kompleks vulkanik, bukan jaminan posisi kawah aktif yang tepat." if match_type == "complex" else None
    })

result = {
    "meta": {
        "location_source": location_data["meta"]["source"],
        "status_source": status_data["meta"]["source"],
        "status_snapshot_at_utc": status_data["meta"].get("retrieved_at_utc"),
        "generated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "count": len(volcanoes),
        "coordinate_exact_count": counts["exact"],
        "coordinate_alias_count": counts["alias"],
        "coordinate_complex_count": counts["complex"],
        "missing_coordinates_count": len(missing_coordinates),
        "note": "Status merupakan snapshot dari MAGMA. Koordinat kompleks vulkanik dapat berbeda dari posisi kawah aktif yang tepat. Entri tanpa koordinat tidak boleh digambar sebagai marker."
    },
    "volcanoes": volcanoes,
    "missing_coordinates": missing_coordinates
}

OUTPUT_FILE.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
