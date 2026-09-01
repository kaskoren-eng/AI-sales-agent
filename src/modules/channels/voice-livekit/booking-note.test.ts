import { describe, expect, it } from 'vitest';
import { bookingNote, toSpokenIsraeliNumber, type BookingNoteState } from './booking-note.js';

/**
 * THE THREE FALSE STATEMENTS OF FACT ON THE 2026-08-31 16:51 CALL.
 *
 *     [273s] "בסדר. קבענו לאחת עשרה..."            — nothing was booked
 *     [312s] "כרגע חסר לי רק המייל כדי להמשיך."     — no phone, no confirmed surname either
 *     [347s] "יש לי מספיק כדי להעביר לצוות..."       — a first name, and then end_call
 *
 * All three are claims about the STATE OF THE BOOKING, and all three were contradicted by the tool
 * runtime at the moment she made them. This note is that runtime, read out at the turn boundary.
 *
 * These tests pin what the note SAYS. They cannot pin that gpt-5.4 acts on it — no test in this
 * repo can, and the speech guard is the half that does not have to trust the model.
 */

const base: BookingNoteState = {
  scheduling: true,
  booked: false,
  toolsEnabled: true,
  name: 'קורן',
  phone: null,
  callerPhone: '+972509788845',
  offerCallerPhone: true,
};

describe('bookingNote — what is actually booked', () => {
  it('says plainly that nothing is booked, and that checking availability is not booking', () => {
    const note = bookingNote(base) ?? '';
    expect(note).toMatch(/NOTHING HAS BEEN BOOKED YET/u);
    expect(note).toMatch(/Checking availability is not booking/u);
    // Every wording of the claim she actually used, named where she can see it.
    for (const w of ['קבענו', 'קבעתי', 'סגרנו', 'שריינתי']) expect(note).toContain(w);
  });

  it('names the missing REQUIRED argument, and says the email is not one', () => {
    const note = bookingNote(base) ?? '';
    expect(note).toMatch(/you still need: his phone number/u);
    expect(note).toMatch(/The email is NOT on it/u);
  });

  it('forbids the exact "only the email is missing" claim she made twice', () => {
    expect(bookingNote(base) ?? '').toMatch(/only thing missing/u);
  });

  it('when both required fields are held it tells her to call the tool and not to end the call', () => {
    const note = bookingNote({ ...base, phone: '0509788845' }) ?? '';
    expect(note).toMatch(/You now have everything `book_meeting` requires/u);
    expect(note).toMatch(/do not end the call without it/u);
    // …and it stops offering the caller-ID confirmation, which has nothing left to do.
    expect(note).not.toMatch(/he is calling from/u);
  });

  it('offers the number he is calling from as a CONFIRMATION, never as a substitution', () => {
    const note = bookingNote(base) ?? '';
    expect(note).toMatch(/Do not make him dictate it/u);
    expect(note).toMatch(/ask him to confirm/u);
    // The other half of the rule: a man may want the demo on a different number.
    expect(note).toMatch(/Only if he gives you a different number/u);
  });

  it('hands her the number in the form she has to SAY, and never the E.164', () => {
    // The 15:02 call on 2026-09-01: given `+972509788845` the model converted it itself and read
    // back `050-978845` — nine digits, to the man whose number it is. It now copies instead.
    const note = bookingNote(base) ?? '';
    expect(note).toContain('0509788845');
    expect(note).not.toContain('+972509788845');
    expect(note).toMatch(/do not reformat, regroup, drop or add a single digit/u);
  });

  it('KILL-SWITCH: offerCallerPhone=false keeps the note and drops only that paragraph', () => {
    const note = bookingNote({ ...base, offerCallerPhone: false }) ?? '';
    expect(note).toMatch(/NOTHING HAS BEEN BOOKED YET/u);
    expect(note).not.toContain('+972509788845');
  });

  it('an outbound or web call has no caller ID to offer, and says nothing about one', () => {
    const note = bookingNote({ ...base, callerPhone: null }) ?? '';
    expect(note).toMatch(/NOTHING HAS BEEN BOOKED YET/u);
    expect(note).not.toMatch(/he is calling from/u);
  });
});

describe('bookingNote — the bounds that keep it from costing tokens on every call', () => {
  it('silent before the booking phase begins', () => {
    expect(bookingNote({ ...base, scheduling: false })).toBeNull();
  });

  it('silent on a call with no tools — there is nothing it could be about', () => {
    expect(bookingNote({ ...base, toolsEnabled: false })).toBeNull();
  });

  it('flips to the OTHER truth once a booking exists — the mirror-image failure', () => {
    // A meeting that EXISTS, described to the lead as a request that will be passed on, is its own
    // defect: he then does not turn up to a call that is in his diary.
    const note = bookingNote({ ...base, booked: true }) ?? '';
    expect(note).toMatch(/has SUCCEEDED on this call/u);
    expect(note).toMatch(/do not offer to pass anything to the team/u);
    expect(note).not.toMatch(/NOTHING HAS BEEN BOOKED/u);
  });

  it('a booking that succeeded reports itself even before the scheduling flag is set', () => {
    expect(bookingNote({ ...base, booked: true, scheduling: false })).not.toBeNull();
  });
});

describe('toSpokenIsraeliNumber — conversion, so the model never has to do arithmetic', () => {
  it('turns the E.164 the SIP participant carries into the number she says', () => {
    expect(toSpokenIsraeliNumber('+972509788845')).toBe('0509788845');
    expect(toSpokenIsraeliNumber('972509788845')).toBe('0509788845');
    // Zadarma is not consistent about separators; digits are all that matter.
    expect(toSpokenIsraeliNumber('+972-50-978-8845')).toBe('0509788845');
  });

  it('leaves an already-local number exactly as it is', () => {
    expect(toSpokenIsraeliNumber('0509788845')).toBe('0509788845');
    expect(toSpokenIsraeliNumber('050-978-8845')).toBe('0509788845');
  });

  it('adds the trunk prefix to a bare Israeli mobile', () => {
    expect(toSpokenIsraeliNumber('509788845')).toBe('0509788845');
  });

  it('hands back anything it does not recognise UNTOUCHED', () => {
    // A foreign caller is better spoken oddly than spoken wrong: reshaping on a guess is exactly
    // the behaviour this function exists to take away from the model.
    expect(toSpokenIsraeliNumber('+14155552671')).toBe('+14155552671');
    expect(toSpokenIsraeliNumber('anonymous')).toBe('anonymous');
  });

  it('never loses or invents a digit — the defect itself, stated as a property', () => {
    const digits = (s: string): string => s.replace(/\D/gu, '');
    for (const raw of ['+972509788845', '972509788845', '0509788845', '509788845']) {
      expect(digits(toSpokenIsraeliNumber(raw))).toHaveLength(10);
      expect(toSpokenIsraeliNumber(raw)).toBe('0509788845');
    }
  });
});
