-- MIN-123/MIN-183. All existing and future wishes start pending and private.
-- Keep approved_at NULL after rejection or hiding so PR #16's current GET
-- (which checks approved_at) cannot accidentally expose a hidden wish.
alter table wishes add column if not exists moderation_status text not null default 'pending';
alter table wishes add column if not exists reviewed_at timestamptz;
alter table wishes add column if not exists approved_at timestamptz;

alter table wishes add constraint wishes_moderation_status_check
  check (moderation_status in ('pending', 'approved', 'rejected', 'hidden'));
alter table wishes add constraint wishes_approval_consistency
  check ((moderation_status = 'approved') = (approved_at is not null));

create index if not exists wishes_moderation_approved_idx
  on wishes (id desc) where moderation_status = 'approved';
