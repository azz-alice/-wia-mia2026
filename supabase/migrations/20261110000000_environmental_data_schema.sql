create extension if not exists postgis;
create extension if not exists pg_cron;
create extension if not exists pg_net;

create table if not exists public.admin_regions (
  regency_pum_code text primary key,
  regency_bps_code text not null unique,
  regency_name text not null,
  admin_type text not null check (admin_type in ('Kabupaten', 'Kota')),
  province_pum_code text not null,
  province_bps_code text not null,
  province_name text not null,
  source_objectid integer,
  geom geometry(MultiPolygon, 4326) not null,
  updated_at_utc timestamptz not null default now()
);

create index if not exists idx_admin_regions_geom on public.admin_regions using gist (geom);
create index if not exists idx_admin_regions_province_pum on public.admin_regions (province_pum_code);
create index if not exists idx_admin_regions_bps on public.admin_regions (regency_bps_code);

create table if not exists public.hotspot_detections (
  detection_id text primary key,
  product text not null default 'VIIRS_SNPP_NRT',
  regency_pum_code text references public.admin_regions(regency_pum_code) on delete set null,
  regency_bps_code text,
  province_pum_code text,
  latitude double precision not null check (latitude between -12.0 and 7.0),
  longitude double precision not null check (longitude between 94.0 and 142.0),
  bright_ti4 numeric,
  bright_ti5 numeric,
  frp numeric,
  confidence text,
  satellite text,
  instrument text,
  daynight text,
  acq_timestamp_utc timestamptz not null,
  ingested_at_utc timestamptz not null default now(),
  geom geometry(Point, 4326) not null
);

create index if not exists idx_hotspot_regency_acq on public.hotspot_detections (regency_pum_code, acq_timestamp_utc desc);
create index if not exists idx_hotspot_acq on public.hotspot_detections (acq_timestamp_utc desc);
create index if not exists idx_hotspot_geom on public.hotspot_detections using gist (geom);

create table if not exists public.air_stations (
  sensor_id bigint primary key,
  location_id bigint not null,
  station_name text not null,
  regency_pum_code text references public.admin_regions(regency_pum_code) on delete set null,
  regency_bps_code text,
  province_pum_code text,
  latitude double precision not null check (latitude between -12.0 and 7.0),
  longitude double precision not null check (longitude between 94.0 and 142.0),
  parameter_name text not null default 'pm25',
  unit text not null default 'µg/m³' check (unit in ('µg/m³', 'ug/m3')),
  is_active boolean not null default true,
  last_seen_utc timestamptz,
  updated_at_utc timestamptz not null default now(),
  geom geometry(Point, 4326) not null
);

create index if not exists idx_air_stations_regency on public.air_stations (regency_pum_code);
create index if not exists idx_air_stations_location on public.air_stations (location_id);
create index if not exists idx_air_stations_geom on public.air_stations using gist (geom);

create table if not exists public.air_measurements (
  measurement_id text primary key,
  sensor_id bigint not null references public.air_stations(sensor_id) on delete cascade,
  regency_pum_code text references public.admin_regions(regency_pum_code) on delete set null,
  value_ugm3 numeric not null check (value_ugm3 >= 0 and value_ugm3 <= 2000),
  coverage_pct numeric,
  period_start_utc timestamptz not null,
  period_end_utc timestamptz not null,
  ingested_at_utc timestamptz not null default now()
);

create index if not exists idx_air_measurements_sensor_end on public.air_measurements (sensor_id, period_end_utc desc);
create index if not exists idx_air_measurements_regency_end on public.air_measurements (regency_pum_code, period_end_utc desc);

create table if not exists public.community_air_reports (
  report_id uuid primary key default gen_random_uuid(),
  regency_pum_code text not null references public.admin_regions(regency_pum_code) on delete cascade,
  regency_bps_code text not null,
  perception_pct integer not null check (perception_pct between 0 and 100 and perception_pct % 10 = 0),
  duration_days integer not null check (duration_days between 1 and 35),
  notes text,
  reported_at_utc timestamptz not null default now(),
  expires_at_utc timestamptz not null default (now() + interval '7 days')
);

