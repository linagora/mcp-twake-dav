/**
 * An occurrence moved into another day is listed on the day it was moved to
 *
 * The series gives the occurrence its original slot, so the expansion of the new day never generates
 * it: the exception holding it has to be read too.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';
import type { DAVCalendarObject } from 'tsdav';
import { getEventsWithRecurrenceExpansion } from '../../src/tools/calendar/utils.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTIMEZONE
TZID:Europe/Paris
BEGIN:STANDARD
DTSTART:19701025T030000
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:19700329T020000
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
UID:classe@example.com
DTSTART;TZID=Europe/Paris:20230405T110000
DTEND;TZID=Europe/Paris:20230405T120000
RRULE:FREQ=WEEKLY
SUMMARY:Cours
END:VEVENT
BEGIN:VEVENT
UID:classe@example.com
RECURRENCE-ID;TZID=Europe/Paris:20261111T110000
DTSTART;TZID=Europe/Paris:20261110T150000
DTEND;TZID=Europe/Paris:20261110T160000
SUMMARY:Cours (déplacé)
END:VEVENT
BEGIN:VEVENT
UID:classe@example.com
RECURRENCE-ID;TZID=Europe/Paris:20261118T110000
DTSTART;TZID=Europe/Paris:20261119T090000
DTEND;TZID=Europe/Paris:20261119T100000
SUMMARY:Cours (déplacé ailleurs)
END:VEVENT
END:VCALENDAR`;

const raw: DAVCalendarObject[] = [{ url: 'https://dav.example.com/calendars/u1/classe.ics', etag: '"1"', data: ICS }];

describe('an occurrence moved to another day', () => {
  it('is listed on the day it was moved to', () => {
    const events = getEventsWithRecurrenceExpansion(raw, { start: '2026-11-10T00:00:00Z', end: '2026-11-11T00:00:00Z' }, logger);

    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('Cours (déplacé)');
    // 15:00 in Paris is 14:00 UTC
    expect(events[0].startDate.toISOString()).toBe('2026-11-10T14:00:00.000Z');
  });

  it('is listed on the day it was moved forward to', () => {
    const events = getEventsWithRecurrenceExpansion(raw, { start: '2026-11-19T00:00:00Z', end: '2026-11-20T00:00:00Z' }, logger);

    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('Cours (déplacé ailleurs)');
    expect(events[0].startDate.toISOString()).toBe('2026-11-19T08:00:00.000Z');
  });

  it('is not listed on a day it has nothing to do with', () => {
    const events = getEventsWithRecurrenceExpansion(raw, { start: '2026-11-09T00:00:00Z', end: '2026-11-10T00:00:00Z' }, logger);

    expect(events).toHaveLength(0);
  });

  it('keeps one entry when an exception only changes the title', () => {
    const retitled = ICS.replace('SUMMARY:Cours (déplacé)', 'SUMMARY:Cours (renommé)')
      .replace('DTSTART;TZID=Europe/Paris:20261110T150000', 'DTSTART;TZID=Europe/Paris:20261111T110000')
      .replace('DTEND;TZID=Europe/Paris:20261110T160000', 'DTEND;TZID=Europe/Paris:20261111T120000');

    const events = getEventsWithRecurrenceExpansion([{ ...raw[0], data: retitled }], { start: '2026-11-11T00:00:00Z', end: '2026-11-12T00:00:00Z' }, logger);

    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('Cours (renommé)');
    expect(events[0].startDate.toISOString()).toBe('2026-11-11T10:00:00.000Z');
  });

  it('is listed once when a wider range holds its slot too', () => {
    const events = getEventsWithRecurrenceExpansion(raw, { start: '2026-11-09T00:00:00Z', end: '2026-11-12T00:00:00Z' }, logger);

    // the moved occurrence must not be added twice: once for its slot, once for its new day
    expect(events.filter((event) => event.summary === 'Cours (déplacé)')).toHaveLength(1);
    expect(events.filter((event) => event.startDate.toISOString() === '2026-11-10T14:00:00.000Z')).toHaveLength(1);
  });
});
