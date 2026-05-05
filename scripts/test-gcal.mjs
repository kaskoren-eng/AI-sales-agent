import { config } from 'dotenv';
import { google } from 'googleapis';

config({ path: '.env' });

const { GOOGLE_CALENDAR_ID, GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL, GOOGLE_CALENDAR_PRIVATE_KEY } = process.env;

console.log('GOOGLE_CALENDAR_ID               :', GOOGLE_CALENDAR_ID);
console.log('GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL:', GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL);
console.log('GOOGLE_CALENDAR_PRIVATE_KEY starts:', GOOGLE_CALENDAR_PRIVATE_KEY?.slice(0, 40));

if (!GOOGLE_CALENDAR_ID || !GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL || !GOOGLE_CALENDAR_PRIVATE_KEY) {
  console.error('\n❌ One or more env vars missing');
  process.exit(1);
}

const privateKey = GOOGLE_CALENDAR_PRIVATE_KEY.replace(/\\n/g, '\n');

const auth = new google.auth.JWT({
  email: GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL,
  key: privateKey,
  scopes: ['https://www.googleapis.com/auth/calendar'],
});

console.log('\nFetching access token...');
try {
  const token = await auth.getAccessToken();
  console.log('✅ Access token received\n');
} catch (e) {
  console.error('❌ Auth failed:', e.message);
  console.error('\nMost likely cause: Google Calendar API is not enabled on your project.');
  console.error('Fix: Go to https://console.cloud.google.com → APIs & Services → Library → search "Google Calendar API" → Enable');
  process.exit(1);
}

const calendar = google.calendar({ version: 'v3', auth });

console.log('Testing freebusy API...');
try {
  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: new Date('2026-04-29T00:00:00Z').toISOString(),
      timeMax: new Date('2026-04-30T23:59:59Z').toISOString(),
      timeZone: 'UTC',
      items: [{ id: GOOGLE_CALENDAR_ID }],
    },
  });
  console.log('✅ Freebusy response:', JSON.stringify(res.data, null, 2));
} catch (e) {
  console.error('❌ Freebusy failed:', e.message);
  process.exit(1);
}
