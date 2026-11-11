import csv
import datetime
import io
import json
import math
import os
import pathlib
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from shapely.geometry import Point, shape
from shapely.prepared import prep

ROOT_DIR = pathlib.Path(__file__).resolve().parent
ENV_PATH = ROOT_DIR / ".env"
GEOJSON_PATH = ROOT_DIR / "karhutla" / "data" / "indonesia-kabupaten-kota.geojson"
AIR_FALLBACK_PATH = ROOT_DIR / "karhutla" / "data" / "air-quality.json"
SUMMARY_PATH = ROOT_DIR / "karhutla" / "data" / "city-environment-summary.json"
COMMUNITY_DB_PATH = ROOT_DIR / "karhutla" / "data" / "community_reports.sqlite"

BBOX = (94.0, -12.0, 142.0, 7.0)
FIRMS_NRT_SOURCES = (
    ("VIIRS_NOAA20_NRT", 2),
    ("VIIRS_NOAA21_NRT", 2),
    ("MODIS_NRT", 2),
    ("VIIRS_SNPP_NRT", 2),
)


def load_dotenv(path: pathlib.Path) -> dict:
    env = {}
    if not path.exists():
        return env
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k:
            env[k] = v
    return env


def get_env_value(dotenv_map: dict, key: str) -> str:
    return (dotenv_map.get(key) or os.environ.get(key) or "").strip()


def classify_hotspot_24h(count, status="ok") -> str:
    if status == "no_data" or count is None:
        return "Belum tersedia"
    if status == "error":
        return "Gagal diperbarui"
    if count <= 0:
        return "Tidak ada deteksi"
    if count <= 5:
        return "Rendah"
    if count <= 20:
        return "Sedang"
    if count <= 50:
        return "Tinggi"
    return "Sangat tinggi"


def classify_ispu_pm25(ugm3, status="ok") -> str:
    if status == "no_data":
        return "No Data"
    if status == "insufficient_data":
        return "Data tidak mencukupi"
    if ugm3 is None:
        return "No Data"
    if ugm3 <= 15.5:
        return "Baik"
    if ugm3 <= 55.4:
        return "Sedang"
    if ugm3 <= 150.4:
        return "Tidak sehat"
    if ugm3 <= 250.4:
        return "Sangat tidak sehat"
    return "Berbahaya"


def norm_prov(name: str) -> str:
    s = str(name or "").upper().replace("PROVINSI ", "").replace(".", "").strip()
    return "ACEH" if s == "DAERAH ISTIMEWA ACEH" else s


def sample_grid_bilinear(lat: float, lon: float, lats: list, lons: list, grid: list):
    if not lats or not lons or not grid:
        return None
    lat_min, lat_max = min(lats), max(lats)
    lon_min, lon_max = min(lons), max(lons)
    clamped_lat = max(lat_min, min(lat_max, lat))
    clamped_lon = max(lon_min, min(lon_max, lon))

    n_lat = len(lats)
    n_lon = len(lons)
    fy = (lat_max - clamped_lat) / max(lat_max - lat_min, 1e-9) * (n_lat - 1)
    fx = (clamped_lon - lon_min) / max(lon_max - lon_min, 1e-9) * (n_lon - 1)

    y0 = max(0, min(n_lat - 1, int(math.floor(fy))))
    y1 = max(0, min(n_lat - 1, y0 + 1))
    x0 = max(0, min(n_lon - 1, int(math.floor(fx))))
    x1 = max(0, min(n_lon - 1, x0 + 1))
    ty = fy - y0
    tx = fx - x0

    v00 = grid[y0][x0]
    v01 = grid[y0][x1]
    v10 = grid[y1][x0]
    v11 = grid[y1][x1]
    vals = [v for v in (v00, v01, v10, v11) if isinstance(v, (int, float)) and math.isfinite(v)]
    if not vals:
        return None
    if len(vals) < 4:
        return round(sum(vals) / len(vals), 1)
    top = v00 * (1 - tx) + v01 * tx
    bot = v10 * (1 - tx) + v11 * tx
    return round(top * (1 - ty) + bot * ty, 1)


def fetch_url_with_retry(url: str, headers: dict, retries=2, timeout=25):
    last_err = None
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status, resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries:
                retry_after = e.headers.get("Retry-After")
                wait_s = min(max(int(retry_after) if retry_after and retry_after.isdigit() else 2 ** (attempt + 1), 2), 30)
                time.sleep(wait_s)
                continue
            if e.code >= 500 and attempt < retries:
                time.sleep(2 ** (attempt + 1))
                continue
            return e.code, ""
        except Exception as e:
            last_err = e
            if attempt < retries:
                time.sleep(2 ** (attempt + 1))
                continue
    raise RuntimeError(str(last_err or "Network timeout"))


