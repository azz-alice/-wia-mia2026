create or replace function public.recalculate_report_group(p_group_key text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_grp public.community_report_groups%rowtype;
  v_cnt integer := 0;
  v_approved_cnt integer := 0;
  v_eligible_cnt integer := 0;
  v_threshold_cnt integer := 0;
  v_avg_pct numeric(5,1);
  v_avg_days numeric(4,1);
  v_first_at timestamptz;
  v_last_at timestamptz;
  v_any_firms boolean := false;
  v_tier integer := 1;
  v_qstatus text := 'empty';
  v_promoted_at timestamptz;
  v_notified_at timestamptz;
  v_newly_notified boolean := false;
begin
  select * into v_grp
  from public.community_report_groups
  where group_key = p_group_key;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select
    count(*)::integer,
    count(*) filter (where moderation_status = 'approved')::integer,
    round(avg(air_decline_pct)::numeric, 1),
    round(avg(air_duration_days)::numeric, 1),
    min(created_at_utc),
    max(created_at_utc),
    bool_or(firms_corroborated)
  into v_cnt, v_approved_cnt, v_avg_pct, v_avg_days, v_first_at, v_last_at, v_any_firms
  from public.community_reports
  where group_key = p_group_key
    and moderation_status in ('valid', 'approved');

  if v_grp.category = 'karhutla' then
    v_threshold_cnt := v_approved_cnt;
    v_eligible_cnt := case when v_approved_cnt >= 5 then v_approved_cnt else 0 end;
  else
    v_threshold_cnt := v_cnt;
    v_eligible_cnt := case when v_cnt >= 5 then v_cnt else v_approved_cnt end;
  end if;

  if v_cnt <= 0 then
    v_tier := 0;
    v_qstatus := 'empty';
    v_promoted_at := null;
    v_notified_at := v_grp.threshold_notified_at_utc;
  elsif v_threshold_cnt >= 5 then
    v_tier := 4;
    v_qstatus := 'promoted_supplementary';
    v_promoted_at := coalesce(v_grp.promoted_at_utc, now());
    if v_grp.threshold_notified_at_utc is null then
      v_notified_at := now();
      v_newly_notified := true;
    else
      v_notified_at := v_grp.threshold_notified_at_utc;
    end if;
  else
    v_tier := case
      when v_cnt = 1 then 1
      when v_cnt = 2 then 2
      else 3
    end;
    v_qstatus := 'active_queue';
    v_promoted_at := null;
    v_notified_at := v_grp.threshold_notified_at_utc;
  end if;

  update public.community_report_groups set
    valid_report_count = v_cnt,
    approved_report_count = v_approved_cnt,
    eligible_report_count = v_eligible_cnt,
    priority_tier = v_tier,
    queue_status = v_qstatus,
    avg_air_decline_pct = case when v_grp.category = 'kualitas_udara' and v_cnt > 0 then v_avg_pct else null end,
    avg_air_duration_days = case when v_grp.category = 'kualitas_udara' and v_cnt > 0 then v_avg_days else null end,
    firms_match_status = case
      when v_grp.category = 'karhutla' and v_any_firms then 'corroborated_with_firms'
      when v_grp.category = 'karhutla' and v_cnt > 0 then 'community_observation_only'
      else 'unverified'
    end,
    first_report_at_utc = v_first_at,
    last_report_at_utc = v_last_at,
    promoted_at_utc = v_promoted_at,
    threshold_notified_at_utc = v_notified_at,
    updated_at_utc = now()
  where group_key = p_group_key;

  if v_grp.category = 'kualitas_udara' then
    update public.city_environment_summary set
      community_report_count = v_eligible_cnt,
      community_perception_avg_pct = case when v_eligible_cnt > 0 then v_avg_pct else null end,
      community_duration_avg_days = case when v_eligible_cnt > 0 then v_avg_days else null end,
      community_last_report_utc = v_last_at,
      updated_at_utc = now()
    where regency_pum_code = v_grp.regency_pum_code;
  end if;

  return jsonb_build_object(
    'group_key', p_group_key,
    'valid_report_count', v_cnt,
    'approved_report_count', v_approved_cnt,
    'eligible_report_count', v_eligible_cnt,
    'priority_tier', v_tier,
    'queue_status', v_qstatus,
    'avg_air_decline_pct', v_avg_pct,
    'avg_air_duration_days', v_avg_days,
    'newly_notified', v_newly_notified
  );
end;
$$;

select public.recalculate_report_group(group_key)
from public.community_report_groups;
