/**
 * Access rights of the calendars: which group a calendar falls in, and how the
 * PROPFIND answer is read.
 */

import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { CalendarService } from '../../src/caldav/calendar-service.js';
import type { Config } from '../../src/config/schema.js';
import type { DAVClientType } from '../../src/caldav/client.js';
import {
  calendarKey,
  classifyAccess,
  privilegeNames,
  samePrincipal,
  shareAccess,
} from '../../src/caldav/access.js';

const READ_ONLY = ['read', 'readacl', 'readcurrentuserprivilegeset', 'readfreebusy', 'writeproperties'];
const WRITABLE = [...READ_ONLY, 'write', 'writecontent', 'bind', 'unbind', 'writeacl', 'share'];

describe('classifyAccess', () => {
  it('puts a calendar the account can write to and owns in "mine"', () => {
    expect(classifyAccess('/principals/users/alice/', '/principals/users/alice/', WRITABLE)).toBe('mine');
  });

  it('puts somebody else\'s calendar shared with write access in "write"', () => {
    expect(classifyAccess('/principals/team-calendars/t1/', '/principals/users/alice/', WRITABLE)).toBe('write');
  });

  it('puts a calendar without a write privilege in "read"', () => {
    expect(classifyAccess('/principals/users/alice/', '/principals/users/alice/', READ_ONLY)).toBe('read');
  });

  it('reads as "read" a shared calendar whose owner the server reports as the account', () => {
    // SabreDAV answers the calendar home owner for a calendar shared with the account
    expect(classifyAccess('/principals/users/alice/', '/principals/users/alice/', READ_ONLY)).toBe('read');
  });

  it('keeps write access when the server gives no owner', () => {
    expect(classifyAccess(undefined, '/principals/users/alice/', WRITABLE)).toBe('mine');
    expect(classifyAccess('/principals/users/alice/', undefined, WRITABLE)).toBe('mine');
  });

  it('counts DAV:all as write access', () => {
    expect(classifyAccess('/principals/users/alice/', '/principals/users/alice/', ['read', 'all'])).toBe('mine');
    expect(classifyAccess('/principals/users/team/', '/principals/users/alice/', ['read', 'all'])).toBe('write');
  });

  it('trusts the sharing access a server publishes', () => {
    // SabreDAV answers the receiving account as the owner of a calendar shared with it
    expect(classifyAccess('/principals/users/alice/', '/principals/users/alice/', WRITABLE, 'read-write')).toBe('write');
    expect(classifyAccess('/principals/users/alice/', '/principals/users/alice/', WRITABLE, 'read')).toBe('read');
    expect(classifyAccess('/principals/users/alice/', '/principals/users/alice/', WRITABLE)).toBe('mine');
    // a sharing access wins over a privilege that contradicts it
    expect(classifyAccess('/principals/users/alice/', '/principals/users/alice/', WRITABLE, 'read')).toBe('read');
    expect(classifyAccess('/principals/users/alice/', '/principals/users/alice/', READ_ONLY, 'read-write')).toBe('read');
  });

  it('does not mistake write-properties for write access', () => {
    expect(classifyAccess('/principals/users/alice/', '/principals/users/alice/', ['read', 'writeproperties'])).toBe('read');
  });
});

describe('privilegeNames', () => {
  it('reads one privilege', () => {
    expect(privilegeNames({ privilege: { write: {} } })).toEqual(['write']);
  });

  it('reads a list of privileges, lower-cased', () => {
    expect(privilegeNames({ privilege: [{ read: {} }, { writeContent: {} }] })).toEqual(['read', 'writecontent']);
  });

  it('reads nothing from an answer without the property', () => {
    expect(privilegeNames(undefined)).toEqual([]);
    expect(privilegeNames({})).toEqual([]);
  });
});

describe('shareAccess', () => {
  it('reads the sharing access of a calendar', () => {
    expect(shareAccess({ '{DAV:}shareAccess': { 'read-write': {} } })).toBe('read-write');
    expect(shareAccess({ shareAccess: { read: {} } })).toBe('read');
  });

  it('says nothing when the server does not publish it, or says the calendar is not shared', () => {
    expect(shareAccess(undefined)).toBeUndefined();
    expect(shareAccess({ displayname: 'XG' })).toBeUndefined();
    // Twake Calendar answers not-shared for every calendar of the account
    expect(shareAccess({ '{DAV:}shareAccess': { 'not-shared': {} } })).toBeUndefined();
    // an unknown value is not read as a share either
    expect(shareAccess({ '{DAV:}shareAccess': { 'shared-owner': {} } })).toBeUndefined();
  });
});

