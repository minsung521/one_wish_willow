-- MIN-194: a wish can be kept private by its maker at submit time.
-- Independent of moderation_status: a private wish never reaches the public
-- feed (api/social.js), even if it is approved. Existing rows are all public
-- candidates (false), as before.
-- Not applied to production by the code change: run it on Neon as a separate step.
alter table wishes add column if not exists is_private boolean not null default false;