create index if not exists idx_community_reports_regency on public.community_air_reports (regency_pum_code, reported_at_utc desc);

create table if not exists public.data_sync_status (
  source_name text primary key check (source_name in ('nasa_firms', 'openaq_pm25')),
  product_info text not null,
  schedule_minutes integer not null default 60,
  last_attempt_utc timestamptz,
  last_success_utc timestamptz,
  last_observation_utc timestamptz,
  sync_state text not null default 'pending' check (sync_state in ('ok', 'stale', 'error', 'pending')),
  http_status integer,
  records_received integer not null default 0,
  records_matched integer not null default 0,
  error_code text,
  error_message text,
  updated_at_utc timestamptz not null default now()
);

insert into public.data_sync_status (source_name, product_info, schedule_minutes, sync_state)
values
  ('nasa_firms', 'VIIRS_SNPP_NRT (Area API 94,-12,142,7 / 1 day)', 60, 'pending'),
  ('openaq_pm25', 'OpenAQ v3 PM2.5 (µg/m³ 24h ISPU)', 60, 'pending')
on conflict (source_name) do nothing;

create table if not exists public.city_environment_summary (
  regency_pum_code text primary key references public.admin_regions(regency_pum_code) on delete cascade,
  regency_bps_code text not null unique,
  regency_name text not null,
  admin_type text not null,
  province_pum_code text not null,
  province_bps_code text not null,
  province_name text not null,
  hotspot_count_24h integer,
  hotspot_category text not null default 'Belum tersedia',
  hotspot_status text not null default 'no_data' check (hotspot_status in ('ok', 'no_data', 'stale', 'error')),
  hotspot_last_obs_utc timestamptz,
  hotspot_synced_utc timestamptz,
  pm25_24h_ugm3 numeric(8,2),
  ispu_category text not null default 'No Data',
  pm25_station_count integer not null default 0,
  pm25_valid_station_count integer not null default 0,
  pm25_status text not null default 'no_data' check (pm25_status in ('ok', 'insufficient_data', 'no_data', 'stale', 'error')),
  pm25_last_obs_utc timestamptz,
  pm25_synced_utc timestamptz,
  community_report_count integer not null default 0,
  community_perception_avg_pct numeric(5,1),
  community_duration_avg_days numeric(4,1),
  community_last_report_utc timestamptz,
  updated_at_utc timestamptz not null default now()
);

create index if not exists idx_summary_province_pum on public.city_environment_summary (province_pum_code);
create index if not exists idx_summary_bps on public.city_environment_summary (regency_bps_code);

create or replace function public.classify_hotspot_24h(p_count integer, p_status text)
returns text
language plpgsql
immutable
as $$
begin
  if p_status = 'no_data' or p_count is null then
    return 'Belum tersedia';
  elsif p_status = 'error' and p_count is null then
    return 'Gagal diperbarui';
  elsif p_count <= 0 then
    return 'Tidak ada deteksi';
  elsif p_count <= 5 then
    return 'Rendah';
  elsif p_count <= 20 then
    return 'Sedang';
  elsif p_count <= 50 then
    return 'Tinggi';
  else
    return 'Sangat tinggi';
  end if;
end;
$$;

create or replace function public.classify_ispu_pm25_24h(p_ugm3 numeric, p_status text)
returns text
language plpgsql
immutable
as $$
begin
  if p_status = 'no_data' then
    return 'No Data';
  elsif p_status = 'insufficient_data' then
    return 'Data tidak mencukupi';
  elsif p_ugm3 is null then
    return 'No Data';
  elsif p_ugm3 <= 15.5 then
    return 'Baik';
  elsif p_ugm3 <= 55.4 then
    return 'Sedang';
  elsif p_ugm3 <= 150.4 then
    return 'Tidak sehat';
  elsif p_ugm3 <= 250.4 then
    return 'Sangat tidak sehat';
  else
    return 'Berbahaya';
  end if;
