-- Table for Google Ads Call Details, one row per call.
-- Unique on (start_time, caller_phone_number) so upserts are idempotent
-- and re-running the sync never creates duplicates.

create table if not exists public.google_ads_call_details (
    id                      bigserial primary key,
    start_time              timestamptz not null,
    duration_seconds        integer,
    caller_country_code     text,
    caller_area_code        text,
    caller_phone_number     text,
    status                  text,
    call_source             text,
    call_type               text,
    campaign                text,
    ad_group                text,
    imported_at             timestamptz not null default now(),
    constraint google_ads_call_details_unique
        unique (start_time, caller_phone_number)
);

create index if not exists google_ads_call_details_start_time_idx
    on public.google_ads_call_details (start_time desc);

create index if not exists google_ads_call_details_campaign_idx
    on public.google_ads_call_details (campaign);
