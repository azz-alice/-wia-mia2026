import { createClient } from "npm:@supabase/supabase-js@2";
import {
  INDONESIA_BBOX,
  OPENAQ_V3_CONFIG,
  fetchWithRetry,
  isInsideIndonesiaBbox
} from "../_shared/env-config.ts";

interface OpenAqStationPayload {
  sensor_id: number;
  location_id: number;
  station_name: string;
  latitude: number;
  longitude: number;
  unit: string;
  last_seen_utc: string | null;
}

interface OpenAqMeasurementPayload {
  sensor_id: number;
  value_ugm3: number;
  coverage_pct: number | null;
  period_start_utc: string;
  period_end_utc: string;
}

export function extractValidPm25Sensors(
  locationsPayload: unknown,
  nowMs = Date.now(),
  maxInactiveDays = 7
): OpenAqStationPayload[] {
  const results = Array.isArray((locationsPayload as { results?: unknown[] })?.results)
    ? ((locationsPayload as { results: unknown[] }).results)
    : [];
  const stations: OpenAqStationPayload[] = [];
  const seenSensors = new Set<number>();
  const inactiveCutoffMs = nowMs - maxInactiveDays * 24 * 3600 * 1000;

  for (const rawLoc of results) {
    const loc = rawLoc as Record<string, unknown>;
    const locationId = Number(loc?.id);
    const coords = loc?.coordinates as { latitude?: number; longitude?: number } | undefined;
    const lat = Number(coords?.latitude);
    const lon = Number(coords?.longitude);
    if (!Number.isFinite(locationId) || !isInsideIndonesiaBbox(lat, lon)) continue;

    const dtLastObj = loc?.datetimeLast as { utc?: string } | undefined;
    const lastSeenIso = typeof dtLastObj?.utc === "string" ? dtLastObj.utc : null;
    if (lastSeenIso) {
      const lastSeenMs = Date.parse(lastSeenIso);
      if (Number.isFinite(lastSeenMs) && lastSeenMs < inactiveCutoffMs) continue;
    }

    const sensors = Array.isArray(loc?.sensors) ? (loc.sensors as Record<string, unknown>[]) : [];
    for (const s of sensors) {
      const sensorId = Number(s?.id);
      if (!Number.isFinite(sensorId) || seenSensors.has(sensorId)) continue;

      const param = s?.parameter as { id?: number; name?: string; units?: string } | undefined;
      const paramId = Number(param?.id);
      const paramName = String(param?.name || "").toLowerCase();
      const units = String(param?.units || "").trim();

      const isPm25 = paramId === OPENAQ_V3_CONFIG.pm25ParameterId || paramName === OPENAQ_V3_CONFIG.pm25ParameterName;
      if (!isPm25 || !OPENAQ_V3_CONFIG.allowedUnits.has(units)) continue;

      seenSensors.add(sensorId);
      stations.push({
        sensor_id: sensorId,
        location_id: locationId,
        station_name: String(loc?.name || loc?.locality || `OpenAQ #${locationId}`).trim(),
        latitude: Number(lat.toFixed(5)),
        longitude: Number(lon.toFixed(5)),
        unit: "µg/m³",
        last_seen_utc: lastSeenIso
      });
    }
  }

  return stations;
}

