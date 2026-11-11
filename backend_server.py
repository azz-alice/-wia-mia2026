import base64
import datetime
import hashlib
import hmac
import http.server
import json
import os
import secrets
import sqlite3
import sys
import urllib.parse
import uuid

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(ROOT_DIR, "karhutla", "data", "community_reports.sqlite")
PUBLIC_SNAPSHOT_PATH = os.path.join(ROOT_DIR, "laporan", "data", "community-reports-public.json")
SUPPLEMENTARY_SNAPSHOT_PATH = os.path.join(ROOT_DIR, "karhutla", "data", "community-supplementary.json")
WILAYAH_JSON_PATH = os.path.join(ROOT_DIR, "laporan", "data", "wilayah-indonesia.json")
CITY_ENV_SUMMARY_PATH = os.path.join(ROOT_DIR, "karhutla", "data", "city-environment-summary.json")


def load_env_file():
    env_vars = {}
    env_path = os.path.join(ROOT_DIR, ".env")
    if os.path.exists(env_path):
        with open(env_path, "r", encoding="utf-8") as f:
            for raw_line in f:
                line = raw_line.strip()
                if not line or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                env_vars[k] = v
    for k, v in os.environ.items():
        if k not in env_vars or not env_vars[k]:
            env_vars[k] = v
    return env_vars


