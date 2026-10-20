-- The content role is independent from "admin", the existing site manager.
-- Commit this enum addition before applying its permissions migration.
alter type public.app_role add value if not exists 'administrator';
