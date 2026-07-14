import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { google } = require('googleapis');

const privateKey = process.env.GOOGLE_CALENDAR_PRIVATE_KEY?.replace(/\\n/g, '\n');
const calendarId = process.env.GOOGLE_CALENDAR_ID;
const serviceAccountEmail = process.env.GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL;

if (!privateKey || !calendarId || !serviceAccountEmail) {
  console.error('Missing Google Calendar env vars');
  process.exit(1);
}

const auth = new google.auth.JWT({
  email: serviceAccountEmail,
  key: privateKey,
  scopes: ['https://www.googleapis.com/auth/calendar'],
});

const calendar = google.calendar({ version: 'v3', auth });

// Tomorrow 10:00 Israel time = 07:00 UTC (UTC+3)
const start = new Date('2026-06-02T07:00:00Z');
const end   = new Date('2026-06-02T07:30:00Z');

try {
  const res = await calendar.events.insert({
    calendarId,
    sendUpdates: 'all',
    conferenceDataVersion: 1,
    requestBody: {
      summary: 'Test Booking — AI Sales Agent',
      description: 'Live test: booking via AI Sales Agent Google Calendar integration',
      start: { dateTime: start.toISOString(), timeZone: 'Asia/Jerusalem' },
      end:   { dateTime: end.toISOString(),   timeZone: 'Asia/Jerusalem' },
      attendees: [{ email: 'koren@clickscales.com', displayName: 'Koren' }],
      conferenceData: { createRequest: { requestId: crypto.randomUUID() } },
    },
  });

  const event = res.data;
  const meetLink = (event.conferenceData?.entryPoints ?? []).find(e => e.entryPointType === 'video')?.uri;
  console.log('Booked!');
  console.log('Event ID :', event.id);
  console.log('Start    :', event.start?.dateTime);
  console.log('Meet link:', meetLink ?? '(generating - check calendar)');
  console.log('HTML link:', event.htmlLink);
} catch (e) {
  console.error('Error:', e.message);
  if (e.response?.data) console.error(JSON.stringify(e.response.data, null, 2));
}