end;
$$;

create or replace function public.ingest_firms_hotspots(
  p_rows jsonb,
  p_synced_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_received integer := 0;
  v_matched integer := 0;
  v_last_obs timestamptz;
  v_window_start timestamptz := p_synced_at - interval '24 hours';
begin
  if jsonb_typeof(p_rows) = 'array' then
    v_received := jsonb_array_length(p_rows);
  end if;

  with raw_points as (
    select
      coalesce(r->>'product', 'VIIRS_SNPP_NRT') as product,
      (r->>'latitude')::double precision as latitude,
      (r->>'longitude')::double precision as longitude,
      nullif(r->>'bright_ti4', '')::numeric as bright_ti4,
      nullif(r->>'bright_ti5', '')::numeric as bright_ti5,
      nullif(r->>'frp', '')::numeric as frp,
      r->>'confidence' as confidence,
      r->>'satellite' as satellite,
      r->>'instrument' as instrument,
      r->>'daynight' as daynight,
      (r->>'acq_timestamp_utc')::timestamptz as acq_timestamp_utc,
      ST_SetSRID(ST_MakePoint((r->>'longitude')::double precision, (r->>'latitude')::double precision), 4326) as pt
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as r
    where (r->>'latitude') is not null
      and (r->>'longitude') is not null
      and (r->>'acq_timestamp_utc') is not null
      and (r->>'latitude')::double precision between -12.0 and 7.0
      and (r->>'longitude')::double precision between 94.0 and 142.0
  ),
  matched_points as (
    select
      rp.product || ':' || round(rp.latitude::numeric, 4) || ':' || round(rp.longitude::numeric, 4) || ':' || to_char(rp.acq_timestamp_utc at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as detection_id,
      rp.product,
      ar.regency_pum_code,
      ar.regency_bps_code,
      ar.province_pum_code,
      rp.latitude,
      rp.longitude,
      rp.bright_ti4,
      rp.bright_ti5,
      rp.frp,
      rp.confidence,
      rp.satellite,
      rp.instrument,
      rp.daynight,
      rp.acq_timestamp_utc,
      rp.pt
    from raw_points rp
    inner join public.admin_regions ar
      on ST_Covers(ar.geom, rp.pt)
  ),
  upserted as (
    insert into public.hotspot_detections (
      detection_id, product, regency_pum_code, regency_bps_code, province_pum_code,
      latitude, longitude, bright_ti4, bright_ti5, frp, confidence,
      satellite, instrument, daynight, acq_timestamp_utc, ingested_at_utc, geom
    )
    select distinct on (detection_id)
      detection_id, product, regency_pum_code, regency_bps_code, province_pum_code,
      latitude, longitude, bright_ti4, bright_ti5, frp, confidence,
      satellite, instrument, daynight, acq_timestamp_utc, p_synced_at, pt
    from matched_points
    on conflict (detection_id) do update set
      ingested_at_utc = excluded.ingested_at_utc,
      frp = coalesce(excluded.frp, public.hotspot_detections.frp),
      confidence = coalesce(excluded.confidence, public.hotspot_detections.confidence)
    returning detection_id, acq_timestamp_utc
  )
  select count(*), max(acq_timestamp_utc)
  into v_matched, v_last_obs
  from upserted;

  delete from public.hotspot_detections
  where acq_timestamp_utc < (p_synced_at - interval '7 days');

  select max(acq_timestamp_utc)
  into v_last_obs
  from public.hotspot_detections
  where acq_timestamp_utc >= v_window_start;

  with agg as (
    select
      ar.regency_pum_code,
      ar.regency_bps_code,
      ar.regency_name,
      ar.admin_type,
      ar.province_pum_code,
      ar.province_bps_code,
      ar.province_name,
      count(hd.detection_id)::integer as cnt_24h,
      max(hd.acq_timestamp_utc) as max_obs_utc
    from public.admin_regions ar
    left join public.hotspot_detections hd
      on hd.regency_pum_code = ar.regency_pum_code
      and hd.acq_timestamp_utc >= v_window_start
      and hd.acq_timestamp_utc <= p_synced_at
    group by
      ar.regency_pum_code, ar.regency_bps_code, ar.regency_name,
      ar.admin_type, ar.province_pum_code, ar.province_bps_code, ar.province_name
  )
  insert into public.city_environment_summary (
    regency_pum_code, regency_bps_code, regency_name, admin_type,
    province_pum_code, province_bps_code, province_name,
    hotspot_count_24h, hotspot_category, hotspot_status,
    hotspot_last_obs_utc, hotspot_synced_utc, updated_at_utc
  )
  select
    a.regency_pum_code,
    a.regency_bps_code,
    a.regency_name,
    a.admin_type,
    a.province_pum_code,
    a.province_bps_code,
    a.province_name,
    a.cnt_24h,
    public.classify_hotspot_24h(a.cnt_24h, 'ok'),
    'ok',
    coalesce(a.max_obs_utc, v_last_obs),
    p_synced_at,
    p_synced_at
  from agg a
  on conflict (regency_pum_code) do update set
    hotspot_count_24h = excluded.hotspot_count_24h,
    hotspot_category = excluded.hotspot_category,
    hotspot_status = 'ok',
    hotspot_last_obs_utc = excluded.hotspot_last_obs_utc,
    hotspot_synced_utc = excluded.hotspot_synced_utc,
    updated_at_utc = excluded.updated_at_utc;

  update public.data_sync_status set
    last_attempt_utc = p_synced_at,
    last_success_utc = p_synced_at,
    last_observation_utc = coalesce(v_last_obs, last_observation_utc),
    sync_state = 'ok',
    http_status = 200,
    records_received = v_received,
    records_matched = v_matched,
    error_code = null,
    error_message = null,
    updated_at_utc = p_synced_at
  where source_name = 'nasa_firms';

  return jsonb_build_object(
    'status', 'ok',
    'records_received', v_received,
    'records_matched', v_matched,
    'last_observation_utc', v_last_obs,
    'synced_at_utc', p_synced_at
  );
end;
$$;

create or replace function public.ingest_openaq_pm25(
  p_stations jsonb,
  p_measurements jsonb,
  p_synced_at timestamptz default now(),
  p_min_hourly_obs integer default 18,
  p_max_stale_hours integer default 6
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_stations_in integer := 0;
  v_meas_in integer := 0;
  v_last_obs timestamptz;
  v_window_start timestamptz := p_synced_at - interval '24 hours';
  v_stale_cutoff timestamptz := p_synced_at - make_interval(hours => p_max_stale_hours);
begin
  if jsonb_typeof(p_stations) = 'array' then
    v_stations_in := jsonb_array_length(p_stations);
  end if;
  if jsonb_typeof(p_measurements) = 'array' then
    v_meas_in := jsonb_array_length(p_measurements);
  end if;

  with raw_stations as (
    select
      (s->>'sensor_id')::bigint as sensor_id,
      (s->>'location_id')::bigint as location_id,
      coalesce(nullif(s->>'station_name', ''), 'OpenAQ Station ' || (s->>'location_id')) as station_name,
      (s->>'latitude')::double precision as latitude,
      (s->>'longitude')::double precision as longitude,
      coalesce(nullif(s->>'unit', ''), 'µg/m³') as unit,
      (s->>'last_seen_utc')::timestamptz as last_seen_utc,
      ST_SetSRID(ST_MakePoint((s->>'longitude')::double precision, (s->>'latitude')::double precision), 4326) as pt
    from jsonb_array_elements(coalesce(p_stations, '[]'::jsonb)) as s
    where (s->>'sensor_id') is not null
      and (s->>'location_id') is not null
      and (s->>'latitude') is not null
      and (s->>'longitude') is not null
      and (s->>'latitude')::double precision between -12.0 and 7.0
      and (s->>'longitude')::double precision between 94.0 and 142.0
      and coalesce(s->>'unit', 'µg/m³') in ('µg/m³', 'ug/m3')
  ),
  matched_stations as (
    select distinct on (rs.sensor_id)
      rs.sensor_id,
      rs.location_id,
      rs.station_name,
      ar.regency_pum_code,
      ar.regency_bps_code,
      ar.province_pum_code,
      rs.latitude,
      rs.longitude,
      'µg/m³'::text as unit,
      rs.last_seen_utc,
      rs.pt
    from raw_stations rs
    inner join public.admin_regions ar
      on ST_Covers(ar.geom, rs.pt)
  )
  insert into public.air_stations (
    sensor_id, location_id, station_name, regency_pum_code, regency_bps_code,
    province_pum_code, latitude, longitude, parameter_name, unit,
    is_active, last_seen_utc, updated_at_utc, geom
  )
  select
    sensor_id, location_id, station_name, regency_pum_code, regency_bps_code,
    province_pum_code, latitude, longitude, 'pm25', unit,
    true, last_seen_utc, p_synced_at, pt
  from matched_stations
  on conflict (sensor_id) do update set
    station_name = excluded.station_name,
    regency_pum_code = excluded.regency_pum_code,
    regency_bps_code = excluded.regency_bps_code,
    province_pum_code = excluded.province_pum_code,
    last_seen_utc = coalesce(excluded.last_seen_utc, public.air_stations.last_seen_utc),
    updated_at_utc = excluded.updated_at_utc;

  with raw_meas as (
    select
      (m->>'sensor_id')::bigint as sensor_id,
      (m->>'value_ugm3')::numeric as value_ugm3,
      nullif(m->>'coverage_pct', '')::numeric as coverage_pct,
      (m->>'period_start_utc')::timestamptz as period_start_utc,
      (m->>'period_end_utc')::timestamptz as period_end_utc
    from jsonb_array_elements(coalesce(p_measurements, '[]'::jsonb)) as m
    where (m->>'sensor_id') is not null
      and (m->>'value_ugm3') is not null
      and (m->>'period_start_utc') is not null
      and (m->>'period_end_utc') is not null
      and (m->>'value_ugm3')::numeric >= 0
      and (m->>'value_ugm3')::numeric <= 2000
  )
  insert into public.air_measurements (
    measurement_id, sensor_id, regency_pum_code, value_ugm3,
    coverage_pct, period_start_utc, period_end_utc, ingested_at_utc
  )
  select distinct on (rm.sensor_id, rm.period_end_utc)
    rm.sensor_id || ':' || to_char(rm.period_end_utc at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    rm.sensor_id,
    st.regency_pum_code,
    rm.value_ugm3,
    rm.coverage_pct,
    rm.period_start_utc,
    rm.period_end_utc,
    p_synced_at
  from raw_meas rm
  inner join public.air_stations st
    on st.sensor_id = rm.sensor_id
  on conflict (measurement_id) do update set
    value_ugm3 = excluded.value_ugm3,
    coverage_pct = coalesce(excluded.coverage_pct, public.air_measurements.coverage_pct),
    ingested_at_utc = excluded.ingested_at_utc;

  delete from public.air_measurements
  where period_end_utc < (p_synced_at - interval '7 days');

  select max(period_end_utc)
  into v_last_obs
  from public.air_measurements
  where period_end_utc >= v_window_start;

  with station_24h as (
    select
      st.regency_pum_code,
      st.location_id,
      st.sensor_id,
      count(am.measurement_id)::integer as obs_count,
      avg(am.value_ugm3) as station_avg_ugm3,
      max(am.period_end_utc) as station_last_obs_utc
    from public.air_stations st
    left join public.air_measurements am
      on am.sensor_id = st.sensor_id
      and am.period_end_utc >= v_window_start
      and am.period_end_utc <= p_synced_at
    where st.is_active = true
      and st.regency_pum_code is not null
    group by st.regency_pum_code, st.location_id, st.sensor_id
  ),
  dedup_location_24h as (
    select distinct on (regency_pum_code, location_id)
      regency_pum_code,
      location_id,
      obs_count,
      station_avg_ugm3,
      station_last_obs_utc,
      (obs_count >= p_min_hourly_obs and station_last_obs_utc >= v_stale_cutoff) as is_valid_24h,
      (obs_count >= p_min_hourly_obs and station_last_obs_utc < v_stale_cutoff) as is_stale_24h
    from station_24h
    order by regency_pum_code, location_id, obs_count desc, station_last_obs_utc desc nulls last
  ),
  regency_air as (
    select
      ar.regency_pum_code,
      ar.regency_bps_code,
      ar.regency_name,
      ar.admin_type,
      ar.province_pum_code,
      ar.province_bps_code,
      ar.province_name,
      count(dl.location_id)::integer as total_stations,
      count(dl.location_id) filter (where dl.is_valid_24h)::integer as valid_stations,
      count(dl.location_id) filter (where dl.is_stale_24h)::integer as stale_stations,
      round(avg(dl.station_avg_ugm3) filter (where dl.is_valid_24h), 2) as regency_pm25_ugm3,
      round(avg(dl.station_avg_ugm3) filter (where dl.is_stale_24h), 2) as stale_pm25_ugm3,
      max(dl.station_last_obs_utc) as max_obs_utc
    from public.admin_regions ar
    left join dedup_location_24h dl
      on dl.regency_pum_code = ar.regency_pum_code
    group by
      ar.regency_pum_code, ar.regency_bps_code, ar.regency_name,
      ar.admin_type, ar.province_pum_code, ar.province_bps_code, ar.province_name
  )
  insert into public.city_environment_summary (
    regency_pum_code, regency_bps_code, regency_name, admin_type,
    province_pum_code, province_bps_code, province_name,
    pm25_24h_ugm3, ispu_category, pm25_station_count, pm25_valid_station_count,
    pm25_status, pm25_last_obs_utc, pm25_synced_utc, updated_at_utc
  )
  select
    ra.regency_pum_code,
    ra.regency_bps_code,
    ra.regency_name,
    ra.admin_type,
    ra.province_pum_code,
    ra.province_bps_code,
    ra.province_name,
    case
      when ra.valid_stations > 0 then ra.regency_pm25_ugm3
      when ra.stale_stations > 0 then ra.stale_pm25_ugm3
      else null
    end as pm25_val,
    case
      when ra.total_stations = 0 then 'No Data'
      when ra.valid_stations > 0 then public.classify_ispu_pm25_24h(ra.regency_pm25_ugm3, 'ok')
      when ra.stale_stations > 0 then public.classify_ispu_pm25_24h(ra.stale_pm25_ugm3, 'stale')
      else 'Data tidak mencukupi'
    end as ispu_cat,
    ra.total_stations,
    ra.valid_stations,
    case
      when ra.total_stations = 0 then 'no_data'
      when ra.valid_stations > 0 then 'ok'
      when ra.stale_stations > 0 then 'stale'
      else 'insufficient_data'
    end as pm25_st,
    ra.max_obs_utc,
    p_synced_at,
    p_synced_at
  from regency_air ra
  on conflict (regency_pum_code) do update set
    pm25_24h_ugm3 = excluded.pm25_24h_ugm3,
    ispu_category = excluded.ispu_category,
    pm25_station_count = excluded.pm25_station_count,
    pm25_valid_station_count = excluded.pm25_valid_station_count,
    pm25_status = excluded.pm25_status,
    pm25_last_obs_utc = excluded.pm25_last_obs_utc,
    pm25_synced_utc = excluded.pm25_synced_utc,
    updated_at_utc = excluded.updated_at_utc;

  update public.data_sync_status set
    last_attempt_utc = p_synced_at,
    last_success_utc = p_synced_at,
    last_observation_utc = coalesce(v_last_obs, last_observation_utc),
    sync_state = 'ok',
    http_status = 200,
    records_received = v_meas_in,
    records_matched = v_stations_in,
    error_code = null,
    error_message = null,
    updated_at_utc = p_synced_at
  where source_name = 'openaq_pm25';

  return jsonb_build_object(
    'status', 'ok',
    'stations_received', v_stations_in,
    'measurements_received', v_meas_in,
    'last_observation_utc', v_last_obs,
    'synced_at_utc', p_synced_at
  );
end;
$$;

create or replace function public.refresh_community_perception_summary(p_now timestamptz default now())
returns void
language plpgsql
security definer
as $$
begin
  with comm as (
    select
      ar.regency_pum_code,
      count(cr.report_id)::integer as report_cnt,
      round(avg(cr.perception_pct)::numeric, 1) as avg_pct,
      round(avg(cr.duration_days)::numeric, 1) as avg_days,
      max(cr.reported_at_utc) as last_rep
    from public.admin_regions ar
    left join public.community_air_reports cr
      on cr.regency_pum_code = ar.regency_pum_code
      and cr.expires_at_utc >= p_now
    group by ar.regency_pum_code
  )
  update public.city_environment_summary ces set
    community_report_count = comm.report_cnt,
    community_perception_avg_pct = comm.avg_pct,
    community_duration_avg_days = comm.avg_days,
    community_last_report_utc = comm.last_rep,
    updated_at_utc = p_now
  from comm
  where ces.regency_pum_code = comm.regency_pum_code;
end;
$$;

create or replace function public.mark_sync_failure(
  p_source text,
  p_http_status integer,
  p_error_code text,
  p_error_message text,
  p_attempted_at timestamptz default now()
)
returns void
language plpgsql
security definer
as $$
begin
  update public.data_sync_status set
    last_attempt_utc = p_attempted_at,
    sync_state = 'error',
    http_status = p_http_status,
    error_code = p_error_code,
    error_message = left(coalesce(p_error_message, 'Unknown sync error'), 500),
    updated_at_utc = p_attempted_at
  where source_name = p_source;

  if p_source = 'nasa_firms' then
    update public.city_environment_summary set
      hotspot_status = case
        when hotspot_count_24h is null then 'error'
        when hotspot_synced_utc < (p_attempted_at - interval '3 hours') then 'stale'
        else hotspot_status
      end,
      hotspot_category = case
        when hotspot_count_24h is null then 'Gagal diperbarui'
        else hotspot_category
      end
    where hotspot_status <> 'error';
  elsif p_source = 'openaq_pm25' then
    update public.city_environment_summary set
      pm25_status = case
        when pm25_24h_ugm3 is not null and pm25_synced_utc < (p_attempted_at - interval '3 hours') then 'stale'
        when pm25_station_count = 0 then 'no_data'
        else pm25_status
      end
    where pm25_status <> 'error';
  end if;
end;
$$;

alter table public.admin_regions enable row level security;
alter table public.city_environment_summary enable row level security;
alter table public.data_sync_status enable row level security;
alter table public.hotspot_detections enable row level security;
alter table public.air_stations enable row level security;
alter table public.air_measurements enable row level security;
alter table public.community_air_reports enable row level security;

create policy "allow_public_read_summary" on public.city_environment_summary
  for select using (true);

create policy "allow_public_read_sync_status" on public.data_sync_status
  for select using (true);

create policy "allow_public_read_community_reports" on public.community_air_reports
  for select using (true);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.city_environment_summary;
    exception when duplicate_object then
      null;
    end;
    begin
      alter publication supabase_realtime add table public.data_sync_status;
    exception when duplicate_object then
      null;
    end;
  end if;
end
$$;
