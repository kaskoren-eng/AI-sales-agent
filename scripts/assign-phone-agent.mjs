// Use the npx-cached playwright installation
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/kasko/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright');
import path from 'path';

const PHONE_NUMBER_URL = 'https://elevenlabs.io/app/conversational-ai/phone-numbers';
const AGENT_ID = 'agent_1901knm0rz88fkf8e03xb7de8j02';
const AGENT_NAME = 'Yoni';
const PHONE_NUMBER = '+17405285414';
const PHONE_NUM_ID = 'phnum_3301kns16rxmfan9waf85b8f4vd1';

const userDataDir = 'C:/Users/kasko/AppData/Local/ms-playwright/mcp-chrome-1d34939';

async function main() {
  console.log('Launching browser with existing profile...');
  const browser = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chrome',
    args: ['--no-first-run', '--no-default-browser-check'],
  });

  const page = await browser.newPage();

  console.log('Navigating to phone numbers page...');
  await page.goto(PHONE_NUMBER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Take a screenshot to see current state
  await page.screenshot({ path: 'C:/AI Sales agent/scripts/step1-phone-numbers.png', fullPage: true });
  console.log('Screenshot saved: step1-phone-numbers.png');

  // Wait a moment for content to load
  await page.waitForTimeout(2000);

  // Log page title and URL
  console.log('Page title:', await page.title());
  console.log('Page URL:', page.url());

  // Take another screenshot after wait
  await page.screenshot({ path: 'C:/AI Sales agent/scripts/step2-after-wait.png', fullPage: true });

  // Look for the phone number in the page
  const pageText = await page.textContent('body');
  console.log('Page contains +17405285414:', pageText.includes('+17405285414'));
  console.log('Page contains 17405285414:', pageText.includes('17405285414'));

  // Try to find and click on the phone number row
  const phoneNumberLocator = page.getByText('+17405285414');
  const count = await phoneNumberLocator.count();
  console.log(`Found ${count} elements with text "+17405285414"`);

  if (count > 0) {
    console.log('Clicking on phone number...');
    await phoneNumberLocator.first().click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'C:/AI Sales agent/scripts/step3-after-click.png', fullPage: true });
    console.log('Screenshot saved: step3-after-click.png');
  }

  // Look for any edit button or configure button near the phone number
  const editButtons = page.getByRole('button', { name: /edit|configure|assign|settings/i });
  const editCount = await editButtons.count();
  console.log(`Found ${editCount} edit/configure/assign buttons`);

  // Get all button texts on the page
  const buttons = await page.$$('button');
  for (const btn of buttons.slice(0, 20)) {
    const text = await btn.textContent();
    if (text && text.trim()) {
      console.log('Button:', text.trim().substring(0, 50));
    }
  }

  await page.screenshot({ path: 'C:/AI Sales agent/scripts/step4-final.png', fullPage: true });

  await browser.close();
  console.log('Done.');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
