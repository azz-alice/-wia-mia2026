import { createClient } from "npm:@supabase/supabase-js@2";
import { COMMUNITY_PERCEPTION_CONFIG } from "../_shared/env-config.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey"
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseUrl || !supabaseKey) {
    return new Response(
      JSON.stringify({
        status: "error",
        code: "MISSING_SUPABASE_ENV",
        message: "Supabase environment is not configured"
      }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false }
  });

  if (req.method === "GET") {
    const url = new URL(req.url);
    const provinceCode = url.searchParams.get("province_pum_code");
    const regencyCode = url.searchParams.get("regency_pum_code");

    let summaryQuery = supabase
      .from("city_environment_summary")
      .select(
        "regency_pum_code,regency_bps_code,regency_name,admin_type,province_pum_code,province_bps_code,province_name,hotspot_count_24h,hotspot_category,hotspot_status,hotspot_last_obs_utc,hotspot_synced_utc,pm25_24h_ugm3,ispu_category,pm25_station_count,pm25_valid_station_count,pm25_status,pm25_last_obs_utc,pm25_synced_utc,community_report_count,community_perception_avg_pct,community_duration_avg_days,community_last_report_utc,updated_at_utc"
      );

    if (provinceCode) summaryQuery = summaryQuery.eq("province_pum_code", provinceCode);
    if (regencyCode) summaryQuery = summaryQuery.eq("regency_pum_code", regencyCode);

    const [{ data: summaries, error: sumErr }, { data: syncStatus, error: syncErr }] = await Promise.all([
      summaryQuery,
      supabase
        .from("data_sync_status")
        .select(
          "source_name,product_info,schedule_minutes,last_attempt_utc,last_success_utc,last_observation_utc,sync_state,records_received,records_matched,error_code,updated_at_utc"
        )
    ]);

    if (sumErr || syncErr) {
      return new Response(
        JSON.stringify({
          status: "error",
          code: "QUERY_FAILED",
          message: sumErr?.message || syncErr?.message || "Database query failed"
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        status: "ok",
        generated_at_utc: new Date().toISOString(),
        sync_status: syncStatus || [],
        regencies: summaries || []
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=60, stale-while-revalidate=300"
        }
      }
    );
  }

  if (req.method === "POST") {
    try {
      const body = await req.json();
      const regencyPumCode = String(body?.regency_pum_code || "").trim();
      const regencyBpsCode = String(body?.regency_bps_code || "").trim();
      const perceptionPct = Number(body?.perception_pct);
      const durationDays = Number(body?.duration_days);

      const validPct =
        Number.isInteger(perceptionPct) &&
        perceptionPct >= COMMUNITY_PERCEPTION_CONFIG.minPct &&
        perceptionPct <= COMMUNITY_PERCEPTION_CONFIG.maxPct &&
        perceptionPct % COMMUNITY_PERCEPTION_CONFIG.stepPct === 0;

      const validDuration =
        Number.isInteger(durationDays) &&
        durationDays >= COMMUNITY_PERCEPTION_CONFIG.minDurationDays &&
        durationDays <= COMMUNITY_PERCEPTION_CONFIG.maxDurationDays;

      if (!regencyPumCode || !validPct || !validDuration) {
        return new Response(
          JSON.stringify({
            status: "error",
            code: "INVALID_COMMUNITY_REPORT",
            message:
              "Laporan masyarakat wajib menyertakan regency_pum_code, perception_pct (0–100 kelipatan 10%), dan duration_days (1–35 hari)."
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const { error: insErr } = await supabase.from("community_air_reports").insert({
        regency_pum_code: regencyPumCode,
        regency_bps_code: regencyBpsCode || regencyPumCode.replace(".", ""),
        perception_pct: perceptionPct,
        duration_days: durationDays
      });

      if (insErr) {
        return new Response(
          JSON.stringify({
            status: "error",
            code: "REPORT_INSERT_FAILED",
            message: insErr.message
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      await supabase.rpc("refresh_community_perception_summary");

      return new Response(
        JSON.stringify({
          status: "ok",
          regency_pum_code: regencyPumCode,
          perception_pct: perceptionPct,
          duration_days: durationDays
        }),
        { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    } catch (_) {
      return new Response(
        JSON.stringify({ status: "error", code: "INVALID_JSON_BODY" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  }

  return new Response(JSON.stringify({ status: "error", code: "METHOD_NOT_ALLOWED" }), {
    status: 405,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
});
