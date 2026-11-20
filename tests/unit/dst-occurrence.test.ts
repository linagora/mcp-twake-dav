/**
 * An occurrence at 02:30 on the day the clocks change
 *
 * ical.js keeps 02:30 in the frame of the series; rebuilding that time from an hour later, read back
 * through a JavaScript Date, lands on 03:30 and the exception is never found.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';
import type { DAVCalendarObject } from 'tsdav';
import { getEventsWithRecurrenceExpansion } from '../../src/tools/calendar/utils.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

const series = (exception: string) => `BEGIN:VCALENDAR
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
UID:nuit@example.com
DTSTART;TZID=Europe/Paris:20260104T023000
DTEND;TZID=Europe/Paris:20260104T033000
RRULE:FREQ=WEEKLY
SUMMARY:Nuit
END:VEVENT
${exception}
END:VCALENDAR`;

const raw = (ics: string): DAVCalendarObject[] => [{ url: 'https://dav.example.com/calendars/u1/nuit.ics', etag: '"1"', data: ics }];

// 25 October 2026 is the day Europe/Paris goes back to winter time: 02:30 happens twice
const cancelled = `BEGIN:VEVENT
UID:nuit@example.com
RECURRENCE-ID;TZID=Europe/Paris:20261025T023000
DTSTART;TZID=Europe/Paris:20261025T023000
DTEND;TZID=Europe/Paris:20261025T033000
STATUS:CANCELLED
SUMMARY:Nuit
END:VEVENT`;

const moved = `BEGIN:VEVENT
UID:nuit@example.com
RECURRENCE-ID;TZID=Europe/Paris:20261025T023000
DTSTART;TZID=Europe/Paris:20261025T043000
DTEND;TZID=Europe/Paris:20261025T053000
SUMMARY:Nuit (déplacé)
END:VEVENT`;

describe('an occurrence on the day the clocks change', () => {
  it('drops the one that was cancelled', () => {
    const events = getEventsWithRecurrenceExpansion(raw(series(cancelled)), { start: '2026-10-25T00:00:00Z', end: '2026-10-26T00:00:00Z' }, logger);

    expect(events).toHaveLength(0);
  });

  it('lists the one that was moved, at its new time', () => {
    const events = getEventsWithRecurrenceExpansion(raw(series(moved)), { start: '2026-10-25T00:00:00Z', end: '2026-10-26T00:00:00Z' }, logger);

    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('Nuit (déplacé)');
    // 04:30 in Paris: the clocks went back at 03:00 that morning, so the offset is +01:00
    expect(events[0].startDate.toISOString()).toBe('2026-10-25T03:30:00.000Z');
  });

  it('keeps the other occurrences of the series', () => {
    const events = getEventsWithRecurrenceExpansion(raw(series(cancelled)), { start: '2026-10-18T00:00:00Z', end: '2026-10-19T00:00:00Z' }, logger);

    expect(events).toHaveLength(1);
    expect(events[0].startDate.toISOString()).toBe('2026-10-18T00:30:00.000Z');
  });
});