export function extractHourlyMeasurements(
  sensorId: number,
  hoursPayload: unknown,
  windowStartMs: number,
  windowEndMs: number
): OpenAqMeasurementPayload[] {
  const results = Array.isArray((hoursPayload as { results?: unknown[] })?.results)
    ? ((hoursPayload as { results: unknown[] }).results)
    : [];
  const items: OpenAqMeasurementPayload[] = [];
  const seenPeriods = new Set<string>();

  for (const rawRow of results) {
    const row = rawRow as Record<string, unknown>;
    const val = Number(row?.value);
    if (!Number.isFinite(val) || val < 0 || val > 2000) continue;

    const param = row?.parameter as { units?: string } | undefined;
    if (param?.units && !OPENAQ_V3_CONFIG.allowedUnits.has(String(param.units).trim())) continue;

    const period = row?.period as {
      datetimeFrom?: { utc?: string };
      datetimeTo?: { utc?: string };
    } | undefined;
    const dtObj = row?.datetime as { utc?: string } | undefined;

    const endUtc = period?.datetimeTo?.utc || dtObj?.utc || null;
    if (!endUtc) continue;
    const endMs = Date.parse(endUtc);
    if (!Number.isFinite(endMs) || endMs < windowStartMs || endMs > windowEndMs + 3600_000) continue;

    const startUtc =
      period?.datetimeFrom?.utc ||
      new Date(endMs - 3600_000).toISOString();
    const startMs = Date.parse(startUtc);
    if (!Number.isFinite(startMs)) continue;

    const endIso = new Date(endMs).toISOString();
    if (seenPeriods.has(endIso)) continue;
    seenPeriods.add(endIso);

    const cov = row?.coverage as { percentComplete?: number } | undefined;
    const covPct = Number.isFinite(Number(cov?.percentComplete)) ? Number(cov?.percentComplete) : null;

    items.push({
      sensor_id: sensorId,
      value_ugm3: Number(val.toFixed(2)),
      coverage_pct: covPct,
      period_start_utc: new Date(startMs).toISOString(),
      period_end_utc: endIso
    });
  }

  return items;
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
  const openAqKey = Deno.env.get("OPENAQ_API_KEY");

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

  if (!openAqKey) {
    await supabase.rpc("mark_sync_failure", {
      p_source: "openaq_pm25",
      p_http_status: 401,
      p_error_code: "MISSING_OPENAQ_API_KEY",
      p_error_message: "Environment variable OPENAQ_API_KEY is not set"
    });
    return new Response(
      JSON.stringify({
        status: "error",
        code: "MISSING_OPENAQ_API_KEY",
        message: "Environment variable OPENAQ_API_KEY is not configured"
      }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  const nowMs = Date.now();
  const syncedAt = new Date(nowMs).toISOString();
  const windowStartMs = nowMs - OPENAQ_V3_CONFIG.windowHours * 3600 * 1000;
  const windowStartIso = new Date(windowStartMs).toISOString();

  const headers = {
    Accept: "application/json",
    "X-API-Key": openAqKey
  };

  try {
    const allStations: OpenAqStationPayload[] = [];
    let page = 1;
    const maxPages = 5;

    while (page <= maxPages) {
      const locUrl = `${OPENAQ_V3_CONFIG.baseUrl}/locations?bbox=${INDONESIA_BBOX.asCsv()}&parameters_id=${OPENAQ_V3_CONFIG.pm25ParameterId}&limit=${OPENAQ_V3_CONFIG.pageLimit}&page=${page}`;
      const locRes = await fetchWithRetry(
        locUrl,
        { method: "GET", headers },
        OPENAQ_V3_CONFIG.maxRetries,
        OPENAQ_V3_CONFIG.timeoutMs
      );

      if (!locRes.ok) {
        const errCode =
          locRes.status === 401 || locRes.status === 403
            ? "OPENAQ_AUTH_REJECTED"
            : locRes.status === 404
              ? "OPENAQ_ENDPOINT_NOT_FOUND"
              : locRes.status === 429
                ? "OPENAQ_RATE_LIMITED"
                : `OPENAQ_HTTP_${locRes.status}`;

        await supabase.rpc("mark_sync_failure", {
          p_source: "openaq_pm25",
          p_http_status: locRes.status,
          p_error_code: errCode,
          p_error_message: `OpenAQ v3 locations endpoint returned HTTP ${locRes.status}`
        });

        return new Response(
          JSON.stringify({
            status: "error",
            code: errCode,
            http_status: locRes.status,
            synced_at_utc: syncedAt
          }),
          { status: 502, headers: { "Content-Type": "application/json" } }
        );
      }

      const locJson = await locRes.json();
      const pageStations = extractValidPm25Sensors(locJson, nowMs);
      allStations.push(...pageStations);

      const resultsCount = Array.isArray(locJson?.results) ? locJson.results.length : 0;
      if (resultsCount < OPENAQ_V3_CONFIG.pageLimit) break;
      page++;
    }

    const allMeasurements: OpenAqMeasurementPayload[] = [];
    const batchSize = 6;

    for (let i = 0; i < allStations.length; i += batchSize) {
      const batch = allStations.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(async st => {
          const hoursUrl = `${OPENAQ_V3_CONFIG.baseUrl}/sensors/${st.sensor_id}/hours?datetime_from=${encodeURIComponent(windowStartIso)}&datetime_to=${encodeURIComponent(syncedAt)}&limit=48`;
          try {
            const hRes = await fetchWithRetry(
              hoursUrl,
              { method: "GET", headers },
              2,
              OPENAQ_V3_CONFIG.timeoutMs
            );
            if (!hRes.ok) return [];
            const hJson = await hRes.json();
            return extractHourlyMeasurements(st.sensor_id, hJson, windowStartMs, nowMs);
          } catch (_) {
            return [];
          }
        })
      );
      batchResults.forEach(items => allMeasurements.push(...items));
    }

    const { data, error } = await supabase.rpc("ingest_openaq_pm25", {
      p_stations: allStations,
      p_measurements: allMeasurements,
      p_synced_at: syncedAt,
      p_min_hourly_obs: OPENAQ_V3_CONFIG.minHourlyCompleteness,
      p_max_stale_hours: OPENAQ_V3_CONFIG.maxStationStalenessHours
    });

    if (error) {
      await supabase.rpc("mark_sync_failure", {
        p_source: "openaq_pm25",
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
    const msg = err instanceof Error ? err.message : "OpenAQ network or timeout error";
    await supabase.rpc("mark_sync_failure", {
      p_source: "openaq_pm25",
      p_http_status: 504,
      p_error_code: "OPENAQ_NETWORK_TIMEOUT",
      p_error_message: msg
    });
    return new Response(
      JSON.stringify({
        status: "error",
        code: "OPENAQ_NETWORK_TIMEOUT",
        synced_at_utc: syncedAt
      }),
      { status: 504, headers: { "Content-Type": "application/json" } }
    );
  }
});