def get_db_connection():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_database():
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS community_report_groups (
            id TEXT PRIMARY KEY,
            group_key TEXT NOT NULL UNIQUE,
            category TEXT NOT NULL CHECK (category IN ('karhutla', 'kualitas_udara')),
            province_pum_code TEXT NOT NULL,
            province_name TEXT NOT NULL,
            regency_pum_code TEXT NOT NULL,
            regency_bps_code TEXT,
            regency_name TEXT NOT NULL,
            period_bucket TEXT NOT NULL,
            valid_report_count INTEGER NOT NULL DEFAULT 0,
            approved_report_count INTEGER NOT NULL DEFAULT 0,
            eligible_report_count INTEGER NOT NULL DEFAULT 0,
            priority_tier INTEGER NOT NULL DEFAULT 0,
            queue_status TEXT NOT NULL DEFAULT 'active_queue',
            avg_air_decline_pct REAL,
            avg_air_duration_days REAL,
            corroborated_with_firms INTEGER NOT NULL DEFAULT 0,
            threshold_reached_at_utc TEXT,
            threshold_notified_at_utc TEXT,
            created_at_utc TEXT NOT NULL,
            updated_at_utc TEXT NOT NULL,
            UNIQUE (category, regency_pum_code, period_bucket)
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS community_reports (
            id TEXT PRIMARY KEY,
            report_code TEXT NOT NULL UNIQUE,
            group_id TEXT REFERENCES community_report_groups(id) ON DELETE SET NULL,
            group_key TEXT NOT NULL,
            category TEXT NOT NULL CHECK (category IN ('karhutla', 'kualitas_udara')),
            reporter_name TEXT NOT NULL,
            province_pum_code TEXT NOT NULL,
            province_name TEXT NOT NULL,
            regency_pum_code TEXT NOT NULL,
            regency_bps_code TEXT,
            regency_name TEXT NOT NULL,
            period_bucket TEXT NOT NULL,
            observed_at_utc TEXT,
            description TEXT,
            air_decline_pct INTEGER,
            air_duration_days INTEGER,
            moderation_status TEXT NOT NULL DEFAULT 'valid' CHECK (moderation_status IN ('valid', 'approved', 'rejected')),
            moderated_by TEXT,
            moderated_at_utc TEXT,
            moderation_note TEXT,
            created_at_utc TEXT NOT NULL,
            updated_at_utc TEXT NOT NULL
        )
        """
    )
    cur.execute("PRAGMA table_info(community_report_groups)")
    existing_cols = {row["name"] for row in cur.fetchall()}
    if "approved_report_count" not in existing_cols:
        cur.execute("ALTER TABLE community_report_groups ADD COLUMN approved_report_count INTEGER NOT NULL DEFAULT 0")
    if "eligible_report_count" not in existing_cols:
        cur.execute("ALTER TABLE community_report_groups ADD COLUMN eligible_report_count INTEGER NOT NULL DEFAULT 0")
    conn.commit()
    conn.close()


def generate_unique_report_code(conn, category, created_dt):
    prefix = "LAP-KH" if category == "karhutla" else "LAP-KU"
    date_part = created_dt.strftime("%Y%m%d")
    alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
    cur = conn.cursor()
    while True:
        suffix = "".join(secrets.choice(alphabet) for _ in range(6))
        candidate = f"{prefix}-{date_part}-{suffix}"
        cur.execute("SELECT 1 FROM community_reports WHERE report_code = ?", (candidate,))
        if cur.fetchone() is None:
            return candidate


def check_firms_corroboration(regency_pum_code):
    if not os.path.exists(CITY_ENV_SUMMARY_PATH):
        return 0
    try:
        with open(CITY_ENV_SUMMARY_PATH, "r", encoding="utf-8") as f:
            summary = json.load(f)
        regencies = summary.get("regencies", [])
        for entry in regencies:
            if entry.get("regency_pum_code") == regency_pum_code:
                cnt = entry.get("hotspot_count_24h")
                if cnt is not None and int(cnt) > 0:
                    return 1
                break
    except Exception:
        return 0
    return 0


def recalculate_group(conn, category, province_pum_code, province_name, regency_pum_code, regency_bps_code, regency_name, period_bucket):
    group_key = f"{category}:{regency_pum_code}:{period_bucket}"
    cur = conn.cursor()
    cur.execute(
        """
        SELECT COUNT(*) AS cnt,
               SUM(CASE WHEN moderation_status = 'approved' THEN 1 ELSE 0 END) AS approved_cnt,
               AVG(air_decline_pct) AS avg_decline,
               AVG(air_duration_days) AS avg_duration,
               MIN(created_at_utc) AS first_created
        FROM community_reports
        WHERE category = ?
          AND regency_pum_code = ?
          AND period_bucket = ?
          AND moderation_status IN ('valid', 'approved')
        """,
        (category, regency_pum_code, period_bucket),
    )
    row = cur.fetchone()
    valid_count = int(row["cnt"] or 0)
    approved_count = int(row["approved_cnt"] or 0)
    eligible_count = valid_count if valid_count >= 5 else approved_count
    avg_decline = round(float(row["avg_decline"]), 1) if (category == "kualitas_udara" and row["avg_decline"] is not None and valid_count > 0) else None
    avg_duration = round(float(row["avg_duration"]), 1) if (category == "kualitas_udara" and row["avg_duration"] is not None and valid_count > 0) else None
    first_created = row["first_created"]

    if valid_count >= 5:
        priority_tier = 4
        queue_status = "promoted_supplementary"
    elif valid_count >= 3:
        priority_tier = 3
        queue_status = "active_queue"
    elif valid_count == 2:
        priority_tier = 2
        queue_status = "active_queue"
    elif valid_count == 1:
        priority_tier = 1
        queue_status = "active_queue"
    else:
        priority_tier = 0
        queue_status = "active_queue"

    now_iso = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    corroborated = check_firms_corroboration(regency_pum_code) if category == "karhutla" else 0

    cur.execute(
        """
        SELECT id, threshold_reached_at_utc, threshold_notified_at_utc, created_at_utc
        FROM community_report_groups
        WHERE category = ? AND regency_pum_code = ? AND period_bucket = ?
        """,
        (category, regency_pum_code, period_bucket),
    )
    existing = cur.fetchone()

    if existing is None:
        group_id = str(uuid.uuid4())
        threshold_reached = now_iso if valid_count >= 5 else None
        threshold_notified = now_iso if valid_count >= 5 else None
        created_val = first_created or now_iso
        cur.execute(
            """
            INSERT INTO community_report_groups (
                id, group_key, category, province_pum_code, province_name,
                regency_pum_code, regency_bps_code, regency_name,
                period_bucket, valid_report_count, approved_report_count,
                eligible_report_count, priority_tier,
                queue_status, avg_air_decline_pct, avg_air_duration_days,
                corroborated_with_firms, threshold_reached_at_utc,
                threshold_notified_at_utc, created_at_utc, updated_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                group_id,
                group_key,
                category,
                province_pum_code,
                province_name,
                regency_pum_code,
                regency_bps_code,
                regency_name,
                period_bucket,
                valid_count,
                approved_count,
                eligible_count,
                priority_tier,
                queue_status,
                avg_decline,
                avg_duration,
                corroborated,
                threshold_reached,
                threshold_notified,
                created_val,
                now_iso,
            ),
        )
    else:
        group_id = existing["id"]
        threshold_reached = existing["threshold_reached_at_utc"]
        threshold_notified = existing["threshold_notified_at_utc"]
        if valid_count >= 5:
            if not threshold_reached:
                threshold_reached = now_iso
            if not threshold_notified:
                threshold_notified = now_iso
        else:
            threshold_reached = None
        cur.execute(
            """
            UPDATE community_report_groups
            SET group_key = ?,
                province_pum_code = ?,
                province_name = ?,
                regency_bps_code = COALESCE(?, regency_bps_code),
                regency_name = ?,
                valid_report_count = ?,
                approved_report_count = ?,
                eligible_report_count = ?,
                priority_tier = ?,
                queue_status = ?,
                avg_air_decline_pct = ?,
                avg_air_duration_days = ?,
                corroborated_with_firms = ?,
                threshold_reached_at_utc = ?,
                threshold_notified_at_utc = ?,
                updated_at_utc = ?
            WHERE id = ?
            """,
            (
                group_key,
                province_pum_code,
                province_name,
                regency_bps_code,
                regency_name,
                valid_count,
                approved_count,
                eligible_count,
                priority_tier,
                queue_status,
                avg_decline,
                avg_duration,
                corroborated,
                threshold_reached,
                threshold_notified,
                now_iso,
                group_id,
            ),
        )

    cur.execute(
        """
        UPDATE community_reports
        SET group_id = ?, group_key = ?
        WHERE category = ? AND regency_pum_code = ? AND period_bucket = ?
        """,
        (group_id, group_key, category, regency_pum_code, period_bucket),
    )
    return group_id


