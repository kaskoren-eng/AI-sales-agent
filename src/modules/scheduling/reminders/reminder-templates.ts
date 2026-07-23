import type { BusinessProfile } from '../../settings/settings.service.js';
import type { ReminderSettings } from './reminder-settings.js';

/**
 * Hebrew reminder messages — warm by default, formal when the tenant's BusinessProfile says so,
 * tenant overrides beat both. Placeholders: {lead_name} {slot} {meet_link} {company}.
 *
 * Rules the tests pin down:
 *  - The meet-link LINE disappears when there is no link — never a blank or 'undefined'.
 *  - Every variant carries the reply-to-reschedule hook ("תענה לי כאן") — C1's required CTA.
 *  - {company} phrasing degrades gracefully when no BusinessProfile exists.
 */

export interface ReminderMessageInput {
  kind: 't24' | 't1';
  channel: 'whatsapp' | 'email';
  leadName: string;
  /** Pre-formatted Hebrew slot text (formatSlotHe). */
  slotText: string;
  meetLink?: string;
  profile: BusinessProfile | null;
  overrides?: ReminderSettings['templateOverrides'];
}

const WARM: Record<'t24' | 't1', { body: string; subject: string }> = {
  t24: {
    subject: 'תזכורת: הפגישה שלנו {slot}',
    body: [
      'היי {lead_name}! 😊',
      'רק תזכורת חמה — יש לנו פגישה {slot}{company_suffix}.',
      '{meet_link_line}',
      'אם משהו השתנה או שנוח לך זמן אחר — פשוט תענה לי כאן ונתאם מחדש.',
      'נתראה!',
    ].join('\n'),
  },
  t1: {
    subject: 'נפגשים בעוד שעה — {slot}',
    body: [
      'היי {lead_name}, נפגשים בעוד שעה! ⏰',
      '{slot}{company_suffix}.',
      '{meet_link_line}',
      'אם צריך לדחות ברגע האחרון — תענה לי כאן ואדאג שנתאם מחדש.',
      'להתראות עוד מעט!',
    ].join('\n'),
  },
};

const FORMAL: Record<'t24' | 't1', { body: string; subject: string }> = {
  t24: {
    subject: 'תזכורת לפגישה — {slot}',
    body: [
      'שלום {lead_name},',
      'תזכורת: פגישתנו קבועה {slot}{company_suffix}.',
      '{meet_link_line}',
      'אם נדרש שינוי במועד, אנא השב להודעה זו ונתאם מחדש.',
      'נשמח לראותך.',
    ].join('\n'),
  },
  t1: {
    subject: 'פגישתנו מתחילה בעוד שעה — {slot}',
    body: [
      'שלום {lead_name},',
      'פגישתנו מתחילה בעוד שעה, {slot}{company_suffix}.',
      '{meet_link_line}',
      'אם נדרש שינוי ברגע האחרון, אנא השב להודעה זו ("תענה לי כאן" עובד גם).',
      'להתראות בקרוב.',
    ].join('\n'),
  },
};

function interpolate(template: string, input: ReminderMessageInput): string {
  const company = input.profile?.companyName ?? '';
  return template
    .replace(/\{lead_name\}/g, input.leadName)
    .replace(/\{slot\}/g, input.slotText)
    .replace(/\{company_suffix\}/g, company ? ` עם ${company}` : '')
    .replace(/\{company\}/g, company)
    .replace(/\{meet_link_line\}/g, input.meetLink ? `זה הלינק לפגישה: ${input.meetLink}` : '')
    .replace(/\{meet_link\}/g, input.meetLink ?? '')
    .split('\n')
    .filter((line) => line.trim() !== '') // drop the emptied meet-link line
    .join('\n');
}

export function buildReminderMessage(input: ReminderMessageInput): { body: string; subject?: string } {
  const formal = /רשמי|formal/i.test(input.profile?.toneOfVoice ?? '');
  const base = (formal ? FORMAL : WARM)[input.kind];

  const overrideBody =
    input.channel === 'whatsapp'
      ? input.overrides?.[`${input.kind}_whatsapp`]
      : input.overrides?.[`${input.kind}_email_body`];
  const overrideSubject = input.channel === 'email' ? input.overrides?.[`${input.kind}_email_subject`] : undefined;

  const body = interpolate(overrideBody ?? base.body, input);
  if (input.channel === 'email') {
    return { body, subject: interpolate(overrideSubject ?? base.subject, input) };
  }
  return { body };
}
