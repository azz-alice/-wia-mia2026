create extension if not exists pgcrypto;

create table if not exists public.moderator_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  role text not null default 'moderator' check (role in ('moderator', 'admin')),
  is_active boolean not null default true,
  created_at_utc timestamptz not null default now()
);

create table if not exists public.community_report_groups (
  group_key text primary key,
  category text not null check (category in ('karhutla', 'kualitas_udara')),
  province_pum_code text not null,
  province_name text not null,
  regency_pum_code text not null,
  regency_bps_code text not null,
  regency_name text not null,
  period_bucket text not null,
  valid_report_count integer not null default 0,
  approved_report_count integer not null default 0,
  eligible_report_count integer not null default 0,
  priority_tier integer not null default 1,
  queue_status text not null default 'active_queue' check (queue_status in ('active_queue', 'promoted_supplementary', 'empty')),
  avg_air_decline_pct numeric(5,1),
  avg_air_duration_days numeric(4,1),
  firms_match_status text not null default 'unverified' check (firms_match_status in ('unverified', 'corroborated_with_firms', 'community_observation_only')),
  first_report_at_utc timestamptz,
  last_report_at_utc timestamptz,
  promoted_at_utc timestamptz,
  threshold_notified_at_utc timestamptz,
  updated_at_utc timestamptz not null default now()
);

create index if not exists idx_report_groups_queue_priority
  on public.community_report_groups (queue_status, priority_tier desc, valid_report_count desc, first_report_at_utc asc);
create index if not exists idx_report_groups_regency
  on public.community_report_groups (regency_pum_code, category);