def sync_public_snapshots(conn):
    cur = conn.cursor()
    cur.execute(
        """
        SELECT
            r.id,
            r.report_code,
            r.reporter_name,
            r.group_id,
            r.group_key,
            r.category,
            r.province_pum_code,
            r.province_name,
            r.regency_pum_code,
            r.regency_bps_code,
            r.regency_name,
            r.period_bucket,
            r.observed_at_utc,
            r.description,
            r.air_decline_pct,
            r.air_duration_days,
            r.moderation_status,
            r.created_at_utc,
            COALESCE(g.valid_report_count, 1) AS group_valid_count,
            COALESCE(g.approved_report_count, 0) AS group_approved_count,
            COALESCE(g.eligible_report_count, 0) AS group_eligible_count,
            COALESCE(g.priority_tier, 1) AS group_priority_tier,
            COALESCE(g.queue_status, 'active_queue') AS group_queue_status,
            g.avg_air_decline_pct AS group_avg_air_decline_pct,
            g.avg_air_duration_days AS group_avg_air_duration_days,
            COALESCE(g.corroborated_with_firms, 0) AS corroborated_with_firms,
            g.threshold_reached_at_utc,
            g.threshold_notified_at_utc
        FROM community_reports r
        LEFT JOIN community_report_groups g ON g.id = r.group_id
        WHERE r.moderation_status IN ('valid', 'approved')
        ORDER BY
            CASE WHEN COALESCE(g.queue_status, 'active_queue') = 'active_queue' THEN 0 ELSE 1 END ASC,
            COALESCE(g.priority_tier, 1) DESC,
            COALESCE(g.valid_report_count, 1) DESC,
            r.created_at_utc DESC
        """
    )
    reports = []
    for row in cur.fetchall():
        d = dict(row)
        d["corroborated_with_firms"] = bool(d["corroborated_with_firms"])
        if d["category"] == "karhutla":
            d["public_summary"] = d.get("description") or "Pengamatan indikasi karhutla wilayah."
        else:
            d["public_summary"] = f"Persepsi penurunan kualitas udara sebesar {d.get('air_decline_pct')}% selama {d.get('air_duration_days')} hari."
        reports.append(d)

    cur.execute(
        """
        SELECT
            id,
            group_key,
            category,
            province_pum_code,
            province_name,
            regency_pum_code,
            regency_bps_code,
            regency_name,
            period_bucket,
            valid_report_count,
            COALESCE(approved_report_count, 0) AS approved_report_count,
            COALESCE(eligible_report_count, CASE WHEN valid_report_count >= 5 THEN valid_report_count ELSE COALESCE(approved_report_count, 0) END) AS eligible_report_count,
            priority_tier,
            queue_status,
            avg_air_decline_pct,
            avg_air_duration_days,
            corroborated_with_firms,
            threshold_reached_at_utc,
            threshold_notified_at_utc,
            created_at_utc,
            updated_at_utc
        FROM community_report_groups
        WHERE valid_report_count > 0
        ORDER BY priority_tier DESC, valid_report_count DESC, created_at_utc ASC
        """
    )
    groups = []
    for row in cur.fetchall():
        g = dict(row)
        g["corroborated_with_firms"] = bool(g["corroborated_with_firms"])
        g["first_report_at_utc"] = g["created_at_utc"]
        g["firms_match_status"] = "corroborated_with_firms" if g["corroborated_with_firms"] else "unconfirmed_community_observation"
        groups.append(g)

    now_iso = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    public_payload = {
        "ok": True,
        "status": "ok",
        "updated_at_utc": now_iso,
        "reports": reports,
        "groups": groups,
    }
    os.makedirs(os.path.dirname(PUBLIC_SNAPSHOT_PATH), exist_ok=True)
    with open(PUBLIC_SNAPSHOT_PATH, "w", encoding="utf-8") as f:
        json.dump(public_payload, f, ensure_ascii=False, indent=2)

    supplementary_by_regency = {}
    promoted_groups = []
    for g in groups:
        v_cnt = int(g.get("valid_report_count") or 0)
        app_cnt = int(g.get("approved_report_count") or 0)
        elig_cnt = int(g.get("eligible_report_count") if g.get("eligible_report_count") is not None else (v_cnt if v_cnt >= 5 else app_cnt))
        g["approved_report_count"] = app_cnt
        g["eligible_report_count"] = elig_cnt

        if v_cnt >= 5 or g.get("queue_status") == "promoted_supplementary":
            promoted_groups.append(g)

        reg_code = g["regency_pum_code"]
        if g["category"] == "karhutla" and (elig_cnt > 0 or v_cnt > 0):
            if reg_code not in supplementary_by_regency:
                supplementary_by_regency[reg_code] = {
                    "regency_pum_code": reg_code,
                    "regency_bps_code": g.get("regency_bps_code"),
                    "regency_name": g.get("regency_name"),
                    "province_pum_code": g.get("province_pum_code"),
                    "province_name": g.get("province_name"),
                    "karhutla": None,
                    "kualitas_udara": None,
                }
            prev_kh = supplementary_by_regency[reg_code]["karhutla"]
            if prev_kh is None:
                unver_cnt = max(0, v_cnt - elig_cnt)
                supplementary_by_regency[reg_code]["karhutla"] = {
                    "group_id": g["id"],
                    "group_key": g["group_key"],
                    "eligible_report_count": elig_cnt,
                    "valid_report_count": v_cnt,
                    "approved_report_count": app_cnt,
                    "unverified_valid_count": unver_cnt,
                    "period_bucket": g["period_bucket"],
                    "corroborated_with_firms": bool(g["corroborated_with_firms"]),
                    "firms_match_status": g["firms_match_status"],
                    "threshold_reached_at_utc": g["threshold_reached_at_utc"],
                    "threshold_notified_at_utc": g["threshold_notified_at_utc"],
                }
            else:
                prev_kh["eligible_report_count"] = int(prev_kh["eligible_report_count"]) + elig_cnt
                prev_kh["valid_report_count"] = int(prev_kh["valid_report_count"]) + v_cnt
                prev_kh["approved_report_count"] = int(prev_kh["approved_report_count"]) + app_cnt
                prev_kh["unverified_valid_count"] = max(0, int(prev_kh["valid_report_count"]) - int(prev_kh["eligible_report_count"]))
                if g["corroborated_with_firms"]:
                    prev_kh["corroborated_with_firms"] = True
                    prev_kh["firms_match_status"] = "corroborated_with_firms"
        elif g["category"] == "kualitas_udara" and (v_cnt >= 5 or g.get("queue_status") == "promoted_supplementary" or elig_cnt > 0):
            if reg_code not in supplementary_by_regency:
                supplementary_by_regency[reg_code] = {
                    "regency_pum_code": reg_code,
                    "regency_bps_code": g.get("regency_bps_code"),
                    "regency_name": g.get("regency_name"),
                    "province_pum_code": g.get("province_pum_code"),
                    "province_name": g.get("province_name"),
                    "karhutla": None,
                    "kualitas_udara": None,
                }
            supplementary_by_regency[reg_code]["kualitas_udara"] = {
                "group_id": g["id"],
                "group_key": g["group_key"],
                "eligible_report_count": elig_cnt,
                "valid_report_count": v_cnt,
                "approved_report_count": app_cnt,
                "period_bucket": g["period_bucket"],
                "avg_air_decline_pct": g["avg_air_decline_pct"],
                "avg_air_duration_days": g["avg_air_duration_days"],
                "threshold_reached_at_utc": g["threshold_reached_at_utc"],
                "threshold_notified_at_utc": g["threshold_notified_at_utc"],
            }

    supp_payload = {
        "ok": True,
        "status": "ok",
        "updated_at_utc": now_iso,
        "minimum_valid_reports_threshold": 5,
        "promoted_groups": promoted_groups,
        "regencies": supplementary_by_regency,
    }
    os.makedirs(os.path.dirname(SUPPLEMENTARY_SNAPSHOT_PATH), exist_ok=True)
    with open(SUPPLEMENTARY_SNAPSHOT_PATH, "w", encoding="utf-8") as f:
        json.dump(supp_payload, f, ensure_ascii=False, indent=2)

    if os.path.exists(CITY_ENV_SUMMARY_PATH):
        try:
            with open(CITY_ENV_SUMMARY_PATH, "r", encoding="utf-8") as f:
                city_summary = json.load(f)
            reg_entries = city_summary.get("regencies", [])
            total_comm_kh = 0
            total_combined = 0
            for entry in reg_entries:
                pum = entry.get("regency_pum_code")
                supp_reg = supplementary_by_regency.get(pum) or {}
                kh_info = supp_reg.get("karhutla") or {}
                ku_info = supp_reg.get("kualitas_udara") or {}

                comm_kh = int(kh_info.get("eligible_report_count") or 0)
                entry["community_karhutla_count"] = comm_kh
                off_cnt = entry.get("hotspot_count_24h")
                if off_cnt is not None:
                    comb_cnt = int(off_cnt) + comm_kh
                else:
                    comb_cnt = comm_kh if comm_kh > 0 else None
                entry["combined_indicator_count"] = comb_cnt
                total_comm_kh += comm_kh
                if comb_cnt is not None:
                    total_combined += int(comb_cnt)

                comm_air = int(ku_info.get("eligible_report_count") or ku_info.get("valid_report_count") or 0)
                entry["community_report_count"] = comm_air
                entry["community_perception_avg_pct"] = ku_info.get("avg_air_decline_pct") if comm_air > 0 else None
                entry["community_duration_avg_days"] = ku_info.get("avg_air_duration_days") if comm_air > 0 else None

            if isinstance(city_summary.get("sources"), dict) and isinstance(city_summary["sources"].get("nasa_firms"), dict):
                city_summary["sources"]["nasa_firms"]["community_eligible_karhutla_reports"] = total_comm_kh
                city_summary["sources"]["nasa_firms"]["combined_total_indicators"] = total_combined

            with open(CITY_ENV_SUMMARY_PATH, "w", encoding="utf-8") as f:
                json.dump(city_summary, f, ensure_ascii=False, separators=(",", ":"))
        except Exception:
            pass

    return public_payload


