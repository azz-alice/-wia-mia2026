import { createClient } from "npm:@supabase/supabase-js@2";
import {
  INDONESIA_BBOX,
  NASA_FIRMS_CONFIG,
  fetchWithRetry,
  isInsideIndonesiaBbox
} from "../_shared/env-config.ts";

interface FirmsHotspotRow {
  product: string;
  latitude: number;
  longitude: number;
  bright_ti4: string | null;
  bright_ti5: string | null;
  frp: string | null;
  confidence: string | null;
  satellite: string | null;
  instrument: string | null;
  daynight: string | null;
  acq_timestamp_utc: string;
}

function parseAcqTimestampUtc(acqDate: string, acqTime: string): string | null {
  const cleanDate = String(acqDate || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) return null;
  const paddedTime = String(acqTime || "").trim().padStart(4, "0");
  if (!/^\d{4}$/.test(paddedTime)) return null;
  const hh = Number(paddedTime.slice(0, 2));
  const mm = Number(paddedTime.slice(2, 4));
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  const iso = `${cleanDate}T${paddedTime.slice(0, 2)}:${paddedTime.slice(2, 4)}:00Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function parseFirmsCsv(csvText: string, product = NASA_FIRMS_CONFIG.product): FirmsHotspotRow[] {
  const lines = String(csvText || "")
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map(h => h.trim().toLowerCase());
  const idxLat = headers.indexOf("latitude");
  const idxLon = headers.indexOf("longitude");
  const idxDate = headers.indexOf("acq_date");
  const idxTime = headers.indexOf("acq_time");
  if (idxLat < 0 || idxLon < 0 || idxDate < 0 || idxTime < 0) {
    throw new Error("CSV header missing required NASA FIRMS coordinate or timestamp columns");
  }

  const idxTi4 = headers.indexOf("bright_ti4");
  const idxTi5 = headers.indexOf("bright_ti5");
  const idxFrp = headers.indexOf("frp");
  const idxConf = headers.indexOf("confidence");
  const idxSat = headers.indexOf("satellite");
  const idxInst = headers.indexOf("instrument");
  const idxDn = headers.indexOf("daynight");

  const seenIds = new Set<string>();
  const rows: FirmsHotspotRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map(c => c.trim());
    if (cols.length <= Math.max(idxLat, idxLon, idxDate, idxTime)) continue;

    const lat = Number(cols[idxLat]);
    const lon = Number(cols[idxLon]);
    if (!isInsideIndonesiaBbox(lat, lon)) continue;

    const acqIso = parseAcqTimestampUtc(cols[idxDate], cols[idxTime]);
    if (!acqIso) continue;

    const dedupKey = `${product}:${lat.toFixed(4)}:${lon.toFixed(4)}:${acqIso}`;
    if (seenIds.has(dedupKey)) continue;
    seenIds.add(dedupKey);

    rows.push({
      product,
      latitude: Number(lat.toFixed(5)),
      longitude: Number(lon.toFixed(5)),
      bright_ti4: idxTi4 >= 0 && cols[idxTi4] !== "" ? cols[idxTi4] : null,
      bright_ti5: idxTi5 >= 0 && cols[idxTi5] !== "" ? cols[idxTi5] : null,
      frp: idxFrp >= 0 && cols[idxFrp] !== "" ? cols[idxFrp] : null,
      confidence: idxConf >= 0 && cols[idxConf] !== "" ? cols[idxConf] : null,
      satellite: idxSat >= 0 && cols[idxSat] !== "" ? cols[idxSat] : null,
      instrument: idxInst >= 0 && cols[idxInst] !== "" ? cols[idxInst] : "VIIRS",
      daynight: idxDn >= 0 && cols[idxDn] !== "" ? cols[idxDn] : null,
      acq_timestamp_utc: acqIso
    });
  }

  return rows;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response(JSON.stringify({ status: "error", code: "METHOD_NOT_ALLOWED" }), {
      status: 405,
      headers: { "Content-Type": "application/json" }
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const firmsMapKey = Deno.env.get("NASA_FIRMS_MAP_KEY");

  if (!supabaseUrl || !supabaseServiceKey) {
    return new Response(
      JSON.stringify({
        status: "error",
        code: "MISSING_SUPABASE_ENV",
        message: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured"
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false }
  });

  if (!firmsMapKey) {
    await supabase.rpc("mark_sync_failure", {
      p_source: "nasa_firms",
      p_http_status: 401,
      p_error_code: "MISSING_NASA_FIRMS_MAP_KEY",
      p_error_message: "Environment variable NASA_FIRMS_MAP_KEY is not set"
    });
    return new Response(
      JSON.stringify({
        status: "error",
        code: "MISSING_NASA_FIRMS_MAP_KEY",
        message: "Environment variable NASA_FIRMS_MAP_KEY is not configured"
      }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  const syncedAt = new Date().toISOString();

  try {
    const allParsedRows: FirmsHotspotRow[] = [];
    const seenDedup = new Set<string>();
    let lastHttpStatus = 503;
    let anySuccess = false;

    for (const src of NASA_FIRMS_CONFIG.sources) {
      const endpoint = `${NASA_FIRMS_CONFIG.baseUrl}/${encodeURIComponent(firmsMapKey)}/${src}/${INDONESIA_BBOX.asCsv()}/${NASA_FIRMS_CONFIG.dayRange}`;
      const response = await fetchWithRetry(
        endpoint,
        {
          method: "GET",
          headers: { Accept: "text/csv,text/plain;q=0.9" }
        },
        NASA_FIRMS_CONFIG.maxRetries,
        NASA_FIRMS_CONFIG.timeoutMs
      );
      lastHttpStatus = response.status;
      if (!response.ok) continue;
      const csvText = await response.text();
      if (!csvText.toLowerCase().includes("latitude")) continue;
      anySuccess = true;
      const rows = parseFirmsCsv(csvText, src);
      for (const r of rows) {
        if (String(r.confidence || "").toLowerCase() === "l") continue;
        const k = `${r.satellite || src}:${r.latitude.toFixed(4)}:${r.longitude.toFixed(4)}:${r.acq_timestamp_utc}`;
        if (!seenDedup.has(k)) {
          seenDedup.add(k);
          allParsedRows.push(r);
        }
      }
    }

    if (!anySuccess || allParsedRows.length === 0) {
      const errCode =
        lastHttpStatus === 401 || lastHttpStatus === 403
          ? "FIRMS_AUTH_REJECTED"
          : lastHttpStatus === 429
            ? "FIRMS_RATE_LIMITED"
            : `FIRMS_EMPTY_OR_HTTP_${lastHttpStatus}`;

      await supabase.rpc("mark_sync_failure", {
        p_source: "nasa_firms",
        p_http_status: lastHttpStatus,
        p_error_code: errCode,
        p_error_message: `NASA FIRMS API returned status ${lastHttpStatus} with 0 active rows`
      });

      return new Response(
        JSON.stringify({
          status: "error",
          code: errCode,
          http_status: lastHttpStatus,
          synced_at_utc: syncedAt
        }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    const { data, error } = await supabase.rpc("ingest_firms_hotspots", {
      p_rows: allParsedRows,
      p_synced_at: syncedAt
    });

    if (error) {
      await supabase.rpc("mark_sync_failure", {
        p_source: "nasa_firms",
        p_http_status: 500,
        p_error_code: "DB_INGEST_ERROR",
        p_error_message: error.message
      });
      return new Response(
        JSON.stringify({
          status: "error",
          code: "DB_INGEST_ERROR",
          synced_at_utc: syncedAt
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Network or timeout error";
    await supabase.rpc("mark_sync_failure", {
      p_source: "nasa_firms",
      p_http_status: 504,
      p_error_code: "FIRMS_NETWORK_TIMEOUT",
      p_error_message: msg
    });
    return new Response(
      JSON.stringify({
        status: "error",
        code: "FIRMS_NETWORK_TIMEOUT",
        synced_at_utc: syncedAt
      }),
      { status: 504, headers: { "Content-Type": "application/json" } }
    );
  }
});
