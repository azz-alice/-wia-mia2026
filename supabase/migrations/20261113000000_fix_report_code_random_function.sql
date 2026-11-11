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
    v_bytes := extensions.gen_random_bytes(6);
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