create table if not exists public.community_reports (
  report_id uuid primary key default gen_random_uuid(),
  report_code text not null unique,
  group_key text not null references public.community_report_groups(group_key) on delete cascade,
  reporter_name text not null check (char_length(trim(reporter_name)) between 2 and 80),
  category text not null check (category in ('karhutla', 'kualitas_udara')),
  province_pum_code text not null,
  province_name text not null,
  regency_pum_code text not null,
  regency_bps_code text not null,
  regency_name text not null,
  observed_at_utc timestamptz,
  description text,
  photo_storage_path text,
  photo_mime_type text check (photo_mime_type is null or photo_mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  photo_size_bytes integer check (photo_size_bytes is null or (photo_size_bytes > 0 and photo_size_bytes <= 2097152)),
  air_decline_pct integer check (air_decline_pct is null or (air_decline_pct between 0 and 100 and air_decline_pct % 10 = 0)),
  air_duration_days integer check (air_duration_days is null or (air_duration_days between 1 and 35)),
  latitude double precision check (latitude is null or latitude between -12.0 and 7.0),
  longitude double precision check (longitude is null or longitude between 94.0 and 142.0),
  firms_corroborated boolean not null default false,
  moderation_status text not null default 'valid' check (moderation_status in ('valid', 'approved', 'rejected')),
  moderated_at_utc timestamptz,
  moderated_by uuid references auth.users(id) on delete set null,
  moderation_note text,
  created_at_utc timestamptz not null default now(),
  constraint chk_category_fields check (
    (category = 'karhutla' and observed_at_utc is not null and description is not null and char_length(trim(description)) between 5 and 1000 and air_decline_pct is null and air_duration_days is null)
    or
    (category = 'kualitas_udara' and air_decline_pct is not null and air_duration_days is not null and observed_at_utc is null and description is null and photo_storage_path is null)
  )
);

create index if not exists idx_community_reports_code_upper on public.community_reports (upper(report_code));
create index if not exists idx_community_reports_group on public.community_reports (group_key, created_at_utc asc);
create index if not exists idx_community_reports_regency on public.community_reports (regency_pum_code, category, moderation_status);

create or replace function public.generate_unique_report_code(
  p_category text,
  p_now timestamptz default now()
)
returns text
language plpgsql
security definer
as $$
declare
  v_prefix text := case when p_category = 'karhutla' then 'LAP-KH-' else 'LAP-KU-' end;
  v_date text := to_char(p_now at time zone 'Asia/Jakarta', 'YYYYMMDD');
  v_chars constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_bytes bytea;
  v_suffix text;
  v_code text;
  v_i integer;
begin
  loop
    v_bytes := gen_random_bytes(6);
    v_suffix := '';
    for v_i in 0..5 loop
      v_suffix := v_suffix || substr(v_chars, (get_byte(v_bytes, v_i) % 32) + 1, 1);
    end loop;
    v_code := v_prefix || v_date || '-' || v_suffix;
    exit when not exists (select 1 from public.community_reports where report_code = v_code);
  end loop;
  return v_code;
end;
$$;

create or replace function public.recalculate_report_group(p_group_key text)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_grp public.community_report_groups%rowtype;
  v_cnt integer := 0;
  v_approved_cnt integer := 0;
  v_eligible_cnt integer := 0;
  v_regency_eligible_kh integer := 0;
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
  select * into v_grp from public.community_report_groups where group_key = p_group_key;
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

  if v_cnt >= 5 then
    v_eligible_cnt := v_cnt;
  else
    v_eligible_cnt := v_approved_cnt;
  end if;

  if v_cnt <= 0 then
    v_tier := 0;
    v_qstatus := 'empty';
    v_promoted_at := null;
    v_notified_at := v_grp.threshold_notified_at_utc;
  elsif v_cnt = 1 then
    v_tier := 1;
    v_qstatus := 'active_queue';
    v_promoted_at := null;
    v_notified_at := v_grp.threshold_notified_at_utc;
  elsif v_cnt = 2 then
    v_tier := 2;
    v_qstatus := 'active_queue';
    v_promoted_at := null;
    v_notified_at := v_grp.threshold_notified_at_utc;
  elsif v_cnt in (3, 4) then
    v_tier := 3;
    v_qstatus := 'active_queue';
    v_promoted_at := null;
    v_notified_at := v_grp.threshold_notified_at_utc;
  else
    v_tier := 4;
    v_qstatus := 'promoted_supplementary';
    v_promoted_at := coalesce(v_grp.promoted_at_utc, now());
    if v_grp.threshold_notified_at_utc is null then
      v_notified_at := now();
      v_newly_notified := true;
    else
      v_notified_at := v_grp.threshold_notified_at_utc;
    end if;
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

  if v_grp.category = 'karhutla' then
    select coalesce(sum(eligible_report_count), 0)::integer
    into v_regency_eligible_kh
    from public.community_report_groups
    where regency_pum_code = v_grp.regency_pum_code
      and category = 'karhutla';
  elsif v_grp.category = 'kualitas_udara' then
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

create or replace function public.submit_community_report(
  p_reporter_name text,
  p_category text,
  p_province_pum_code text,
  p_province_name text,
  p_regency_pum_code text,
  p_regency_bps_code text,
  p_regency_name text,
  p_observed_at_utc timestamptz default null,
  p_description text default null,
  p_photo_storage_path text default null,
  p_photo_mime_type text default null,
  p_photo_size_bytes integer default null,
  p_air_decline_pct integer default null,
  p_air_duration_days integer default null,
  p_latitude double precision default null,
  p_longitude double precision default null
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_now timestamptz := now();
  v_clean_name text := trim(coalesce(p_reporter_name, ''));
  v_clean_desc text := nullif(trim(coalesce(p_description, '')), '');
  v_period_bucket text;
  v_group_key text;
  v_code text;
  v_report_id uuid;
  v_firms_match boolean := false;
  v_group_res jsonb;
begin
  if char_length(v_clean_name) < 2 or char_length(v_clean_name) > 80 then
    raise exception 'Nama pelapor wajib diisi (2 hingga 80 karakter).';
  end if;

  if p_category not in ('karhutla', 'kualitas_udara') then
    raise exception 'Jenis laporan tidak valid.';
  end if;

  if coalesce(trim(p_province_pum_code), '') = '' or coalesce(trim(p_regency_pum_code), '') = '' then
    raise exception 'Provinsi dan Kabupaten/Kota wajib dipilih.';
  end if;

  if p_category = 'karhutla' then
    if p_observed_at_utc is null then
      raise exception 'Waktu pengamatan Karhutla wajib diisi.';
    end if;
    if p_observed_at_utc > (v_now + interval '5 minutes') then
      raise exception 'Waktu pengamatan tidak boleh berada di masa depan.';
    end if;
    if v_clean_desc is null or char_length(v_clean_desc) < 5 or char_length(v_clean_desc) > 1000 then
      raise exception 'Deskripsi pengamatan wajib diisi (5 hingga 1000 karakter).';
    end if;
    v_period_bucket := to_char(p_observed_at_utc at time zone 'Asia/Jakarta', 'YYYY-MM-DD');

    if p_latitude is not null and p_longitude is not null then
      select exists (
        select 1
        from public.hotspot_detections hd
        where hd.regency_pum_code = p_regency_pum_code
          and hd.acq_timestamp_utc between (p_observed_at_utc - interval '24 hours') and (p_observed_at_utc + interval '24 hours')
          and ST_DWithin(hd.geom::geography, ST_SetSRID(ST_MakePoint(p_longitude, p_latitude), 4326)::geography, 15000)
      ) into v_firms_match;
    end if;
  else
    if p_air_decline_pct is null or p_air_decline_pct < 0 or p_air_decline_pct > 100 or (p_air_decline_pct % 10) <> 0 then
      raise exception 'Persentase penurunan kualitas udara harus dipilih antara 0%% hingga 100%% (kelipatan 10%%).';
    end if;
    if p_air_duration_days is null or p_air_duration_days < 1 or p_air_duration_days > 35 then
      raise exception 'Durasi penurunan kualitas udara harus dipilih antara 1 hingga 35 hari.';
    end if;
    v_period_bucket := 'W35D-' || to_char(date_trunc('month', v_now at time zone 'Asia/Jakarta'), 'YYYY-MM');
  end if;

  v_group_key := p_category || ':' || trim(p_regency_pum_code) || ':' || v_period_bucket;

  insert into public.community_report_groups (
    group_key, category, province_pum_code, province_name,
    regency_pum_code, regency_bps_code, regency_name, period_bucket,
    first_report_at_utc, last_report_at_utc
  )
  values (
    v_group_key, p_category, trim(p_province_pum_code), trim(p_province_name),
    trim(p_regency_pum_code), trim(coalesce(nullif(p_regency_bps_code, ''), replace(p_regency_pum_code, '.', ''))),
    trim(p_regency_name), v_period_bucket,
    v_now, v_now
  )
  on conflict (group_key) do nothing;

  v_code := public.generate_unique_report_code(p_category, v_now);

  insert into public.community_reports (
    report_code, group_key, reporter_name, category,
    province_pum_code, province_name, regency_pum_code, regency_bps_code, regency_name,
    observed_at_utc, description, photo_storage_path, photo_mime_type, photo_size_bytes,
    air_decline_pct, air_duration_days, latitude, longitude, firms_corroborated,
    moderation_status, created_at_utc
  )
  values (
    v_code, v_group_key, v_clean_name, p_category,
    trim(p_province_pum_code), trim(p_province_name),
    trim(p_regency_pum_code), trim(coalesce(nullif(p_regency_bps_code, ''), replace(p_regency_pum_code, '.', ''))),
    trim(p_regency_name),
    case when p_category = 'karhutla' then p_observed_at_utc else null end,
    case when p_category = 'karhutla' then v_clean_desc else null end,
    case when p_category = 'karhutla' then p_photo_storage_path else null end,
    case when p_category = 'karhutla' then p_photo_mime_type else null end,
    case when p_category = 'karhutla' then p_photo_size_bytes else null end,
    case when p_category = 'kualitas_udara' then p_air_decline_pct else null end,
    case when p_category = 'kualitas_udara' then p_air_duration_days else null end,
    p_latitude, p_longitude, v_firms_match,
    'valid', v_now
  )
  returning report_id into v_report_id;

  v_group_res := public.recalculate_report_group(v_group_key);

  return jsonb_build_object(
    'status', 'ok',
    'report_id', v_report_id,
    'report_code', v_code,
    'category', p_category,
    'province_pum_code', trim(p_province_pum_code),
    'province_name', trim(p_province_name),
    'regency_pum_code', trim(p_regency_pum_code),
    'regency_name', trim(p_regency_name),
    'created_at_utc', v_now,
    'group', v_group_res
  );
end;
$$;

create or replace function public.moderate_community_report(
  p_report_id uuid,
  p_new_status text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_uid uuid := auth.uid();
  v_group_key text;
  v_code text;
  v_group_res jsonb;
begin
  if v_uid is null or not exists (
    select 1 from public.moderator_profiles
    where user_id = v_uid and is_active = true
  ) then
    raise exception 'Akses ditolak: Hanya moderator berwenang yang dapat mengubah status laporan.';
  end if;

  if p_new_status not in ('approved', 'rejected', 'valid') then
    raise exception 'Status moderasi tidak valid.';
  end if;

  update public.community_reports set
    moderation_status = p_new_status,
    moderated_at_utc = now(),
    moderated_by = v_uid,
    moderation_note = nullif(trim(coalesce(p_note, '')), '')
  where report_id = p_report_id
  returning group_key, report_code into v_group_key, v_code;

  if not found then
    raise exception 'Laporan tidak ditemukan.';
  end if;

  v_group_res := public.recalculate_report_group(v_group_key);

  return jsonb_build_object(
    'status', 'ok',
    'report_id', p_report_id,
    'report_code', v_code,
    'moderation_status', p_new_status,
    'group', v_group_res
  );
end;
$$;

create or replace view public.public_community_reports_view as
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
  (r.photo_storage_path is not null) as has_photo,
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

alter table public.moderator_profiles enable row level security;
alter table public.community_report_groups enable row level security;
alter table public.community_reports enable row level security;

create policy "allow_public_read_report_groups" on public.community_report_groups
  for select using (true);

create policy "allow_moderator_read_all_reports" on public.community_reports
  for select using (
    exists (
      select 1 from public.moderator_profiles mp
      where mp.user_id = auth.uid() and mp.is_active = true
    )
  );

create policy "allow_moderator_read_own_profile" on public.moderator_profiles
  for select using (user_id = auth.uid());

grant select on public.public_community_reports_view to anon, authenticated;
grant select on public.community_report_groups to anon, authenticated;
grant execute on function public.submit_community_report to anon, authenticated;
grant execute on function public.moderate_community_report to authenticated;
