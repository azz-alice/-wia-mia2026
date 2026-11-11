alter table public.community_reports
  add column if not exists moderated_by_admin_email text;

create or replace function public.moderate_community_report_admin(
  p_report_id uuid,
  p_new_status text,
  p_note text default null,
  p_admin_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_group_key text;
  v_code text;
  v_regency_code text;
  v_group_res jsonb;
  v_email text := lower(trim(coalesce(p_admin_email, '')));
begin
  if v_email = '' then
    raise exception 'Email admin wajib tersedia.';
  end if;
  if p_new_status not in ('approved', 'rejected', 'valid') then
    raise exception 'Status moderasi tidak valid.';
  end if;

  select group_key, report_code, regency_pum_code
  into v_group_key, v_code, v_regency_code
  from public.community_reports
  where report_id = p_report_id
  for update;

  if not found then
    raise exception 'Laporan tidak ditemukan.';
  end if;

  update public.community_reports
  set moderation_status = p_new_status,
      moderated_at_utc = now(),
      moderated_by = null,
      moderated_by_admin_email = v_email,
      moderation_note = nullif(trim(coalesce(p_note, '')), '')
  where report_id = p_report_id;

  v_group_res := public.recalculate_report_group(v_group_key);

  return jsonb_build_object(
    'status', 'ok',
    'report_id', p_report_id,
    'report_code', v_code,
    'regency_pum_code', v_regency_code,
    'moderation_status', p_new_status,
    'group', v_group_res
  );
end;
$$;

revoke all on function public.moderate_community_report_admin(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.moderate_community_report_admin(uuid, text, text, text) to service_role;