describe('calendarKey and samePrincipal', () => {
  it('gives one key to an URL, to its href and to its encoded form', () => {
    const url = 'https://dav.example.com/dav/calendars/u1/My%20Calendar/';
    expect(calendarKey(url)).toBe('/dav/calendars/u1/My Calendar');
    expect(calendarKey('/dav/calendars/u1/My Calendar/')).toBe('/dav/calendars/u1/My Calendar');
  });

  it('matches principals with and without the trailing slash', () => {
    expect(samePrincipal('/principals/users/alice/', '/principals/users/alice')).toBe(true);
    expect(samePrincipal('/principals/users/alice/', '/principals/users/bob/')).toBe(false);
    expect(samePrincipal(undefined, '/principals/users/alice/')).toBe(false);
  });
});

describe('CalendarService: the first discovery', () => {
  const logger = pino({ level: 'silent' });

  it('makes a second tool call wait for the access rights', async () => {
    // the calendars are known, their rights are still on the wire: a tool call arriving
    // now must wait for them instead of seeing a calendar set without any rights
    const calendars = [{ url: 'https://dav.example.com/calendars/u1/XG/', displayName: 'XG' }];
    let answer: (value: unknown) => void = () => undefined;
    const pending = new Promise((resolve) => {
      answer = resolve;
    });
    const client = {
      fetchCalendars: async () => calendars,
      propfind: () => pending,
      fetchCalendarObjects: async () => [],
    } as unknown as DAVClientType;

    const service = new CalendarService(client, logger, {} as Config);
    const first = service.listCalendars();
    await new Promise((resolve) => setImmediate(resolve));
    const second = service.fetchEventsByAccess('mine');

    answer([
      {
        href: '/calendars/u1/XG/',
        props: {
          displayname: 'XG',
          owner: { href: '/principals/u1/' },
          currentUserPrincipal: { href: '/principals/u1/' },
          currentUserPrivilegeSet: { privilege: [{ read: {} }, { write: {} }, { writeContent: {} }] },
        },
      },
    ]);

    await expect(Promise.all([first, second])).resolves.toBeDefined();
    expect(service.calendarAccess(calendars[0])).toBe('mine');
  });
});

describe('CalendarService: refreshCalendars', () => {
  const logger = pino({ level: 'silent' });
  const calendars = [{ url: 'https://dav.example.com/calendars/u1/A/', displayName: 'A' }];
  const rights = [
    {
      href: '/calendars/u1/A/',
      props: {
        displayname: 'A',
        owner: { href: '/principals/u1/' },
        currentUserPrincipal: { href: '/principals/u1/' },
        currentUserPrivilegeSet: { privilege: [{ read: {} }, { write: {} }] },
      },
    },
  ];

  it('discovers the calendars on a fresh service, then again on each refresh', async () => {
    let discoveries = 0;
    const client = {
      fetchCalendars: async () => {
        discoveries++;
        return calendars;
      },
      propfind: async () => rights,
      fetchCalendarObjects: async () => [],
    } as unknown as DAVClientType;

    const service = new CalendarService(client, logger, {} as Config);
    await expect(service.refreshCalendars()).resolves.toHaveLength(1);
    expect(discoveries).toBe(1);
    await service.refreshCalendars();
    expect(discoveries).toBe(2);
    expect(service.calendarAccess(calendars[0])).toBe('mine');
  });

  it('waits for a discovery already running before starting its own', async () => {
    let answer: (value: unknown) => void = () => undefined;
    let discoveries = 0;
    const client = {
      fetchCalendars: async () => {
        discoveries++;
        return calendars;
      },
      propfind: () => (discoveries === 1 ? new Promise((resolve) => { answer = resolve; }) : Promise.resolve(rights)),
      fetchCalendarObjects: async () => [],
    } as unknown as DAVClientType;

    const service = new CalendarService(client, logger, {} as Config);
    const first = service.listCalendars();
    const refreshed = service.refreshCalendars();

    // let the first discovery reach its PROPFIND
    await new Promise((resolve) => setImmediate(resolve));
    answer(rights);
    await first;
    await expect(refreshed).resolves.toHaveLength(1);
    expect(service.calendarAccess(calendars[0])).toBe('mine');
  });
});
