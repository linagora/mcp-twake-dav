/**
 * Tests for recurring event expansion with exception handling
 *
 * Verifies that:
 * 1. Normal recurring instances are returned
 * 2. Instances excluded via EXDATE are filtered (handled by ical.js)
 * 3. Instances cancelled via RECURRENCE-ID + STATUS=CANCELLED are filtered
 */

import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';
import type { DAVCalendarObject } from 'tsdav';
import { getEventsWithRecurrenceExpansion } from '../../src/tools/calendar/utils.js';

// Create a mock logger
const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

describe('Recurring event expansion', () => {
  describe('RECURRENCE-ID + STATUS=CANCELLED handling', () => {
    it('should filter out cancelled instances using RECURRENCE-ID', () => {
      // iCalendar with a weekly recurring event where one instance is cancelled
      // via RECURRENCE-ID + STATUS=CANCELLED (not EXDATE)
      const icsWithCancelledInstance = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:test-recurring-cancelled@example.com
DTSTART:20260126T090000Z
DTEND:20260126T100000Z
RRULE:FREQ=WEEKLY;COUNT=4
SUMMARY:Weekly Meeting
END:VEVENT
BEGIN:VEVENT
UID:test-recurring-cancelled@example.com
RECURRENCE-ID:20260202T090000Z
DTSTART:20260202T090000Z
DTEND:20260202T100000Z
STATUS:CANCELLED
SUMMARY:Weekly Meeting
END:VEVENT
END:VCALENDAR`;

      const rawEvents: DAVCalendarObject[] = [
        {
          url: 'https://example.com/calendar/event.ics',
          etag: '"abc123"',
          data: icsWithCancelledInstance,
        },
      ];

      const timeRange = {
        start: '2026-01-20T00:00:00Z',
        end: '2026-02-28T23:59:59Z',
      };

      const events = getEventsWithRecurrenceExpansion(rawEvents, timeRange, mockLogger);

      // Should have 3 instances (Jan 26, Feb 9, Feb 16) - Feb 2 is cancelled
      expect(events).toHaveLength(3);

      // Verify the dates - Feb 2 should NOT be present
      const dates = events.map(e => e.startDate.toISOString().split('T')[0]);
      expect(dates).toContain('2026-01-26');
      expect(dates).not.toContain('2026-02-02'); // Cancelled instance
      expect(dates).toContain('2026-02-09');
      expect(dates).toContain('2026-02-16');
    });

    it('should include modified (non-cancelled) instances with updated details', () => {
      // iCalendar with a weekly recurring event where one instance is rescheduled
      const icsWithModifiedInstance = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:test-recurring-modified@example.com
DTSTART:20260126T090000Z
DTEND:20260126T100000Z
RRULE:FREQ=WEEKLY;COUNT=3
SUMMARY:Weekly Meeting
LOCATION:Room A
END:VEVENT
BEGIN:VEVENT
UID:test-recurring-modified@example.com
RECURRENCE-ID:20260202T090000Z
DTSTART:20260202T140000Z
DTEND:20260202T150000Z
SUMMARY:Weekly Meeting (Rescheduled)
LOCATION:Room B
END:VEVENT
END:VCALENDAR`;

      const rawEvents: DAVCalendarObject[] = [
        {
          url: 'https://example.com/calendar/event.ics',
          etag: '"abc123"',
          data: icsWithModifiedInstance,
        },
      ];

      const timeRange = {
        start: '2026-01-20T00:00:00Z',
        end: '2026-02-15T23:59:59Z',
      };

      const events = getEventsWithRecurrenceExpansion(rawEvents, timeRange, mockLogger);

      // Should have 3 instances (Jan 26, Feb 2 modified, Feb 9)
      expect(events).toHaveLength(3);

      // Find the Feb 2 instance and verify it has the modified details
      const feb2Event = events.find(e =>
        e.startDate.toISOString().startsWith('2026-02-02')
      );
      expect(feb2Event).toBeDefined();
      expect(feb2Event!.summary).toBe('Weekly Meeting (Rescheduled)');
      expect(feb2Event!.location).toBe('Room B');
      // Modified time: 14:00 instead of 09:00
      expect(feb2Event!.startDate.getUTCHours()).toBe(14);
    });

    it('should handle EXDATE exclusions (existing ical.js behavior)', () => {
      // iCalendar with EXDATE (the original method for excluding instances)
      const icsWithExdate = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:test-recurring-exdate@example.com
DTSTART:20260126T090000Z
DTEND:20260126T100000Z
RRULE:FREQ=WEEKLY;COUNT=4
EXDATE:20260202T090000Z
SUMMARY:Weekly Meeting
END:VEVENT
END:VCALENDAR`;

      const rawEvents: DAVCalendarObject[] = [
        {
          url: 'https://example.com/calendar/event.ics',
          etag: '"abc123"',
          data: icsWithExdate,
        },
      ];

      const timeRange = {
        start: '2026-01-20T00:00:00Z',
        end: '2026-02-28T23:59:59Z',
      };

      const events = getEventsWithRecurrenceExpansion(rawEvents, timeRange, mockLogger);

      // Should have 3 instances - Feb 2 excluded via EXDATE
      expect(events).toHaveLength(3);

      const dates = events.map(e => e.startDate.toISOString().split('T')[0]);
      expect(dates).not.toContain('2026-02-02');
    });

    it('should handle multiple cancelled instances', () => {
      // iCalendar with multiple cancelled instances
      const icsWithMultipleCancelled = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:test-multi-cancelled@example.com
DTSTART:20260126T090000Z
DTEND:20260126T100000Z
RRULE:FREQ=WEEKLY;COUNT=5
SUMMARY:Weekly Meeting
END:VEVENT
BEGIN:VEVENT
UID:test-multi-cancelled@example.com
RECURRENCE-ID:20260202T090000Z
DTSTART:20260202T090000Z
DTEND:20260202T100000Z
STATUS:CANCELLED
SUMMARY:Weekly Meeting
END:VEVENT
BEGIN:VEVENT
UID:test-multi-cancelled@example.com
RECURRENCE-ID:20260216T090000Z
DTSTART:20260216T090000Z
DTEND:20260216T100000Z
STATUS:CANCELLED
SUMMARY:Weekly Meeting
END:VEVENT
END:VCALENDAR`;

      const rawEvents: DAVCalendarObject[] = [
        {
          url: 'https://example.com/calendar/event.ics',
          etag: '"abc123"',
          data: icsWithMultipleCancelled,
        },
      ];

      const timeRange = {
        start: '2026-01-20T00:00:00Z',
        end: '2026-02-28T23:59:59Z',
      };

      const events = getEventsWithRecurrenceExpansion(rawEvents, timeRange, mockLogger);

      // Should have 3 instances (Jan 26, Feb 9, Feb 23) - Feb 2 and Feb 16 cancelled
      expect(events).toHaveLength(3);

      const dates = events.map(e => e.startDate.toISOString().split('T')[0]);
      expect(dates).toContain('2026-01-26');
      expect(dates).not.toContain('2026-02-02');
      expect(dates).toContain('2026-02-09');
      expect(dates).not.toContain('2026-02-16');
      expect(dates).toContain('2026-02-23');
    });
  });

  describe('RECURRENCE-ID carrying a TZID', () => {
    // Twake Calendar (and most clients) qualify RECURRENCE-ID with the series' TZID
    // instead of using UTC. A UTC occurrence never matched such a value, so moved and
    // cancelled instances were reported at their original slot.
    const VTIMEZONE = `BEGIN:VTIMEZONE
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
END:VTIMEZONE`;

    const series = (extra: string) => `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
${VTIMEZONE}
BEGIN:VEVENT
UID:test-tzid@example.com
DTSTART;TZID=Europe/Paris:20230405T110000
DTEND;TZID=Europe/Paris:20230405T120000
RRULE:FREQ=WEEKLY
SUMMARY:Cours
END:VEVENT
${extra}
END:VCALENDAR`;

    const expand = (ics: string, start: string, end: string) =>
      getEventsWithRecurrenceExpansion(
        [{ url: 'https://example.com/calendar/event.ics', etag: '"abc123"', data: ics }],
        { start, end },
        mockLogger
      );

    it('should not report an instance moved to another day at its original slot', () => {
      const ics = series(`BEGIN:VEVENT
UID:test-tzid@example.com
RECURRENCE-ID;TZID=Europe/Paris:20261111T110000
DTSTART;TZID=Europe/Paris:20261110T150000
DTEND;TZID=Europe/Paris:20261110T160000
SUMMARY:Cours
END:VEVENT`);

      // Wednesday 11 November 2026, the day of the moved occurrence
      const events = expand(ics, '2026-11-11T00:00:00Z', '2026-11-12T00:00:00Z');

      expect(events).toHaveLength(0);
    });

    it('should report an instance moved to another time at its new time', () => {
      const ics = series(`BEGIN:VEVENT
UID:test-tzid@example.com
RECURRENCE-ID;TZID=Europe/Paris:20261111T110000
DTSTART;TZID=Europe/Paris:20261111T150000
DTEND;TZID=Europe/Paris:20261111T160000
SUMMARY:Cours (déplacé)
END:VEVENT`);

      const events = expand(ics, '2026-11-11T00:00:00Z', '2026-11-12T00:00:00Z');

      expect(events).toHaveLength(1);
      expect(events[0].summary).toBe('Cours (déplacé)');
      // 15:00 in Paris is 14:00 UTC
      expect(events[0].startDate.toISOString()).toBe('2026-11-11T14:00:00.000Z');
    });

    it('should drop an instance cancelled with a TZID RECURRENCE-ID', () => {
      const ics = series(`BEGIN:VEVENT
UID:test-tzid@example.com
RECURRENCE-ID;TZID=Europe/Paris:20261111T110000
DTSTART;TZID=Europe/Paris:20261111T110000
DTEND;TZID=Europe/Paris:20261111T120000
STATUS:CANCELLED
SUMMARY:Cours
END:VEVENT`);

      const events = expand(ics, '2026-11-11T00:00:00Z', '2026-11-12T00:00:00Z');

      expect(events).toHaveLength(0);
    });

    it('should keep the untouched instances of the series', () => {
      const ics = series(`BEGIN:VEVENT
UID:test-tzid@example.com
RECURRENCE-ID;TZID=Europe/Paris:20261111T110000
DTSTART;TZID=Europe/Paris:20261111T110000
DTEND;TZID=Europe/Paris:20261111T120000
STATUS:CANCELLED
SUMMARY:Cours
END:VEVENT`);

      // The next week's instance still happens
      const events = expand(ics, '2026-11-18T00:00:00Z', '2026-11-19T00:00:00Z');

      expect(events).toHaveLength(1);
      expect(events[0].startDate.toISOString()).toBe('2026-11-18T10:00:00.000Z');
    });

    it('should drop a cancelled floating instance', () => {
      const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:test-floating@example.com
DTSTART:20230405T110000
DTEND:20230405T120000
RRULE:FREQ=WEEKLY
SUMMARY:Réunion
END:VEVENT
BEGIN:VEVENT
UID:test-floating@example.com
RECURRENCE-ID:20261111T110000
DTSTART:20261111T110000
DTEND:20261111T120000
STATUS:CANCELLED
SUMMARY:Réunion
END:VEVENT
END:VCALENDAR`;

      const events = expand(ics, '2026-11-11T00:00:00Z', '2026-11-12T00:00:00Z');

      expect(events).toHaveLength(0);
    });
  });
});
