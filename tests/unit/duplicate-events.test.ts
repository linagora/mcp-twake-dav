/**
 * The same event on several calendars is one event
 *
 * An invitation accepted and copied into the user's own calendar, a team meeting shown on every
 * member's calendar, an event shared twice: same UID, same times, one entry each.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';
import type { DAVCalendarObject } from 'tsdav';
import { getEventsWithRecurrenceExpansion, expandEvents, searchEventsByKeyword, deduplicateEvents } from '../../src/tools/calendar/utils.js';

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

  it('keeps the copy of the calendar listed first, even when another URL sorts before it', () => {
    const events = getEventsWithRecurrenceExpansion(
      [
        // "zeta" sorts after "alpha": the server order, not the URL, must decide
        event('https://dav.example.com/calendars/u1/zeta/e1.ics', 'shared@example.com', 'First of the server'),
        event('https://dav.example.com/calendars/u1/alpha/e1.ics', 'shared@example.com', 'Second of the server'),
      ],
      range,
      logger
    );

    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('First of the server');
    expect(events[0].url).toContain('/zeta/');
  });

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

  it('keeps one entry when the two copies differ only by content', () => {
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

  it('deduplicates a standalone occurrence against the series of another calendar', () => {
    // one calendar holds the series, another holds a single moved occurrence of it: same UID, the
    // RECURRENCE-ID written in the file and the slot of the series must meet
    const series = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:pair@example.com
DTSTAMP:20260101T000000Z
DTSTART:20261109T100000Z
DTEND:20261109T110000Z
RRULE:FREQ=DAILY;COUNT=3
SUMMARY:Comité
END:VEVENT
END:VCALENDAR`;
    const alone = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:pair@example.com
DTSTAMP:20260101T000000Z
RECURRENCE-ID:20261111T100000Z
DTSTART:20261110T100000Z
DTEND:20261110T110000Z
SUMMARY:Comité (déplacé)
END:VEVENT
END:VCALENDAR`;

    const events = getEventsWithRecurrenceExpansion(
      [
        { url: 'https://dav.example.com/calendars/u1/mine/s.ics', etag: '"1"', data: series } as DAVCalendarObject,
        { url: 'https://dav.example.com/calendars/u1/team/a.ics', etag: '"2"', data: alone } as DAVCalendarObject,
      ],
      { start: '2026-11-09T00:00:00Z', end: '2026-11-12T00:00:00Z' },
      logger
    );

    // 9 and 10 November from the series, and the moved occurrence once — not twice
    expect(events.filter((event) => event.summary === 'Comité (déplacé)')).toHaveLength(1);
    expect(events).toHaveLength(3);
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

  describe('an occurrence moved into the range from a slot outside it', () => {
    // the 13 November slot is outside the range: only the pass over the exceptions lists it
    const series = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:into@example.com
DTSTAMP:20260101T000000Z
DTSTART:20261109T100000Z
DTEND:20261109T110000Z
RRULE:FREQ=DAILY;COUNT=5
SUMMARY:Daily
END:VEVENT
BEGIN:VEVENT
UID:into@example.com
DTSTAMP:20260101T000000Z
RECURRENCE-ID:20261113T100000Z
DTSTART:20261110T100000Z
DTEND:20261110T110000Z
SUMMARY:Daily (moved in)
END:VEVENT
END:VCALENDAR`;
    const alone = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:into@example.com
DTSTAMP:20260101T000000Z
RECURRENCE-ID:20261113T100000Z
DTSTART:20261110T100000Z
DTEND:20261110T110000Z
SUMMARY:Daily (moved in)
END:VEVENT
END:VCALENDAR`;
    const range = { start: '2026-11-09T00:00:00Z', end: '2026-11-12T00:00:00Z' };
    const at = (url: string, data: string) => ({ url, etag: `"${url}"`, data }) as DAVCalendarObject;

    it('is listed once when two calendars hold the series, next to the occurrence it was moved onto', () => {
      const events = getEventsWithRecurrenceExpansion(
        [at('https://dav.example.com/calendars/u1/mine/s.ics', series), at('https://dav.example.com/calendars/u1/team/s.ics', series)],
        range,
        logger
      );

      // 9, 10 and 11 November from the series, and the occurrence of the 13th moved onto the 10th
      expect(events.map((event) => `${event.startDate.toISOString()} ${event.summary}`)).toEqual([
        '2026-11-09T10:00:00.000Z Daily',
        '2026-11-10T10:00:00.000Z Daily',
        '2026-11-10T10:00:00.000Z Daily (moved in)',
        '2026-11-11T10:00:00.000Z Daily',
      ]);
    });

    it('is listed once when another calendar holds it alone, with its RECURRENCE-ID', () => {
      const events = getEventsWithRecurrenceExpansion(
        [at('https://dav.example.com/calendars/u1/mine/s.ics', series), at('https://dav.example.com/calendars/u1/team/a.ics', alone)],
        range,
        logger
      );

      expect(events.filter((event) => event.summary === 'Daily (moved in)')).toHaveLength(1);
      expect(events).toHaveLength(4);
    });
  });

  describe('an occurrence one copy cancelled or moved out of the range', () => {
    // 9, 10 and 11 November; one calendar changed the 10th, the other holds the series unchanged
    const head = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:gone@example.com
DTSTAMP:20260101T000000Z
DTSTART:20261109T100000Z
DTEND:20261109T110000Z
RRULE:FREQ=DAILY;COUNT=3
SUMMARY:Daily`;
    const exception = (lines: string) => `
END:VEVENT
BEGIN:VEVENT
UID:gone@example.com
DTSTAMP:20260102T000000Z
RECURRENCE-ID:20261110T100000Z
${lines}
SUMMARY:Daily`;
    const unchanged = `${head}
END:VEVENT
END:VCALENDAR`;
    const exdated = `${head}
EXDATE:20261110T100000Z
END:VEVENT
END:VCALENDAR`;
    const cancelled = `${head}${exception('DTSTART:20261110T100000Z\nDTEND:20261110T110000Z\nSTATUS:CANCELLED')}
END:VEVENT
END:VCALENDAR`;
    const movedAway = `${head}${exception('DTSTART:20261120T100000Z\nDTEND:20261120T110000Z')}
END:VEVENT
END:VCALENDAR`;
    const cancelledAlone = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:gone@example.com
DTSTAMP:20260102T000000Z
RECURRENCE-ID:20261110T100000Z
DTSTART:20261110T100000Z
DTEND:20261110T110000Z
STATUS:CANCELLED
SUMMARY:Daily
END:VEVENT
END:VCALENDAR`;
    const range = { start: '2026-11-09T00:00:00Z', end: '2026-11-12T00:00:00Z' };
    const at = (url: string, data: string) => ({ url, etag: `"${url}"`, data }) as DAVCalendarObject;
    // the changed copy on the calendar the server lists first, then on the one it lists second
    const both = (changed: string) => [
      [at('https://dav.example.com/calendars/u1/mine/s.ics', changed), at('https://dav.example.com/calendars/u1/team/s.ics', unchanged)],
      [at('https://dav.example.com/calendars/u1/mine/s.ics', unchanged), at('https://dav.example.com/calendars/u1/team/s.ics', changed)],
    ];
    const starts = (events: { startDate: Date }[]) => events.map((e) => e.startDate.toISOString());
    const remaining = ['2026-11-09T10:00:00.000Z', '2026-11-11T10:00:00.000Z'];

    it.each(both(exdated))('is not listed when one copy excludes it with an EXDATE (%#)', (...calendars) => {
      expect(starts(getEventsWithRecurrenceExpansion(calendars, range, logger))).toEqual(remaining);
    });

    it.each(both(cancelled))('is not listed when one copy cancels it with a RECURRENCE-ID exception (%#)', (...calendars) => {
      expect(starts(getEventsWithRecurrenceExpansion(calendars, range, logger))).toEqual(remaining);
    });

    it.each(both(movedAway))('is not listed when one copy moved it out of the range (%#)', (...calendars) => {
      expect(starts(getEventsWithRecurrenceExpansion(calendars, range, logger))).toEqual(remaining);
    });

    it.each(both(cancelledAlone))('is not listed when another calendar holds it alone, cancelled (%#)', (...calendars) => {
      expect(starts(getEventsWithRecurrenceExpansion(calendars, range, logger))).toEqual(remaining);
    });

    it('is not listed when the EXDATE carries a TZID, like the series', () => {
      const paris = (exdate: string) => `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTIMEZONE
TZID:Europe/Paris
BEGIN:STANDARD
DTSTART:19701025T030000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:19700329T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
UID:paris@example.com
DTSTAMP:20260101T000000Z
DTSTART;TZID=Europe/Paris:20261109T100000
DTEND;TZID=Europe/Paris:20261109T110000
RRULE:FREQ=DAILY;COUNT=3
${exdate}SUMMARY:Daily
END:VEVENT
END:VCALENDAR`;
      const events = getEventsWithRecurrenceExpansion(
        [at('https://dav.example.com/calendars/u1/mine/s.ics', paris('')), at('https://dav.example.com/calendars/u1/team/s.ics', paris('EXDATE;TZID=Europe/Paris:20261110T100000\n'))],
        { start: '2026-11-08T00:00:00Z', end: '2026-11-13T00:00:00Z' },
        logger
      );

      expect(events).toHaveLength(2);
    });

    it('is not listed by a search either: the cancellation survives the filter', () => {
      const [, cancelledSecond] = both(cancelled);
      const found = searchEventsByKeyword(expandEvents(cancelledSecond, range, logger), 'daily');

      expect(starts(deduplicateEvents(found, logger)).sort()).toEqual(remaining);
    });

    it('leaves nothing behind when no other copy holds the occurrence', () => {
      const events = getEventsWithRecurrenceExpansion([at('https://dav.example.com/calendars/u1/mine/s.ics', exdated), at('https://dav.example.com/calendars/u1/mine/a.ics', cancelledAlone)], range, logger);

      expect(starts(events)).toEqual(remaining);
      expect(events.every((e) => e.summary === 'Daily')).toBe(true);
    });
  });
});