def submit_report(payload, created_override_utc=None):
    reporter_name = str(payload.get("reporter_name") or "").strip()
    province_pum_code = str(payload.get("province_pum_code") or "35").strip()
    province_name = str(payload.get("province_name") or "Jawa Timur").strip()
    regency_pum_code = str(payload.get("regency_pum_code") or "35.15").strip()
    regency_bps_code = str(payload.get("regency_bps_code") or "3515").strip()
    regency_name = str(payload.get("regency_name") or "Kabupaten Sidoarjo").strip()
    category = str(payload.get("category") or "").strip()

    if len(reporter_name) < 2 or len(reporter_name) > 120:
        raise ValueError("Nama pelapor harus diisi antara 2 hingga 120 karakter.")
    if not province_pum_code or not province_name or not regency_pum_code or not regency_name:
        raise ValueError("Provinsi dan Kabupaten/Kota wajib dipilih.")
    if category not in ("karhutla", "kualitas_udara"):
        raise ValueError("Jenis laporan tidak valid.")

    now_dt = datetime.datetime.now(datetime.timezone.utc)
    if created_override_utc:
        created_dt = datetime.datetime.fromisoformat(created_override_utc.replace("Z", "+00:00"))
    else:
        created_dt = now_dt
    created_iso = created_dt.strftime("%Y-%m-%dT%H:%M:%SZ")

    observed_iso = None
    description = None
    air_decline_pct = None
    air_duration_days = None

    if category == "karhutla":
        obs_raw = payload.get("observed_at_utc")
        if not obs_raw:
            raise ValueError("Waktu pengamatan wajib diisi untuk laporan Karhutla.")
        try:
            obs_dt = datetime.datetime.fromisoformat(str(obs_raw).replace("Z", "+00:00"))
            if obs_dt.tzinfo is None:
                obs_dt = obs_dt.replace(tzinfo=datetime.timezone.utc)
        except Exception:
            raise ValueError("Format waktu pengamatan tidak valid.")
        if obs_dt > now_dt + datetime.timedelta(minutes=5):
            raise ValueError("Waktu pengamatan tidak boleh berada di masa depan.")
        observed_iso = obs_dt.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        description = str(payload.get("description") or "").strip()
        if len(description) < 5 or len(description) > 2000:
            raise ValueError("Deskripsi laporan Karhutla wajib diisi minimal 5 karakter.")
        period_bucket = obs_dt.astimezone(datetime.timezone.utc).strftime("%Y-%m-%d")
    else:
        try:
            air_decline_pct = int(payload.get("air_decline_pct"))
        except Exception:
            raise ValueError("Persentase penurunan kualitas udara wajib dipilih.")
        if air_decline_pct < 0 or air_decline_pct > 100 or (air_decline_pct % 10) != 0:
            raise ValueError("Penurunan kualitas udara harus berada pada rentang 0% hingga 100% dengan kelipatan 10%.")
        try:
            air_duration_days = int(payload.get("air_duration_days"))
        except Exception:
            raise ValueError("Durasi hari penurunan kualitas udara wajib dipilih.")
        if air_duration_days < 1 or air_duration_days > 35:
            raise ValueError("Durasi penurunan kualitas udara harus berada pada rentang 1 hingga 35 hari.")
        iso_year, iso_week, _ = created_dt.isocalendar()
        period_bucket = f"{iso_year}-W{iso_week:02d}"

    group_key = f"{category}:{regency_pum_code}:{period_bucket}"
    conn = get_db_connection()
    try:
        report_id = str(uuid.uuid4())
        report_code = generate_unique_report_code(conn, category, created_dt)
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO community_reports (
                id, report_code, group_key, category, reporter_name,
                province_pum_code, province_name,
                regency_pum_code, regency_bps_code, regency_name,
                period_bucket, observed_at_utc, description,
                air_decline_pct, air_duration_days,
                moderation_status, created_at_utc, updated_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'valid', ?, ?)
            """,
            (
                report_id,
                report_code,
                group_key,
                category,
                reporter_name,
                province_pum_code,
                province_name,
                regency_pum_code,
                regency_bps_code,
                regency_name,
                period_bucket,
                observed_iso,
                description,
                air_decline_pct,
                air_duration_days,
                created_iso,
                created_iso,
            ),
        )
        group_id = recalculate_group(
            conn,
            category,
            province_pum_code,
            province_name,
            regency_pum_code,
            regency_bps_code,
            regency_name,
            period_bucket,
        )
        cur.execute("SELECT * FROM community_report_groups WHERE id = ?", (group_id,))
        grp = dict(cur.fetchone())
        conn.commit()
        sync_public_snapshots(conn)
        return {
            "ok": True,
            "status": "ok",
            "report_id": report_id,
            "report_code": report_code,
            "group_key": group_key,
            "category": category,
            "province_pum_code": province_pum_code,
            "province_name": province_name,
            "regency_pum_code": regency_pum_code,
            "regency_name": regency_name,
            "created_at_utc": created_iso,
            "group": {
                "group_id": grp["id"],
                "group_key": grp["group_key"],
                "valid_report_count": grp["valid_report_count"],
                "approved_report_count": grp.get("approved_report_count", 0),
                "eligible_report_count": grp.get("eligible_report_count", 0),
                "priority_tier": grp["priority_tier"],
                "queue_status": grp["queue_status"],
                "avg_air_decline_pct": grp["avg_air_decline_pct"],
                "avg_air_duration_days": grp["avg_air_duration_days"],
                "threshold_reached_at_utc": grp["threshold_reached_at_utc"],
            },
        }
    finally:
        conn.close()


def moderate_report(report_id, new_status, moderator_email, moderation_note=None):
    if new_status not in ("approved", "rejected", "valid"):
        raise ValueError("Status moderasi harus berupa approved, rejected, atau valid.")
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute("SELECT * FROM community_reports WHERE id = ?", (report_id,))
        row = cur.fetchone()
        if row is None:
            raise ValueError("Laporan tidak ditemukan.")
        report = dict(row)
        now_iso = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        cur.execute(
            """
            UPDATE community_reports
            SET moderation_status = ?,
                moderated_by = ?,
                moderated_at_utc = ?,
                moderation_note = ?,
                updated_at_utc = ?
            WHERE id = ?
            """,
            (new_status, moderator_email, now_iso, moderation_note, now_iso, report_id),
        )
        group_id = recalculate_group(
            conn,
            report["category"],
            report["province_pum_code"],
            report["province_name"],
            report["regency_pum_code"],
            report["regency_bps_code"],
            report["regency_name"],
            report["period_bucket"],
        )
        cur.execute("SELECT * FROM community_report_groups WHERE id = ?", (group_id,))
        grp = dict(cur.fetchone())
        conn.commit()
        sync_public_snapshots(conn)
        return {
            "ok": True,
            "status": "ok",
            "report_id": report_id,
            "report_code": report["report_code"],
            "category": report["category"],
            "regency_pum_code": report["regency_pum_code"],
            "regency_name": report["regency_name"],
            "moderation_status": new_status,
            "group": {
                "group_id": grp["id"],
                "group_key": grp["group_key"],
                "valid_report_count": grp["valid_report_count"],
                "approved_report_count": grp.get("approved_report_count", 0),
                "eligible_report_count": grp.get("eligible_report_count", 0),
                "priority_tier": grp["priority_tier"],
                "queue_status": grp["queue_status"],
                "avg_air_decline_pct": grp["avg_air_decline_pct"],
                "avg_air_duration_days": grp["avg_air_duration_days"],
            },
        }
    finally:
        conn.close()


def get_moderator_credentials():
    env = load_env_file()
    email = env.get("ADMIN_MODERATOR_EMAIL", "").strip()
    password = env.get("ADMIN_MODERATOR_PASSWORD", "").strip()
    secret = env.get("ADMIN_SESSION_SECRET", "").strip()
    missing = [
        key for key, value in (
            ("ADMIN_MODERATOR_EMAIL", email),
            ("ADMIN_MODERATOR_PASSWORD", password),
            ("ADMIN_SESSION_SECRET", secret),
        ) if not value
    ]
    if missing:
        raise RuntimeError("Konfigurasi moderator lokal belum lengkap: " + ", ".join(missing))
    if len(secret) < 32:
        raise RuntimeError("ADMIN_SESSION_SECRET harus memiliki minimal 32 karakter.")
    return email, password, secret


def create_moderator_token(email):
    _, _, secret = get_moderator_credentials()
    exp = int((datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=12)).timestamp())
    payload_str = f"{email}|{exp}"
    sig = hmac.new(secret.encode("utf-8"), payload_str.encode("utf-8"), hashlib.sha256).hexdigest()
    raw = f"{payload_str}|{sig}"
    return base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii")


def verify_moderator_token(token):
    if not token:
        return None
    _, _, secret = get_moderator_credentials()
    try:
        decoded = base64.urlsafe_b64decode(token.encode("ascii")).decode("utf-8")
        email, exp_str, sig = decoded.split("|", 2)
        expected_sig = hmac.new(
            secret.encode("utf-8"),
            f"{email}|{exp_str}".encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(sig, expected_sig):
            return None
        if int(exp_str) < int(datetime.datetime.now(datetime.timezone.utc).timestamp()):
            return None
        return email
    except Exception:
        return None


def seed_realistic_initial_reports():
    init_database()
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) AS cnt FROM community_reports")
    existing_cnt = int(cur.fetchone()["cnt"] or 0)
    conn.close()
    if existing_cnt > 0:
        conn = get_db_connection()
        sync_public_snapshots(conn)
        conn.close()
        return

    now_utc = datetime.datetime.now(datetime.timezone.utc)
    t_minus = lambda hours: (now_utc - datetime.timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")

    seed_items = [
        {
            "reporter_name": "Warga Waru",
            "province_pum_code": "35",
            "province_name": "Jawa Timur",
            "regency_pum_code": "35.15",
            "regency_bps_code": "3515",
            "regency_name": "Kabupaten Sidoarjo",
            "category": "karhutla",
            "observed_at_utc": t_minus(6),
            "description": "Kepulan asap semak di lahan terbuka dekat pergudangan Waru.",
            "created_override": t_minus(5),
            "initial_status": "approved",
        },
        {
            "reporter_name": "Warga Sidoarjo 1",
            "province_pum_code": "35",
            "province_name": "Jawa Timur",
            "regency_pum_code": "35.15",
            "regency_bps_code": "3515",
            "regency_name": "Kabupaten Sidoarjo",
            "category": "karhutla",
            "observed_at_utc": t_minus(4),
            "description": "Terlihat sisa pembakaran sampah dan ilalang mengering di tepi jalan lingkar timur Sidoarjo.",
            "created_override": t_minus(3),
        },
        {
            "reporter_name": "Warga Krian",
            "province_pum_code": "35",
            "province_name": "Jawa Timur",
            "regency_pum_code": "35.15",
            "regency_bps_code": "3515",
            "regency_name": "Kabupaten Sidoarjo",
            "category": "karhutla",
            "observed_at_utc": t_minus(3),
            "description": "Asap tebal terpantau di lahan semak belukar arah Krian menjelang sore.",
            "created_override": t_minus(2),
        },
        {
            "reporter_name": "Warga Sedati",
            "province_pum_code": "35",
            "province_name": "Jawa Timur",
            "regency_pum_code": "35.15",
            "regency_bps_code": "3515",
            "regency_name": "Kabupaten Sidoarjo",
            "category": "kualitas_udara",
            "air_decline_pct": 40,
            "air_duration_days": 3,
            "created_override": t_minus(6),
        },
        {
            "reporter_name": "Warga Gedangan",
            "province_pum_code": "35",
            "province_name": "Jawa Timur",
            "regency_pum_code": "35.15",
            "regency_bps_code": "3515",
            "regency_name": "Kabupaten Sidoarjo",
            "category": "kualitas_udara",
            "air_decline_pct": 30,
            "air_duration_days": 2,
            "created_override": t_minus(4),
        },
        {
            "reporter_name": "Warga Porong",
            "province_pum_code": "35",
            "province_name": "Jawa Timur",
            "regency_pum_code": "35.15",
            "regency_bps_code": "3515",
            "regency_name": "Kabupaten Sidoarjo",
            "category": "kualitas_udara",
            "air_decline_pct": 50,
            "air_duration_days": 4,
            "created_override": t_minus(2),
        },
    ]

    for item in seed_items:
        override = item.pop("created_override", None)
        init_status = item.pop("initial_status", None)
        res = submit_report(item, created_override_utc=override)
        if init_status == "approved" and res.get("report_id"):
            moderate_report(res["report_id"], "approved", "moderator@wiamia2026.id", "Terverifikasi moderator")


class CommunityReportingHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT_DIR, **kwargs)

    def log_message(self, format, *args):
        return

    def send_json(self, status_code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, apikey")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_json(200, {"ok": True, "status": "ok"})

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        requested_parts = [part.lower() for part in urllib.parse.unquote(parsed.path).replace("\\", "/").split("/")]
        if any(part == ".git" or part == ".env" or part.startswith(".env.") or part == "__pycache__" for part in requested_parts):
            self.send_error(404, "File not found")
            return
        if parsed.path == "/api/community-reports":
            qs = urllib.parse.parse_qs(parsed.query)
            action = (qs.get("action") or ["list"])[0]
            conn = get_db_connection()
            try:
                if action == "admin_list":
                    auth_header = self.headers.get("Authorization", "")
                    token = auth_header[7:].strip() if auth_header.startswith("Bearer ") else ""
                    mod_email = verify_moderator_token(token)
                    if not mod_email:
                        self.send_json(401, {"error": "Sesi moderator tidak valid atau telah berakhir.", "message": "Sesi moderator tidak valid atau telah berakhir."})
                        return
                    cur = conn.cursor()
                    cur.execute("SELECT * FROM community_reports ORDER BY created_at_utc DESC")
                    reports = []
                    for row in cur.fetchall():
                        report = dict(row)
                        for field in ("photo_storage_path", "photo_mime_type", "photo_size_bytes"):
                            report.pop(field, None)
                        reports.append(report)
                    cur.execute("SELECT * FROM community_report_groups ORDER BY priority_tier DESC, valid_report_count DESC")
                    groups = [dict(g) for g in cur.fetchall()]
                    self.send_json(200, {"ok": True, "status": "ok", "reports": reports, "groups": groups})
                    return

                payload = sync_public_snapshots(conn)
                code_q = (qs.get("code") or [""])[0].strip().upper()
                if code_q:
                    payload["reports"] = [r for r in payload["reports"] if r["report_code"] == code_q]
                self.send_json(200, payload)
            finally:
                conn.close()
            return

        if parsed.path in ("/admin-panel", "/admin-panel/"):
            self.path = "/admin-panel/index.html"
        elif parsed.path in ("/laporan", "/laporan/"):
            self.path = "/laporan/index.html"
        elif parsed.path in ("/karhutla", "/karhutla/"):
            self.path = "/karhutla/index.html"
        elif parsed.path in ("/gunung-berapi", "/gunung-berapi/"):
            self.path = "/gunung-berapi/index.html"
        elif parsed.path == "/":
            self.path = "/main/index.html"
        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/api/community-reports":
            self.send_json(404, {"error": "Endpoint tidak ditemukan.", "message": "Endpoint tidak ditemukan."})
            return

        length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
        try:
            body = json.loads(raw_body)
        except Exception:
            self.send_json(400, {"error": "Payload JSON tidak valid.", "message": "Payload JSON tidak valid."})
            return

        action = body.get("action", "submit")
        if action == "admin_login":
            try:
                expected_email, expected_password, _ = get_moderator_credentials()
            except RuntimeError as err:
                self.send_json(503, {"error": str(err), "message": str(err)})
                return
            given_email = str(body.get("email") or "").strip()
            given_password = str(body.get("password") or "")
            if given_email.lower() == expected_email.lower() and hmac.compare_digest(given_password, expected_password):
                token = create_moderator_token(expected_email)
                self.send_json(200, {"ok": True, "status": "ok", "token": token, "email": expected_email})
            else:
                self.send_json(401, {"error": "Email moderator atau kata sandi tidak sesuai.", "message": "Email moderator atau kata sandi tidak sesuai."})
            return

        if action == "moderate":
            auth_header = self.headers.get("Authorization", "")
            token = auth_header[7:].strip() if auth_header.startswith("Bearer ") else ""
            mod_email = verify_moderator_token(token)
            if not mod_email:
                self.send_json(401, {"error": "Akses ditolak. Silakan masuk sebagai moderator.", "message": "Akses ditolak. Silakan masuk sebagai moderator."})
                return
            try:
                result = moderate_report(
                    str(body.get("report_id") or ""),
                    str(body.get("moderation_status") or ""),
                    mod_email,
                    body.get("moderation_note"),
                )
                self.send_json(200, result)
            except ValueError as e:
                self.send_json(400, {"error": str(e), "message": str(e)})
            return

        if action == "submit":
            try:
                result = submit_report(body)
                self.send_json(201, result)
            except ValueError as e:
                self.send_json(400, {"error": str(e), "message": str(e)})
            return

        self.send_json(400, {"error": "Aksi tidak dikenali.", "message": "Aksi tidak dikenali."})


def verify_end_to_end_flow():
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    seed_realistic_initial_reports()
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT id, report_code, group_id, group_key
        FROM community_reports
        WHERE regency_pum_code = '35.15' AND category = 'kualitas_udara'
        ORDER BY created_at_utc DESC
        LIMIT 1
        """
    )
    sample_air = dict(cur.fetchone())

    cur.execute(
        """
        SELECT id, report_code, moderation_status
        FROM community_reports
        WHERE regency_pum_code = '35.15' AND category = 'karhutla'
        ORDER BY created_at_utc ASC
        """
    )
    sda_fire_rows = [dict(r) for r in cur.fetchall()]
    conn.close()

    res_reject_air = moderate_report(sample_air["id"], "rejected", "moderator@wiamia2026.id", "Uji penurunan 3 ke 2")
    assert res_reject_air["group"]["valid_report_count"] == 2

    res_approve_air = moderate_report(sample_air["id"], "approved", "moderator@wiamia2026.id", "Setujui laporan udara")
    assert res_approve_air["group"]["valid_report_count"] == 3
    assert res_approve_air["group"]["approved_report_count"] == 1

    assert len(sda_fire_rows) == 3
    fire_unapproved = [r for r in sda_fire_rows if r["moderation_status"] == "valid"][0]
    res_fire_approve = moderate_report(fire_unapproved["id"], "approved", "moderator@wiamia2026.id", "Setujui laporan karhutla")
    assert res_fire_approve["group"]["valid_report_count"] == 3
    assert res_fire_approve["group"]["approved_report_count"] == 2
    assert res_fire_approve["group"]["eligible_report_count"] == 2

    res_fire_reject = moderate_report(fire_unapproved["id"], "rejected", "moderator@wiamia2026.id", "Tolak laporan")
    assert res_fire_reject["group"]["valid_report_count"] == 2
    assert res_fire_reject["group"]["approved_report_count"] == 1
    assert res_fire_reject["group"]["eligible_report_count"] == 1

    res_fire_restore = moderate_report(fire_unapproved["id"], "valid", "moderator@wiamia2026.id", "Kembalikan valid")
    assert res_fire_restore["group"]["valid_report_count"] == 3
    assert res_fire_restore["group"]["approved_report_count"] == 1
    assert res_fire_restore["group"]["eligible_report_count"] == 1


if __name__ == "__main__":
    if "--init-db" in sys.argv:
        seed_realistic_initial_reports()
        sys.exit(0)
    if "--verify-flow" in sys.argv:
        verify_end_to_end_flow()
        sys.exit(0)
    seed_realistic_initial_reports()
    server = http.server.ThreadingHTTPServer(("localhost", 0), CommunityReportingHTTPRequestHandler)
    print(f"Server lokal berjalan di http://localhost:{server.server_port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
