drop function if exists public.submit_community_report_with_impact(
  text, text, text, text, text, text, text, timestamptz, text,
  integer, integer, double precision, double precision, date
);

create or replace function public.submit_community_report_public(
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
  p_longitude double precision
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.submit_community_report(
    p_reporter_name => p_reporter_name,
    p_category => p_category,
    p_province_pum_code => p_province_pum_code,
    p_province_name => p_province_name,
    p_regency_pum_code => p_regency_pum_code,
    p_regency_bps_code => p_regency_bps_code,
    p_regency_name => p_regency_name,
    p_observed_at_utc => p_observed_at_utc,
    p_description => p_description,
    p_photo_storage_path => null,
    p_photo_mime_type => null,
    p_photo_size_bytes => null,
    p_air_decline_pct => p_air_decline_pct,
    p_air_duration_days => p_air_duration_days,
    p_latitude => p_latitude,
    p_longitude => p_longitude
  );
end;
$$;

revoke all on function public.submit_community_report_public(
  text, text, text, text, text, text, text, timestamptz, text,
  integer, integer, double precision, double precision
) from public;

grant execute on function public.submit_community_report_public(
  text, text, text, text, text, text, text, timestamptz, text,
  integer, integer, double precision, double precision
) to anon, authenticated, service_role;

drop view if exists public.public_community_reports_view;

alter table public.community_reports
  drop column if exists impact_started_on;

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
  g.threshold_notified_at_utc as group_threshold_notified_at_utc
from public.community_reports r
inner join public.community_report_groups g
  on g.group_key = r.group_key
where r.moderation_status in ('valid', 'approved');

grant select on public.public_community_reports_view to anon, authenticated;
