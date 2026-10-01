create table wishes (
  id                bigserial primary key,
  wish_text         text        not null,
  created_at        timestamptz not null default now(),
  char_length       int         not null,
  locale            text,
  tz_offset         int,
  country           text,
  device_type       text,
  referrer          text,
  utm_source        text,
  snap_to_submit_ms int,
  client_id         uuid        not null,
  app_version       text,
  ip_hash           text,
  moderation_status text        not null default 'pending',
  reviewed_at       timestamptz,
  approved_at       timestamptz,
  is_private        boolean     not null default false, -- MIN-194: never on the public feed
  constraint wishes_moderation_status_check check (
    moderation_status in ('pending', 'approved', 'rejected', 'hidden')
  ),
  constraint wishes_approval_consistency check (
    (moderation_status = 'approved') = (approved_at is not null)
  )
);
create index wishes_client_idx on wishes (client_id, created_at);
create index wishes_ip_idx     on wishes (ip_hash, created_at);
create index wishes_moderation_approved_idx on wishes (id desc) where moderation_status = 'approved';

-- MIN-158: emails left under "See others' wishes", apart from the wishes.
-- One row per client_id (the same id the wish is stored with); asking again
-- replaces the address and the time. Deleted 6 months after consented_at.
create table social_interest (
  email        text        not null,
  client_id    uuid        primary key,
  consented_at timestamptz not null default now()
);
