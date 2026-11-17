/**
 * Runs in GitHub Actions on a schedule.
 *
 * 1. Launches Chromium with stealth plugin.
 * 2. Loads the saved Google session (storage-state.json), decoded from
 *    the GOOGLE_STORAGE_STATE_B64 secret. If that session is expired or
 *    missing, falls back to a fresh email + password + TOTP login.
 * 3. Opens the Google Ads Call Details saved report URL.
 * 4. Clicks Download → Excel (.xlsx), waits for the file.
 * 5. Parses the xlsx and upserts rows into Supabase.
 */

import { chromium } from 'playwright-extra';
// @ts-ignore - no types shipped
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { createClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';
import * as OTPAuth from 'otpauth';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

chromium.use(StealthPlugin());

const {
  GOOGLE_STORAGE_STATE_B64,
  GOOGLE_EMAIL,
  GOOGLE_PASSWORD,
  GOOGLE_TOTP_SECRET,
  GOOGLE_ADS_REPORT_URL,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

const REQUIRED = {
  GOOGLE_EMAIL,
  GOOGLE_PASSWORD,
  GOOGLE_TOTP_SECRET,
  GOOGLE_ADS_REPORT_URL,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
};
for (const [k, v] of Object.entries(REQUIRED)) {
  if (!v) throw new Error(`Missing required env var: ${k}`);
}

const DOWNLOAD_DIR = path.resolve('downloads');

// ---- Session file hydration -------------------------------------------------

const hydrateStorageState = async (): Promise<string | undefined> => {
  if (!GOOGLE_STORAGE_STATE_B64) return undefined;
  await mkdir(DOWNLOAD_DIR, { recursive: true });
  const target = path.resolve('storage-state.json');
  await writeFile(target, Buffer.from(GOOGLE_STORAGE_STATE_B64, 'base64'));
  return target;
};

// ---- Login fallback (TOTP) --------------------------------------------------

const loginWithPassword = async (page: import('playwright').Page) => {
  console.log('Session expired. Logging in fresh with email + password + TOTP.');
  await page.goto('https://accounts.google.com/');

  await page.waitForSelector('input[type="email"]', { timeout: 30_000 });
  await page.fill('input[type="email"]', GOOGLE_EMAIL!);
  await page.click('#identifierNext');

  await page.waitForSelector('input[type="password"]', { timeout: 30_000 });
  // Google animates the password field in; give it a beat.
  await page.waitForTimeout(1_500);
  await page.fill('input[type="password"]', GOOGLE_PASSWORD!);
  await page.click('#passwordNext');

  // Wait for either the TOTP challenge or a successful landing page.
  try {
    await page.waitForSelector('input[name="totpPin"], input[type="tel"]', { timeout: 15_000 });
    const totp = new OTPAuth.TOTP({
      issuer: 'Google',
      label: GOOGLE_EMAIL!,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(GOOGLE_TOTP_SECRET!.replace(/\s+/g, '')),
    });
    const code = totp.generate();
    const totpField = page.locator('input[name="totpPin"], input[type="tel"]').first();
    await totpField.fill(code);
    await page.keyboard.press('Enter');
  } catch {
    // No TOTP prompt — already logged in or Google chose a different challenge.
  }

  // Deal with "Don't ask on this device" / consent screens if they show up.
  const notNow = page.locator('button:has-text("Not now")');
  if (await notNow.first().isVisible().catch(() => false)) {
    await notNow.first().click();
  }
};

// ---- Download & parse -------------------------------------------------------

type CallRow = {
  start_time: string;
  duration_seconds: number | null;
  caller_country_code: string | null;
  caller_area_code: string | null;
  caller_phone_number: string | null;
  status: string | null;
  call_source: string | null;
  call_type: string | null;
  campaign: string | null;
  ad_group: string | null;
};

// Google Ads column headers vary by locale. Map whatever we find to our schema.
const normalizeHeader = (h: string): keyof CallRow | null => {
  const key = h.trim().toLowerCase();
  if (key.includes('start time') || key === 'date') return 'start_time';
  if (key.includes('duration')) return 'duration_seconds';
  if (key.includes('country code')) return 'caller_country_code';
  if (key.includes('area code')) return 'caller_area_code';
  if (key.includes('phone number')) return 'caller_phone_number';
  if (key === 'status') return 'status';
  if (key.includes('call source') || key === 'source') return 'call_source';
  if (key.includes('call type') || key === 'type') return 'call_type';
  if (key === 'campaign') return 'campaign';
  if (key === 'ad group') return 'ad_group';
  return null;
};

const parseXlsx = (buf: Buffer): CallRow[] => {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });

  return raw
    .map((r) => {
      const out: Partial<CallRow> = {};
      for (const [header, value] of Object.entries(r)) {
        const col = normalizeHeader(header);
        if (!col) continue;
        if (col === 'start_time' && value) {
          out.start_time = value instanceof Date
            ? value.toISOString()
            : new Date(String(value)).toISOString();
        } else if (col === 'duration_seconds') {
          out.duration_seconds = value == null ? null : Number(value);
        } else {
          (out as any)[col] = value == null ? null : String(value).trim();
        }
      }
      return out as CallRow;
    })
    .filter((r) => r.start_time);
};

// ---- Supabase ---------------------------------------------------------------

const upsertRows = async (rows: CallRow[]) => {
  if (rows.length === 0) {
    console.log('No rows to upsert.');
    return;
  }
  const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
  const { data, error } = await supabase
    .from('google_ads_call_details')
    .upsert(rows, { onConflict: 'start_time,caller_phone_number', ignoreDuplicates: false })
    .select('id');
  if (error) throw error;
  console.log(`Upserted ${data?.length ?? 0} rows into google_ads_call_details.`);
};

// ---- Main -------------------------------------------------------------------

const run = async () => {
  await mkdir(DOWNLOAD_DIR, { recursive: true });
  const storageStatePath = await hydrateStorageState();

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    storageState: storageStatePath && existsSync(storageStatePath) ? storageStatePath : undefined,
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  // Try to open the saved report. If we land on a login screen, re-auth.
  await page.goto(GOOGLE_ADS_REPORT_URL!, { waitUntil: 'domcontentloaded' });
  if (/accounts\.google\.com/.test(page.url())) {
    await loginWithPassword(page);
    await page.goto(GOOGLE_ADS_REPORT_URL!, { waitUntil: 'domcontentloaded' });
  }

  // Let the report table render.
  await page.waitForLoadState('networkidle', { timeout: 60_000 });
  await page.waitForTimeout(3_000);

  // Trigger download: click Download button, then the Excel (.xlsx) option.
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    (async () => {
      // "Download" in the header. Role=button is the most stable selector across locales.
      await page.getByRole('button', { name: /download/i }).first().click();
      // Menu item for Excel .xlsx.
      await page.getByRole('menuitem', { name: /excel|\.xlsx/i }).first().click();
    })(),
  ]);

  const dest = path.join(DOWNLOAD_DIR, `call-details-${Date.now()}.xlsx`);
  await download.saveAs(dest);
  console.log(`Downloaded: ${dest}`);

  // Refresh the storage state so future runs skip the login.
  await context.storageState({ path: 'storage-state.json' });
  await browser.close();

  const buf = await readFile(dest);
  const rows = parseXlsx(buf);
  console.log(`Parsed ${rows.length} rows from xlsx.`);

  await upsertRows(rows);
};

run().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
