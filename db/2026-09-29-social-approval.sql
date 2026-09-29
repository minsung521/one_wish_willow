-- Run before enabling the social feed. Existing and new wishes remain private.
alter table wishes add column if not exists approved_at timestamptz;
create index if not exists wishes_approved_idx
  on wishes (id desc) where approved_at is not null;
