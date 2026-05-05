/**
 * Configures the lead-intake and post-call flows for the first tenant.
 * Run after Docker is up: node scripts/setup-flows.mjs
 */
import pg from 'pg';
import { config } from 'dotenv';

config({ path: '.env' });

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

// Get the first tenant
const { rows: tenantRows } = await client.query(
  `SELECT id, name, settings FROM tenants ORDER BY created_at LIMIT 1`,
);

if (!tenantRows.length) {
  console.error('❌ No tenants found. Run: node scripts/seed-tenant.mjs first');
  await client.end();
  process.exit(1);
}

const tenant = tenantRows[0];
console.log(`\n✅ Found tenant: "${tenant.name}" (${tenant.id})`);

// Read existing settings and Monday column map (if configured)
const existing = tenant.settings ?? {};
const mondayCfg = existing.monday;
const statusColId = mondayCfg?.columnMap?.status ?? null;

// Build update_monday columnValues from whatever is mapped
const mondayColumnValues = {};
if (statusColId) {
  mondayColumnValues[statusColId] = 'Called';
  console.log(`   Monday status column: ${statusColId}`);
} else {
  console.log('   ⚠️  Monday not configured — update_monday step will be skipped at runtime');
}

// Lead-intake flow: fires 3 minutes after a lead is created
const leadIntakeFlow = {
  enabled: true,
  steps: [
    { type: 'make_call', delayMinutes: 3 },
  ],
};

// Post-call flow: fires immediately after the call ends
const postCallFlow = {
  enabled: true,
  steps: [
    // 1. Update Monday CRM
    {
      type: 'update_monday',
      delayMinutes: 0,
      columnValues: {
        ...mondayColumnValues,
        // Add more column IDs here as needed, e.g.:
        // "text_column_id": "{{callSummary}}"
      },
    },
    // 2. Book a follow-up meeting on Google Calendar (auto-picks next open slot)
    {
      type: 'book_calendar',
      delayMinutes: 0,
      notes: 'Follow-up call with {{name}}. Call summary: {{callSummary}}',
    },
    // 3. Send WhatsApp with meeting details
    {
      type: 'send_whatsapp',
      delayMinutes: 0,
      content: {
        messageType: 'text',
        text: 'Hi {{name}}, great speaking with you!\n\nYour follow-up meeting is booked:\n📅 {{meetingDate}}\n🕐 {{meetingTime}} UTC\n🔗 {{meetingLink}}\n\nWe look forward to talking again!',
      },
    },
    // 4. Send email with call summary + meeting link
    {
      type: 'send_email',
      delayMinutes: 0,
      content: {
        subject: 'Your call summary & next meeting — {{name}}',
        html: `<p>Hi {{name}},</p>
<p>Thank you for taking the time to speak with us today.</p>
<h3>Call Summary</h3>
<p>{{callSummary}}</p>
<h3>Your Next Meeting</h3>
<p>
  <strong>Date:</strong> {{meetingDate}}<br>
  <strong>Time:</strong> {{meetingTime}} UTC<br>
  <a href="{{meetingLink}}" style="display:inline-block;margin-top:8px;padding:10px 20px;background:#4285f4;color:#fff;border-radius:4px;text-decoration:none;">Join Google Meet</a>
</p>
<p>Talk soon,<br>The Sales Team</p>`,
      },
    },
  ],
};

// Merge flows into existing settings
const updatedSettings = {
  ...existing,
  flows: {
    ...(existing.flows ?? {}),
    'lead-intake': leadIntakeFlow,
    'post-call': postCallFlow,
  },
};

await client.query(
  `UPDATE tenants SET settings = $1, updated_at = NOW() WHERE id = $2`,
  [JSON.stringify(updatedSettings), tenant.id],
);

console.log('\n✅ Flows configured:');
console.log('   lead-intake  → make_call after 3 min');
console.log('   post-call    → update_monday → book_calendar → send_whatsapp → send_email');
console.log('\n📋 To test: create a lead with a real phone + email, then watch the server logs.');
console.log(`   Tenant ID : ${tenant.id}\n`);

await client.end();
