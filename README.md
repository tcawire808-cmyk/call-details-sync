# TCA Google Ads Call Details Sync

Pulls the Google Ads "Call Details" report (including caller phone numbers,
which the Google Ads API doesn't expose) into Supabase on a schedule.
Runs entirely on GitHub Actions. No VPS.

**Target Gmail / Google Ads login:** `tcawire808@gmail.com` (Admin on the TCA Google Ads account).

---

## Architecture

```
GitHub Actions cron  →  Playwright (stealth) on ubuntu-latest
                        ├─ opens saved Google Ads Call Details report
                        │  (reuses saved Google session; TOTP fallback if expired)
                        ├─ clicks Download → .xlsx
                        └─ parses xlsx → upserts to Supabase
                                         (table: google_ads_call_details,
                                          unique on start_time + caller_phone_number)
```

## One-time setup

### 1. Supabase

```bash
psql $DATABASE_URL -f supabase/schema.sql
```

Grab the project URL and the **service role key** (NOT the anon key — RLS would block the insert otherwise).

### 2. 2FA on tcawire808@gmail.com with a saved TOTP secret

This is the critical step. The script needs the base32 secret, not the
rotating 6-digit code.

1. Sign into `tcawire808@gmail.com`.
2. Go to **Security → 2-Step Verification → Authenticator app → Set up**.
3. When Google shows the QR code, click **"Can't scan it?"** to reveal the
   base32 secret (looks like `JBSWY3DPEHPK3PXP`). Copy it.
4. Also scan the QR into Authy/1Password/Google Authenticator so a human can
   fall back if anything breaks.
5. Finish enrollment.

### 3. Get the Google Ads Call Details saved report URL

1. Log into Google Ads as `tcawire808@gmail.com`.
2. Open the saved **Call Details** report Rochend built.
3. Copy the URL from the address bar (it looks like
   `https://ads.google.com/aw/reporting/reporteditor/view?...&__c=2241479461&...`).

### 4. Capture the Google session locally (one-time, on Ali's laptop)

```bash
npm install
npx playwright install chromium
npm run capture-session
```

A real Chromium window opens. Sign into `tcawire808@gmail.com`, clear any
"Verify it's you" challenge, open the Call Details report once so Google
registers the device as trusted, come back to the terminal, press ENTER.

A file `storage-state.json` lands in the repo root. **Do not commit it.**

Base64-encode it:

```bash
# macOS
base64 -i storage-state.json | pbcopy
# Linux
base64 -w0 storage-state.json | xclip -selection clipboard
```

### 5. GitHub Secrets

Repo → Settings → Secrets and variables → Actions → New repository secret.

| Secret                       | Value                                                    |
| ---------------------------- | -------------------------------------------------------- |
| `GOOGLE_EMAIL`               | `tcawire808@gmail.com`                                   |
| `GOOGLE_PASSWORD`            | the account password                                     |
| `GOOGLE_TOTP_SECRET`         | the base32 string from step 2                            |
| `GOOGLE_ADS_REPORT_URL`      | the URL from step 3                                      |
| `GOOGLE_STORAGE_STATE_B64`   | the base64 blob from step 4                              |
| `SUPABASE_URL`               | `https://<project>.supabase.co`                          |
| `SUPABASE_SERVICE_ROLE_KEY`  | service role key from Supabase project settings          |

### 6. First run

Push to GitHub. In the Actions tab, open **TCA Google Ads Call Details Sync**
and click **Run workflow**. Watch the log. On success you'll see:

```
Downloaded: downloads/call-details-<ts>.xlsx
Parsed N rows from xlsx.
Upserted N rows into google_ads_call_details.
```

If it fails, the workflow uploads the downloaded xlsx as an artifact so you
can inspect the actual columns Google gave us (locale sometimes shifts headers).

## Schedule

`cron: '0 */6 * * *'` → every 6 hours. Change in `.github/workflows/sync.yml`
if you want more or less frequent pulls. Google's Call Details data is
delayed by a few hours anyway, so hourly buys very little.

## When Google challenges the session

The stored session will usually last weeks. When Google invalidates it, the
script falls back to email + password + TOTP automatically. If that *also*
fails (datacenter IP challenge, "This doesn't look like you"), re-run
`npm run capture-session` from Ali's laptop and re-upload
`GOOGLE_STORAGE_STATE_B64` as the GitHub Secret.

If this happens more than every few weeks, the next step is to move browser
hosting to Browserbase (~$20/mo) which persists the session across runs on
residential-IP sessions. Same Playwright script, swap `chromium.launch` for
`chromium.connectOverCDP(browserbaseConnectUrl)`.

## Local dev loop

```bash
# Create .env with the same keys as GitHub Secrets
npm run fetch
```

Add `headless: false` in `scripts/fetch-call-details.ts` while debugging so
you can watch the browser.
