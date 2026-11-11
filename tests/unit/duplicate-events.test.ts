/**
 * The same event on several calendars is one event
 *
 * An invitation accepted and copied into the user's own calendar, a team meeting shown on every
 * member's calendar, an event shared twice: same UID, same times, one entry each.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';
import type { DAVCalendarObject } from 'tsdav';
import { getEventsWithRecurrenceExpansion } from '../../src/tools/calendar/utils.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

const event = (url: string, uid: string, summary = 'Weekly meeting') => ({
  url,
  etag: `"${url}"`,
  data: `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:${uid}
DTSTAMP:20260101T000000Z
DTSTART:20261111T100000Z
DTEND:20261111T110000Z
SUMMARY:${summary}
ATTENDEE;PARTSTAT=ACCEPTED:mailto:alice@example.com
END:VEVENT
END:VCALENDAR`,
}) as DAVCalendarObject;

const range = { start: '2026-11-11T00:00:00Z', end: '2026-11-12T00:00:00Z' };

describe('the same event on several calendars', () => {
  it('is listed once', () => {
    const events = getEventsWithRecurrenceExpansion(
      [
        event('https://dav.example.com/calendars/u1/mine/e1.ics', 'shared@example.com'),
        event('https://dav.example.com/calendars/u1/team/e1.ics', 'shared@example.com'),
        event('https://dav.example.com/calendars/u1/colleague/e1.ics', 'shared@example.com'),
      ],
      range,
      logger
    );

    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('Weekly meeting');
  });

  it('keeps the first copy of the server order', () => {
    const events = getEventsWithRecurrenceExpansion(
      [
        event('https://dav.example.com/calendars/u1/mine/e1.ics', 'shared@example.com', 'Mine'),
        event('https://dav.example.com/calendars/u1/team/e1.ics', 'shared@example.com', 'Team'),
      ],
      range,
      logger
    );

    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('Mine');
    expect(events[0].url).toContain('/mine/');
  });
;

  it('does not merge two different events at the same time', () => {
    const events = getEventsWithRecurrenceExpansion(
      [
        event('https://dav.example.com/calendars/u1/mine/a.ics', 'a@example.com', 'A'),
        event('https://dav.example.com/calendars/u1/mine/b.ics', 'b@example.com', 'B'),
      ],
      range,
      logger
    );

    expect(events).toHaveLength(2);
    expect(events.map((e) => e.summary).sort()).toEqual(['A', 'B']);
  });

  it('keeps two occurrences of a series apart when one was moved onto the other', () => {
    const series = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:moved@example.com
DTSTAMP:20260101T000000Z
DTSTART:20261109T100000Z
DTEND:20261109T110000Z
RRULE:FREQ=DAILY;COUNT=3
SUMMARY:Daily
END:VEVENT
BEGIN:VEVENT
UID:moved@example.com
DTSTAMP:20260101T000000Z
RECURRENCE-ID:20261111T100000Z
DTSTART:20261110T100000Z
DTEND:20261110T110000Z
SUMMARY:Daily (moved)
END:VEVENT
END:VCALENDAR`;

    const events = getEventsWithRecurrenceExpansion(
      [
        { url: 'https://dav.example.com/calendars/u1/mine/s.ics', etag: '"1"', data: series } as DAVCalendarObject,
        { url: 'https://dav.example.com/calendars/u1/team/s.ics', etag: '"2"', data: series } as DAVCalendarObject,
      ],
      { start: '2026-11-09T00:00:00Z', end: '2026-11-12T00:00:00Z' },
      logger
    );

    // 9 November, and two entries on the 10th: the regular occurrence and the one moved onto it
    expect(events.map((event) => event.startDate.toISOString())).toEqual([
      '2026-11-09T10:00:00.000Z',
      '2026-11-10T10:00:00.000Z',
      '2026-11-10T10:00:00.000Z',
    ]);
  });

  it('keeps one entry when only one of the copies carries the exception', () => {
    const plain = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:half@example.com
DTSTAMP:20260101T000000Z
DTSTART:20261111T100000Z
DTEND:20261111T110000Z
SUMMARY:Comité
END:VEVENT
END:VCALENDAR`;

    const events = getEventsWithRecurrenceExpansion(
      [
        { url: 'https://dav.example.com/calendars/u1/mine/e.ics', etag: '"1"', data: plain } as DAVCalendarObject,
        event('https://dav.example.com/calendars/u1/team/e.ics', 'half@example.com', 'Comité (modifié)'),
      ],
      range,
      logger
    );

    expect(events).toHaveLength(1);
  });

  it('deduplicates an occurrence stored alone with its RECURRENCE-ID', () => {
    // an event object holding a single occurrence of a series, as an accepted invitation for one date
    const alone = (url: string) =>
      ({
        url,
        etag: `"${url}"`,
        data: `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:alone@example.com
DTSTAMP:20260101T000000Z
RECURRENCE-ID:20261111T100000Z
DTSTART:20261110T100000Z
DTEND:20261110T110000Z
SUMMARY:Comité (déplacé)
END:VEVENT
END:VCALENDAR`,
      }) as DAVCalendarObject;

    const events = getEventsWithRecurrenceExpansion(
      [alone('https://dav.example.com/calendars/u1/mine/a.ics'), alone('https://dav.example.com/calendars/u1/team/a.ics')],
      { start: '2026-11-09T00:00:00Z', end: '2026-11-12T00:00:00Z' },
      logger
    );

    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('Comité (déplacé)');
  });

  it('keeps the occurrences of a series apart', () => {
    const series = (url: string, uid: string) => ({
      url,
      etag: `"${url}"`,
      data: `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:${uid}
DTSTAMP:20260101T000000Z
DTSTART:20261109T100000Z
DTEND:20261109T110000Z
RRULE:FREQ=DAILY;COUNT=3
SUMMARY:Daily
END:VEVENT
END:VCALENDAR`,
    }) as DAVCalendarObject;

    const events = getEventsWithRecurrenceExpansion(
      [series('https://dav.example.com/calendars/u1/mine/s.ics', 'daily@example.com'), series('https://dav.example.com/calendars/u1/team/s.ics', 'daily@example.com')],
      { start: '2026-11-09T00:00:00Z', end: '2026-11-12T00:00:00Z' },
      logger
    );

    // three occurrences of one series, not three copies of the first one
    expect(events.map((e) => e.startDate.toISOString()).sort()).toEqual(['2026-11-09T10:00:00.000Z', '2026-11-10T10:00:00.000Z', '2026-11-11T10:00:00.000Z']);
  });
});
