-- Commit enum additions before using them in constraints or data.
alter type public.app_role add value if not exists 'salesperson';
alter type public.app_role add value if not exists 'management';
