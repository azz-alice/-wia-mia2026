import { createClient } from "npm:@supabase/supabase-js@2";

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
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || (!supabaseAnonKey && !supabaseServiceKey)) {
    return new Response(
      JSON.stringify({
        status: "error",
        code: "SUPABASE_NOT_CONFIGURED",
        message: "Konfigurasi SUPABASE_URL dan SUPABASE_ANON_KEY belum tersedia di environment server."
      }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const authHeader = req.headers.get("Authorization") || "";
  const clientKey = supabaseServiceKey || supabaseAnonKey || "";
  const supabase = createClient(supabaseUrl, clientKey, {
    auth: { persistSession: false },
    global: authHeader ? { headers: { Authorization: authHeader } } : undefined
  });

  if (req.method === "GET") {
    const url = new URL(req.url);
    const searchCode = (url.searchParams.get("code") || "").trim().toUpperCase();
    const category = (url.searchParams.get("category") || "").trim();
    const provinceCode = (url.searchParams.get("province_pum_code") || "").trim();
    const regencyCode = (url.searchParams.get("regency_pum_code") || "").trim();
    const mode = (url.searchParams.get("mode") || "public").trim();
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const limit = Math.min(100, Math.max(5, Number(url.searchParams.get("limit")) || 25));
    const offset = (page - 1) * limit;

    if (searchCode) {
      const { data: found, error: findErr } = await supabase
        .from("public_community_reports_view")
        .select("*")
        .ilike("report_code", searchCode)
        .maybeSingle();

      if (findErr) {
        return new Response(
          JSON.stringify({ status: "error", code: "QUERY_ERROR", message: findErr.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (!found) {
        return new Response(
          JSON.stringify({
            status: "not_found",
            message: `Laporan dengan kode ${searchCode} tidak ditemukan atau telah ditolak moderasi.`
          }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({ status: "ok", report: found }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (mode === "admin") {
      const { data: userRes, error: userErr } = await supabase.auth.getUser();
      if (userErr || !userRes?.user) {
        return new Response(
          JSON.stringify({ status: "error", code: "UNAUTHORIZED", message: "Sesi moderator tidak valid." }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const { data: modProfile } = await supabase
        .from("moderator_profiles")
        .select("user_id,email,role,is_active")
        .eq("user_id", userRes.user.id)
        .eq("is_active", true)
        .maybeSingle();

      if (!modProfile) {
        return new Response(
          JSON.stringify({ status: "error", code: "FORBIDDEN", message: "Akun tidak memiliki hak akses moderator." }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      let adminQuery = supabase
        .from("community_reports")
        .select("*, community_report_groups(*)", { count: "exact" })
        .order("created_at_utc", { ascending: false })
        .range(offset, offset + limit - 1);

      if (category) adminQuery = adminQuery.eq("category", category);
      if (provinceCode) adminQuery = adminQuery.eq("province_pum_code", provinceCode);
      if (regencyCode) adminQuery = adminQuery.eq("regency_pum_code", regencyCode);

      const { data: adminRows, count: totalCount, error: adminErr } = await adminQuery;
      if (adminErr) {
        return new Response(
          JSON.stringify({ status: "error", code: "ADMIN_QUERY_ERROR", message: adminErr.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const reports = (adminRows || []).map(report => {
        const cleanReport = { ...report };
        delete cleanReport.photo_storage_path;
        delete cleanReport.photo_mime_type;
        delete cleanReport.photo_size_bytes;
        return cleanReport;
      });
      return new Response(
        JSON.stringify({
          status: "ok",
          page,
          limit,
          total: totalCount || 0,
          reports
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let pubQuery = supabase
      .from("public_community_reports_view")
      .select("*", { count: "exact" });

    if (category) pubQuery = pubQuery.eq("category", category);
    if (provinceCode) pubQuery = pubQuery.eq("province_pum_code", provinceCode);
    if (regencyCode) pubQuery = pubQuery.eq("regency_pum_code", regencyCode);

    const [{ data: pubRows, count: pubTotal, error: pubErr }, { data: groups, error: grpErr }] = await Promise.all([
      pubQuery
        .order("group_priority_tier", { ascending: false })
        .order("group_valid_count", { ascending: false })
        .order("group_first_report_at_utc", { ascending: true })
        .order("created_at_utc", { ascending: true })
        .range(offset, offset + limit - 1),
      supabase
        .from("community_report_groups")
        .select("*")
        .gt("valid_report_count", 0)
        .order("priority_tier", { ascending: false })
        .order("valid_report_count", { ascending: false })
        .order("first_report_at_utc", { ascending: true })
    ]);

    if (pubErr || grpErr) {
      return new Response(
        JSON.stringify({
          status: "error",
          code: "PUBLIC_QUERY_ERROR",
          message: pubErr?.message || grpErr?.message || "Gagal memuat daftar laporan"
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        status: "ok",
        page,
        limit,
        total: pubTotal || 0,
        reports: pubRows || [],
        groups: groups || []
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (req.method === "POST") {
    try {
      const body = await req.json();
      const action = String(body?.action || "submit").trim();

      if (action === "moderate") {
        const reportId = String(body?.report_id || "").trim();
        const newStatus = String(body?.moderation_status || "").trim();
        const note = body?.moderation_note ? String(body.moderation_note).trim() : null;

        const { data: modResult, error: modErr } = await supabase.rpc("moderate_community_report", {
          p_report_id: reportId,
          p_new_status: newStatus,
          p_note: note
        });

        if (modErr) {
          return new Response(
            JSON.stringify({ status: "error", code: "MODERATION_REJECTED", message: modErr.message }),
            { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        return new Response(JSON.stringify(modResult), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const { data: submitResult, error: submitErr } = await supabase.rpc("submit_community_report_public", {
        p_reporter_name: body?.reporter_name,
        p_category: body?.category,
        p_province_pum_code: body?.province_pum_code,
        p_province_name: body?.province_name,
        p_regency_pum_code: body?.regency_pum_code,
        p_regency_bps_code: body?.regency_bps_code,
        p_regency_name: body?.regency_name,
        p_observed_at_utc: body?.observed_at_utc || null,
        p_description: body?.description || null,
        p_air_decline_pct: body?.air_decline_pct != null ? Number(body.air_decline_pct) : null,
        p_air_duration_days: body?.air_duration_days != null ? Number(body.air_duration_days) : null,
        p_latitude: body?.latitude != null ? Number(body.latitude) : null,
        p_longitude: body?.longitude != null ? Number(body.longitude) : null
      });

      if (submitErr) {
        return new Response(
          JSON.stringify({
            status: "error",
            code: "VALIDATION_FAILED",
            message: submitErr.message
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return new Response(JSON.stringify(submitResult), {
        status: 201,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    } catch (_) {
      return new Response(
        JSON.stringify({ status: "error", code: "INVALID_JSON", message: "Format permintaan tidak valid." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  }

  return new Response(JSON.stringify({ status: "error", code: "METHOD_NOT_ALLOWED" }), {
    status: 405,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
});