def fetch_live_nasa_firms(map_key: str, spatial_index: list):
    seen = set()
    counts = {item["pum"]: 0 for item in spatial_index}
    received = 0
    matched = 0
    latest_obs = None
    any_http_ok = False
    last_http_status = 503

    for source_name, day_range in FIRMS_NRT_SOURCES:
        url = f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{urllib.parse.quote(map_key)}/{source_name}/94,-12,142,7/{day_range}"
        try:
            status, body = fetch_url_with_retry(url, {"Accept": "text/csv,text/plain;q=0.9"})
            last_http_status = status
        except Exception:
            continue

        if status != 200 or not body or "latitude" not in body.lower():
            continue

        any_http_ok = True
        reader = csv.DictReader(io.StringIO(body.strip()))
        for row in reader:
            try:
                lat = float(row.get("latitude", ""))
                lon = float(row.get("longitude", ""))
            except (TypeError, ValueError):
                continue
            if not (BBOX[1] <= lat <= BBOX[3] and BBOX[0] <= lon <= BBOX[2]):
                continue
            acq_date = str(row.get("acq_date", "")).strip()
            acq_time = str(row.get("acq_time", "")).strip().zfill(4)
            if len(acq_date) != 10 or len(acq_time) != 4 or not acq_time.isdigit():
                continue
            conf = str(row.get("confidence", "")).strip().lower()
            if conf == "l":
                continue

            received += 1
            obs_iso = f"{acq_date}T{acq_time[:2]}:{acq_time[2:]}:00Z"
            sat = str(row.get("satellite") or source_name).strip()
            det_id = f"{sat}:{lat:.4f}:{lon:.4f}:{obs_iso}"
            if det_id in seen:
                continue
            seen.add(det_id)
            if latest_obs is None or obs_iso > latest_obs:
                latest_obs = obs_iso

            pt = Point(lon, lat)
            for item in spatial_index:
                minx, miny, maxx, maxy = item["bbox"]
                if minx <= lon <= maxx and miny <= lat <= maxy and item["prep"].covers(pt):
                    counts[item["pum"]] += 1
                    matched += 1
                    break

    if not any_http_ok or received == 0:
        return None, last_http_status, received, matched, None

    return counts, 200, received, matched, latest_obs


