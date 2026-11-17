/**
 * Run this ONCE, locally on Ali's laptop, with a visible browser.
 *
 *   npm install
 *   npx playwright install chromium
 *   npm run capture-session
 *
 * It opens a real Chromium window. Log into tcawire808@gmail.com,
 * clear any "verify it's you" challenges, make sure you can open
 * the Call Details saved report in Google Ads, then press ENTER in
 * the terminal. The session cookies get saved to storage-state.json.
 *
 * Base64-encode that file and paste it into the GITHUB SECRET named
 * GOOGLE_STORAGE_STATE_B64:
 *
 *   base64 -i storage-state.json | pbcopy        # macOS
 *   base64 -w0 storage-state.json | xclip        # Linux
 *
 * Also set EMAIL, PASSWORD, and TOTP_SECRET as GitHub Secrets so the
 * workflow can re-auth if Google ever expires the session.
 */

import { chromium } from 'playwright';
import readline from 'node:readline/promises';

const run = async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://accounts.google.com/');
  console.log('\nBrowser is open. Sign into tcawire808@gmail.com,');
  console.log('then open Google Ads and load the Call Details report once.');
  console.log('When you can see the report, come back here and press ENTER.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('Press ENTER after you are signed in and the report loads: ');
  rl.close();

  await context.storageState({ path: 'storage-state.json' });
  console.log('Saved: storage-state.json');
  await browser.close();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
