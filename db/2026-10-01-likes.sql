-- MIN-160. Likes on approved wishes, one per client_id per wish.
-- Run once in the Neon SQL editor, after 2026-09-29-social-approval.sql.
--
-- What a wish shows is likes + seed_likes, computed in one place
-- (api/_lib/likes.js). seed_likes stays 0 until MIN-193 fills it.
alter table wishes add column if not exists seed_likes int not null default 0;
alter table wishes add constraint wishes_seed_likes_check check (seed_likes >= 0);

create table if not exists likes (
  wish_id    bigint      not null references wishes (id) on delete cascade,
  client_id  uuid        not null,
  ip_hash    text,
  created_at timestamptz not null default now(),
  constraint likes_wish_client_key unique (wish_id, client_id)
);
create index if not exists likes_client_idx  on likes (client_id);
create index if not exists likes_ip_idx      on likes (ip_hash, created_at);
create index if not exists likes_wish_ip_idx on likes (wish_id, ip_hash);