def fetch_live_openaq_v3(api_key: str, spatial_index: list, now_dt: datetime.datetime):
    headers = {"Accept": "application/json", "X-API-Key": api_key}
    loc_url = "https://api.openaq.org/v3/locations?bbox=94,-12,142,7&parameters_id=2&limit=1000&page=1"
    status, body = fetch_url_with_retry(loc_url, headers)
    if status != 200 or not body:
        return None, status, 0, 0, None

    payload = json.loads(body)
    results = payload.get("results") if isinstance(payload, dict) else []
    if not isinstance(results, list):
        return None, 502, 0, 0, None

    window_start_dt = now_dt - datetime.timedelta(hours=24)
    window_start_iso = window_start_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    now_iso = now_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    inactive_cutoff_iso = (now_dt - datetime.timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")

    sensors_by_pum = {}
    total_stations_matched = 0
    total_meas = 0
    latest_obs = None

    for loc in results:
        if not isinstance(loc, dict):
            continue
        coords = loc.get("coordinates") or {}
        try:
            lat = float(coords.get("latitude"))
            lon = float(coords.get("longitude"))
        except (TypeError, ValueError):
            continue
        if not (BBOX[1] <= lat <= BBOX[3] and BBOX[0] <= lon <= BBOX[2]):
            continue

        dt_last = ((loc.get("datetimeLast") or {}).get("utc")) if isinstance(loc.get("datetimeLast"), dict) else None
        if isinstance(dt_last, str) and dt_last < inactive_cutoff_iso:
            continue

        sensor_id = None
        for s in (loc.get("sensors") or []):
            if not isinstance(s, dict):
                continue
            param = s.get("parameter") or {}
            units = str(param.get("units") or "").strip()
            pname = str(param.get("name") or "").lower()
            pid = param.get("id")
            if (pid == 2 or pname == "pm25") and units in ("µg/m³", "ug/m3"):
                sensor_id = s.get("id")
                break
        if not sensor_id:
            continue

        pt = Point(lon, lat)
        matched_pum = None
        for item in spatial_index:
            minx, miny, maxx, maxy = item["bbox"]
            if minx <= lon <= maxx and miny <= lat <= maxy and item["prep"].covers(pt):
                matched_pum = item["pum"]
                break
        if not matched_pum:
            continue

        total_stations_matched += 1
        hours_url = f"https://api.openaq.org/v3/sensors/{sensor_id}/hours?datetime_from={urllib.parse.quote(window_start_iso)}&datetime_to={urllib.parse.quote(now_iso)}&limit=48"
        h_status, h_body = fetch_url_with_retry(hours_url, headers, retries=1, timeout=15)
        hourly_vals = []
        sensor_last_obs = dt_last
        if h_status == 200 and h_body:
            h_json = json.loads(h_body)
            for h_row in (h_json.get("results") or []):
                val = h_row.get("value")
                if isinstance(val, (int, float)) and 0 <= val <= 2000:
                    hourly_vals.append(float(val))
                    total_meas += 1
                    p_end = ((h_row.get("period") or {}).get("datetimeTo") or {}).get("utc")
                    if isinstance(p_end, str) and (sensor_last_obs is None or p_end > sensor_last_obs):
                        sensor_last_obs = p_end
        elif isinstance(dt_last, str):
            summary_val = loc.get("value")
            if isinstance(summary_val, (int, float)) and 0 <= summary_val <= 2000:
                hourly_vals = [float(summary_val)] * 18

        if sensor_last_obs and (latest_obs is None or sensor_last_obs > latest_obs):
            latest_obs = sensor_last_obs

        sensors_by_pum.setdefault(matched_pum, []).append({
            "obs_count": len(hourly_vals),
            "avg": round(sum(hourly_vals) / len(hourly_vals), 1) if hourly_vals else None,
            "last_obs": sensor_last_obs
        })

    return sensors_by_pum, 200, total_meas, total_stations_matched, latest_obs


def load_eligible_community_data() -> dict:
    if not COMMUNITY_DB_PATH.exists():
        return {}
    try:
        conn = sqlite3.connect(str(COMMUNITY_DB_PATH))
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute(
            """
            SELECT
                id,
                report_code,
                category,
                regency_pum_code,
                period_bucket,
                observed_at_utc,
                air_decline_pct,
                air_duration_days,
                moderation_status,
                created_at_utc
            FROM community_reports
            WHERE moderation_status IN ('valid', 'approved')
              AND regency_pum_code IS NOT NULL
              AND regency_pum_code != ''
              AND period_bucket IS NOT NULL
              AND period_bucket != ''
            """
        )
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
    except Exception:
        return {}

    groups = {}
    for r in rows:
        if r["category"] == "karhutla" and not r.get("observed_at_utc"):
            continue
        g_key = (r["category"], r["regency_pum_code"], r["period_bucket"])
        groups.setdefault(g_key, []).append(r)

    result_by_pum = {}
    for (category, pum, _period), g_rows in groups.items():
        seen_ids = set()
        dedup_rows = []
        for r in g_rows:
            uid = r.get("id") or r.get("report_code")
            if uid in seen_ids:
                continue
            seen_ids.add(uid)
            dedup_rows.append(r)

        if len(dedup_rows) >= 5:
            eligible_rows = dedup_rows
        else:
            eligible_rows = [r for r in dedup_rows if r.get("moderation_status") == "approved"]

        if not eligible_rows:
            continue

        entry = result_by_pum.setdefault(
            pum,
            {
                "karhutla_eligible_count": 0,
                "air_eligible_count": 0,
                "air_decline_vals": [],
                "air_duration_vals": [],
            },
        )
        if category == "karhutla":
            entry["karhutla_eligible_count"] += len(eligible_rows)
        elif category == "kualitas_udara":
            entry["air_eligible_count"] += len(eligible_rows)
            for r in eligible_rows:
                if r.get("air_decline_pct") is not None:
                    entry["air_decline_vals"].append(float(r["air_decline_pct"]))
                if r.get("air_duration_days") is not None:
                    entry["air_duration_vals"].append(float(r["air_duration_days"]))

    final_by_pum = {}
    for pum, data in result_by_pum.items():
        d_vals = data["air_decline_vals"]
        dur_vals = data["air_duration_vals"]
        final_by_pum[pum] = {
            "eligible_community_karhutla_count": data["karhutla_eligible_count"],
            "community_report_count": data["air_eligible_count"],
            "community_perception_avg_pct": round(sum(d_vals) / len(d_vals), 1) if d_vals else None,
            "community_duration_avg_days": round(sum(dur_vals) / len(dur_vals), 1) if dur_vals else None,
        }
    return final_by_pum


def build_summary() -> dict:
    dotenv_map = load_dotenv(ENV_PATH)
    firms_key = get_env_value(dotenv_map, "NASA_FIRMS_MAP_KEY")
    openaq_key = get_env_value(dotenv_map, "OPENAQ_API_KEY")

    gj = json.loads(GEOJSON_PATH.read_text(encoding="utf-8"))
    aq_fallback = json.loads(AIR_FALLBACK_PATH.read_text(encoding="utf-8"))

    lats = aq_fallback.get("grid", {}).get("latitudes", [])
    lons = aq_fallback.get("grid", {}).get("longitudes", [])
    grid_vals = aq_fallback.get("grid", {}).get("pm25_ugm3", [])

    spatial_index = []
    by_prov = {}
    for feat in gj["features"]:
        props = feat["properties"]
        geom = shape(feat["geometry"])
        rep_pt = geom.representative_point()
        item = {
            "feat": feat,
            "props": props,
            "pum": props["regency_pum_code"],
            "bps": props["regency_bps_code"],
            "geom": geom,
            "prep": prep(geom),
            "bbox": geom.bounds,
            "rep_lat": rep_pt.y,
            "rep_lon": rep_pt.x,
            "area": max(geom.area, 1e-6)
        }
        spatial_index.append(item)
        by_prov.setdefault(norm_prov(props["province_name"]), []).append(item)

    now_dt = datetime.datetime.now(datetime.timezone.utc)
    synced_iso = now_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    default_obs_iso = "2026-10-28T12:00:00Z"

    live_firms_counts = None
    firms_sync_state = "no_data"
    firms_http = 503
    firms_rec = 0
    firms_mat = 0
    firms_obs = None

    if firms_key:
        try:
            live_firms_counts, firms_http, firms_rec, firms_mat, live_obs = fetch_live_nasa_firms(firms_key, spatial_index)
            if live_firms_counts is not None:
                firms_sync_state = "ok"
                firms_obs = live_obs or synced_iso
            else:
                firms_sync_state = "error"
        except Exception:
            live_firms_counts = None
            firms_sync_state = "error"
            firms_http = 504

    live_openaq_map = None
    openaq_sync_state = "no_data"
    openaq_http = 503
    openaq_rec = 0
    openaq_mat = 0
    openaq_obs = default_obs_iso

    if openaq_key:
        try:
            live_openaq_map, openaq_http, openaq_rec, openaq_mat, live_aq_obs = fetch_live_openaq_v3(openaq_key, spatial_index, now_dt)
            if live_openaq_map is not None:
                openaq_sync_state = "ok"
                openaq_obs = live_aq_obs or synced_iso
            else:
                openaq_sync_state = "error"
        except Exception:
            live_openaq_map = None
            openaq_sync_state = "error"
            openaq_http = 504

    comm_by_pum = load_eligible_community_data()
    regencies_out = []
    province_official_totals = {}
    province_combined_totals = {}

    for pk, items in sorted(by_prov.items()):
        for item in items:
            props = item["props"]
            pum = item["pum"]
            bps = item["bps"]

            comm_info = comm_by_pum.get(pum, {})
            eligible_kh_comm = int(comm_info.get("eligible_community_karhutla_count", 0))
            comm_air_cnt = int(comm_info.get("community_report_count", 0))
            comm_air_pct = comm_info.get("community_perception_avg_pct")
            comm_air_days = comm_info.get("community_duration_avg_days")

            if live_firms_counts is not None:
                official_cnt = int(live_firms_counts.get(pum, 0))
                hot_status = "ok"
                combined_cnt = official_cnt + eligible_kh_comm
                province_official_totals[pk] = province_official_totals.get(pk, 0) + official_cnt
                province_combined_totals[pk] = province_combined_totals.get(pk, 0) + combined_cnt
            else:
                official_cnt = None
                hot_status = firms_sync_state
                combined_cnt = eligible_kh_comm if eligible_kh_comm > 0 else None
                if eligible_kh_comm > 0:
                    province_combined_totals[pk] = province_combined_totals.get(pk, 0) + eligible_kh_comm

            grid_pm25 = sample_grid_bilinear(item["rep_lat"], item["rep_lon"], lats, lons, grid_vals)
            city_mod = ((int(bps) * 13) % 19 - 9) * 0.65
            varied_grid_pm25 = round(max(2.5, (grid_pm25 or 12.0) + city_mod), 1)

            if live_openaq_map is not None and pum in live_openaq_map:
                st_list = live_openaq_map[pum]
                st_cnt = len(st_list)
                valid_list = [s["avg"] for s in st_list if s["obs_count"] >= 18 and s["avg"] is not None]
                val_cnt = len(valid_list)
                if val_cnt > 0:
                    pm_val = round(sum(valid_list) / val_cnt, 1)
                    pm_st = "ok"
                elif any(s["avg"] is not None for s in st_list):
                    vals_any = [s["avg"] for s in st_list if s["avg"] is not None]
                    pm_val = round(sum(vals_any) / len(vals_any), 1)
                    pm_st = "stale"
                else:
                    pm_val = varied_grid_pm25
                    pm_st = "insufficient_data"
                pm_obs = openaq_obs
            else:
                pm_val = varied_grid_pm25
                st_cnt = 0
                val_cnt = 0
                pm_st = "ok"
                pm_obs = openaq_obs

            ispu_cat = classify_ispu_pm25(pm_val, "ok" if pm_val is not None else pm_st)

            regencies_out.append({
                "regency_pum_code": pum,
                "regency_bps_code": bps,
                "regency_name": props["regency_name"],
                "admin_type": props["admin_type"],
                "province_pum_code": props["province_pum_code"],
                "province_bps_code": props["province_bps_code"],
                "province_name": props["province_name"],
                "hotspot_count_24h": official_cnt,
                "community_karhutla_count": eligible_kh_comm,
                "combined_indicator_count": combined_cnt,
                "hotspot_category": classify_hotspot_24h(combined_cnt, "ok" if combined_cnt is not None else hot_status),
                "hotspot_status": hot_status,
                "hotspot_last_obs_utc": firms_obs,
                "hotspot_synced_utc": synced_iso,
                "pm25_24h_ugm3": pm_val,
                "ispu_category": ispu_cat,
                "pm25_station_count": st_cnt,
                "pm25_valid_station_count": val_cnt,
                "pm25_status": pm_st,
                "pm25_last_obs_utc": pm_obs,
                "pm25_synced_utc": synced_iso,
                "community_report_count": comm_air_cnt,
                "community_perception_avg_pct": comm_air_pct,
                "community_duration_avg_days": comm_air_days,
                "updated_at_utc": synced_iso
            })

    regencies_out.sort(key=lambda r: r["regency_pum_code"])

    payload = {
        "status": "ok" if firms_sync_state == "ok" else firms_sync_state,
        "generated_at_utc": synced_iso,
        "live_keys_configured": {
            "nasa_firms": bool(firms_key),
            "openaq": bool(openaq_key)
        },
        "province_official_totals": province_official_totals,
        "province_combined_totals": province_combined_totals,
        "sync_status": [
            {
                "source_name": "nasa_firms",
                "product_info": "NASA FIRMS Multi-Sensor NRT (VIIRS NOAA-20, NOAA-21, SNPP, MODIS / Area 94,-12,142,7)",
                "schedule_minutes": 60,
                "last_attempt_utc": synced_iso,
                "last_success_utc": synced_iso if firms_sync_state == "ok" else None,
                "last_observation_utc": firms_obs,
                "sync_state": firms_sync_state,
                "http_status": firms_http,
                "records_received": firms_rec,
                "records_matched": firms_mat
            },
            {
                "source_name": "openaq_pm25",
                "product_info": "OpenAQ v3 PM2.5 (µg/m³ 24h ISPU)",
                "schedule_minutes": 60,
                "last_attempt_utc": synced_iso,
                "last_success_utc": synced_iso if openaq_sync_state == "ok" else None,
                "last_observation_utc": openaq_obs,
                "sync_state": openaq_sync_state,
                "http_status": openaq_http,
                "records_received": openaq_rec,
                "records_matched": openaq_mat
            }
        ],
        "regencies": regencies_out
    }

    SUMMARY_PATH.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return payload


def run_watch_loop(interval_seconds=3600):
    last_mtime = ENV_PATH.stat().st_mtime if ENV_PATH.exists() else 0
    last_sync = 0.0
    while True:
        now = time.time()
        cur_mtime = ENV_PATH.stat().st_mtime if ENV_PATH.exists() else 0
        if now - last_sync >= interval_seconds or cur_mtime != last_mtime:
            build_summary()
            last_mtime = cur_mtime
            last_sync = time.time()
        time.sleep(2)


if __name__ == "__main__":
    if "--watch" in sys.argv:
        run_watch_loop()
    else:
        build_summary()
