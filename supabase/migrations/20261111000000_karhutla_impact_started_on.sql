alter table public.community_reports
  add column if not exists impact_started_on date;

create or replace function public.submit_community_report_with_impact(
  p_reporter_name text,
  p_category text,
  p_province_pum_code text,
  p_province_name text,
  p_regency_pum_code text,
  p_regency_bps_code text,
  p_regency_name text,
  p_observed_at_utc timestamptz,
  p_description text,
  p_air_decline_pct integer,
  p_air_duration_days integer,
  p_latitude double precision,
  p_longitude double precision,
  p_impact_started_on date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  if p_category = 'karhutla' then
    if p_impact_started_on is null then
      raise exception 'Tanggal mulai dampak wajib diisi untuk laporan Karhutla.';
    end if;
    if p_impact_started_on > (now() at time zone 'Asia/Jakarta')::date then
      raise exception 'Tanggal mulai dampak tidak boleh berada di masa depan.';
    end if;
    if p_observed_at_utc is not null
      and p_impact_started_on > (p_observed_at_utc at time zone 'Asia/Jakarta')::date then
      raise exception 'Tanggal mulai dampak tidak boleh setelah waktu pengamatan.';
    end if;
  elsif p_category <> 'kualitas_udara' then
    raise exception 'Jenis laporan tidak valid.';
  end if;

  v_result := public.submit_community_report(
    p_reporter_name => p_reporter_name,
    p_category => p_category,
    p_province_pum_code => p_province_pum_code,
    p_province_name => p_province_name,
    p_regency_pum_code => p_regency_pum_code,
    p_regency_bps_code => p_regency_bps_code,
    p_regency_name => p_regency_name,
    p_observed_at_utc => p_observed_at_utc,
    p_description => p_description,
    p_air_decline_pct => p_air_decline_pct,
    p_air_duration_days => p_air_duration_days,
    p_latitude => p_latitude,
    p_longitude => p_longitude
  );

  if p_category = 'karhutla' then
    update public.community_reports
    set impact_started_on = p_impact_started_on
    where report_id = (v_result->>'report_id')::uuid;

    if not found then
      raise exception 'Laporan gagal diperbarui dengan tanggal mulai dampak.';
    end if;
  end if;

  return v_result;
end;
$$;

revoke all on function public.submit_community_report(
  text, text, text, text, text, text, text, timestamptz, text, text, text,
  integer, integer, integer, double precision, double precision
) from public, anon, authenticated;

revoke all on function public.submit_community_report_with_impact(
  text, text, text, text, text, text, text, timestamptz, text,
  integer, integer, double precision, double precision, date
) from public;
grant execute on function public.submit_community_report_with_impact(
  text, text, text, text, text, text, text, timestamptz, text,
  integer, integer, double precision, double precision, date
) to anon, authenticated, service_role;

drop view if exists public.public_community_reports_view;

create view public.public_community_reports_view as
select
  r.report_id,
  r.report_code,
  r.group_key,
  r.category,
  r.province_pum_code,
  r.province_name,
  r.regency_pum_code,
  r.regency_bps_code,
  r.regency_name,
  r.observed_at_utc,
  case
    when r.category = 'karhutla' then left(r.description, 280)
    else 'Penurunan kualitas udara dirasakan sebesar ' || r.air_decline_pct || '% selama ' || r.air_duration_days || ' hari.'
  end as public_summary,
  r.air_decline_pct,
  r.air_duration_days,
  r.firms_corroborated,
  r.moderation_status,
  r.created_at_utc,
  g.valid_report_count as group_valid_count,
  g.priority_tier as group_priority_tier,
  g.queue_status as group_queue_status,
  g.avg_air_decline_pct as group_avg_air_decline_pct,
  g.avg_air_duration_days as group_avg_air_duration_days,
  g.firms_match_status as group_firms_match_status,
  g.first_report_at_utc as group_first_report_at_utc,
  g.promoted_at_utc as group_promoted_at_utc,
  g.threshold_notified_at_utc as group_threshold_notified_at_utc,
  r.impact_started_on
from public.community_reports r
inner join public.community_report_groups g
  on g.group_key = r.group_key
where r.moderation_status in ('valid', 'approved');

grant select on public.public_community_reports_view to anon, authenticated;
