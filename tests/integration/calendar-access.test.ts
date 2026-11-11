/**
 * Calendars shared with the account: list_calendars tells them apart, and the query
 * tools can be pointed at one group ("mine", "writable", "read-only").
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import pino from 'pino';
import { createDualClients } from '../../src/caldav/client.js';
import { CalendarService } from '../../src/caldav/calendar-service.js';
import { AddressBookService } from '../../src/caldav/addressbook-service.js';
import { createServer } from '../../src/server.js';
import type { Config } from '../../src/config/schema.js';
import { calendarObjects, startFakeDav, type FakeDav } from '../helpers/fake-dav.js';

const logger = pino({ level: 'silent' });

// Starting now is today in the time zone of any machine.
const now = `${new Date().toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
const event = (uid: string, summary: string) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:${now}\r\nDURATION:PT1H\r\nSUMMARY:${summary}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

const CALENDARS = ['Perso', 'Shared', 'Team'];

describe('calendar access rights', () => {
  let dav: FakeDav;
  let client: Client;

  beforeAll(async () => {
    dav = await startFakeDav(CALENDARS, { readOnly: ['Shared'], sharedWithWrite: ['Team'] });
    const config = { DAV_URL: dav.url, DAV_AUTH_METHOD: 'basic', DAV_USERNAME: 'u', DAV_PASSWORD: 'p' } as Config;
    const clients = await createDualClients(config, logger);
    const server = createServer(new CalendarService(clients.caldav, logger, config), new AddressBookService(clients.carddav, logger), logger);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await dav.close();
  });

  beforeEach(() => {
    dav.requests.length = 0;
    dav.handler = (req) => {
      if (req.method !== 'REPORT') return null;
      const calendar = CALENDARS.find((c) => req.url.includes(`/${c}/`));
      if (!calendar) return { status: 404 };
      return calendarObjects([{ href: `/calendars/u1/${calendar}/${calendar}.ics`, ical: event(calendar, `Event of ${calendar}`) }]);
    };
  });

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return (result.content as Array<{ text: string }>).map((c) => c.text).join('\n');
  };

  it('lists the calendars in three groups', async () => {
    const text = await call('list_calendars');

    expect(text).toContain('Available calendars (3): 1 yours, 1 shared with write access, 1 read-only');
    expect(text).toContain('My calendars (1):');
    expect(text).toContain('Shared with write access (1):');
    expect(text).toContain('Read-only (1):');

    // each name sits in its own section
    const mine = text.slice(text.indexOf('My calendars'), text.indexOf('Shared with write access'));
    const write = text.slice(text.indexOf('Shared with write access'), text.indexOf('Read-only ('));
    const read = text.slice(text.indexOf('Read-only'), text.indexOf('Use calendar:'));
    expect(mine).toContain('Perso');
    expect(write).toContain('Team');
    expect(read).toContain('Shared');
  });

  it('queries only the calendars of the requested group', async () => {
    expect(await call('get_todays_schedule', { calendar: 'mine' })).toContain('Event of Perso');
    expect(dav.requests.filter((r) => r.method === 'REPORT').every((r) => r.url.includes('/Perso/'))).toBe(true);

    // "writable" covers the account's own calendars and the ones shared with write access
    dav.requests.length = 0;
    const writable = await call('get_todays_schedule', { calendar: 'writable' });
    expect(writable).toContain('Event of Perso');
    expect(writable).toContain('Event of Team');
    expect(dav.requests.filter((r) => r.method === 'REPORT').every((r) => !r.url.includes('/Shared/'))).toBe(true);

    // "shared-write" keeps only the calendars somebody else shares with write access
    dav.requests.length = 0;
    expect(await call('get_todays_schedule', { calendar: 'shared-write' })).toContain('Event of Team');
    expect(dav.requests.filter((r) => r.method === 'REPORT').every((r) => r.url.includes('/Team/'))).toBe(true);
  });

  it('accepts "read-only" and "readonly"', async () => {
    expect(await call('get_todays_schedule', { calendar: 'read-only' })).toContain('Event of Shared');
    expect(await call('get_todays_schedule', { calendar: 'READONLY' })).toContain('Event of Shared');
  });

  it('keeps a calendar name working', async () => {
    expect(await call('get_todays_schedule', { calendar: 'Team' })).toContain('Event of Team');
  });

  it('puts a calendar shared with write access in "write", even when the server names the account as its owner', async () => {
    const shared = await startFakeDav(['Perso', 'Friend'], { shareAccess: { Friend: 'read-write' } });
    try {
      const config = { DAV_URL: shared.url, DAV_AUTH_METHOD: 'basic', DAV_USERNAME: 'u', DAV_PASSWORD: 'p' } as Config;
      const clients = await createDualClients(config, logger);
      const service = new CalendarService(clients.caldav, logger, config);

      const calendars = await service.listCalendars();
      const friend = calendars.find((calendar) => calendar.displayName === 'Friend')!;
      expect(service.calendarAccess(friend)).toBe('write');
      expect(service.calendarAccess(calendars.find((calendar) => calendar.displayName === 'Perso')!)).toBe('mine');
    } finally {
      await shared.close();
    }
  });

  it('waits for the access rights when two tools are called at once', async () => {
    // a fresh service, as when an assistant calls list_calendars and get_todays_schedule together
    const config = { DAV_URL: dav.url, DAV_AUTH_METHOD: 'basic', DAV_USERNAME: 'u', DAV_PASSWORD: 'p' } as Config;
    const clients = await createDualClients(config, logger);
    const service = new CalendarService(clients.caldav, logger, config);

    const [calendars, objects] = await Promise.all([service.listCalendars(), service.fetchEventsByAccess('mine')]);

    expect(calendars.map((calendar) => calendar.displayName)).toEqual(['Perso', 'Shared', 'Team']);
    expect(service.calendarAccess(calendars[0])).toBe('mine');
    expect(objects.length).toBeGreaterThan(0);
  });

  it('explains a server that does not publish the access rights', async () => {
    const blind = await startFakeDav(['Perso'], { withoutAccessRights: true });
    try {
      const config = { DAV_URL: blind.url, DAV_AUTH_METHOD: 'basic', DAV_USERNAME: 'u', DAV_PASSWORD: 'p', DAV_ORGANIZER_EMAIL: 'u@example.com' } as Config;
      const clients = await createDualClients(config, logger);
      const service = new CalendarService(clients.caldav, logger, config);

      expect(service.calendarAccess((await service.listCalendars())[0])).toBeUndefined();
      await expect(service.fetchEventsByAccess('mine')).rejects.toThrow(/does not publish the access rights[\s\S]*name a calendar or use "all"/);
    } finally {
      await blind.close();
    }
  });

  it('lets a calendar keep a name that looks like a group', async () => {
    const named = await startFakeDav(['Perso', 'mine'], { readOnly: ['mine'] });
    named.handler = (req) => {
      if (req.method !== 'REPORT') return null;
      const calendar = ['Perso', 'mine'].find((c) => req.url.includes(`/${c}/`));
      if (!calendar) return { status: 404 };
      return calendarObjects([{ href: `/calendars/u1/${calendar}/${calendar}.ics`, ical: event(calendar, `Event of ${calendar}`) }]);
    };
    try {
      const config = { DAV_URL: named.url, DAV_AUTH_METHOD: 'basic', DAV_USERNAME: 'u', DAV_PASSWORD: 'p' } as Config;
      const clients = await createDualClients(config, logger);
      const server = createServer(new CalendarService(clients.caldav, logger, config), new AddressBookService(clients.carddav, logger), logger);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const scoped = new Client({ name: 'test', version: '1' }, { capabilities: {} });
      await scoped.connect(clientTransport);

      // the calendar named "mine" answers, not the group of the calendars the account owns
      const answer = await scoped.callTool({ name: 'get_todays_schedule', arguments: { calendar: 'mine' } });
      const text = (answer.content as Array<{ text: string }>).map((c) => c.text).join('\n');
      expect(text).toContain('Event of mine');
      expect(text).not.toContain('Event of Perso');
      await scoped.close();
    } finally {
      await named.close();
    }
  });

  it('refuses to write into a group, saying why', async () => {
    const config = { DAV_URL: dav.url, DAV_AUTH_METHOD: 'basic', DAV_USERNAME: 'u', DAV_PASSWORD: 'p' } as Config;
    const clients = await createDualClients(config, logger);
    const service = new CalendarService(clients.caldav, logger, config);

    await expect(service.createEvent('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', 'mine')).rejects.toThrow(/is a group of calendars[\s\S]*list_calendars/);
  });

  it('takes a default calendar of "all" as no default at all', async () => {
    const config = { DAV_URL: dav.url, DAV_AUTH_METHOD: 'basic', DAV_USERNAME: 'u', DAV_PASSWORD: 'p' } as Config;
    const clients = await createDualClients(config, logger);
    const service = new CalendarService(clients.caldav, logger, config);
    const server = createServer(service, new AddressBookService(clients.carddav, logger), logger, 'all');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const scoped = new Client({ name: 'test', version: '1' }, { capabilities: {} });
    await scoped.connect(clientTransport);

    const answer = await scoped.callTool({ name: 'get_todays_schedule', arguments: {} });
    const text = (answer.content as Array<{ text: string }>).map((c) => c.text).join('\n');
    expect(text).toContain('Event of Perso');
    expect(text).toContain('Event of Shared');
    expect(text).toContain('Event of Team');
    await scoped.close();
  });

  it('reads the invitations of every calendar when the default is "all" or a group', async () => {
    for (const configured of ['all', 'mine']) {
      const config = { DAV_URL: dav.url, DAV_AUTH_METHOD: 'basic', DAV_USERNAME: 'u', DAV_PASSWORD: 'p', DAV_DEFAULT_CALENDAR: configured, DAV_ORGANIZER_EMAIL: 'u@example.com' } as Config;
      const clients = await createDualClients(config, logger);
      const service = new CalendarService(clients.caldav, logger, config);

      await expect(service.listPendingInvitations(undefined, undefined), configured).resolves.toEqual([]);
      // "all" still means every calendar, whatever the default
      await expect(service.listPendingInvitations(undefined, 'all'), configured).resolves.toEqual([]);
    }
  });

  it('searches the calendars of the group for a writing tool that finds an event by UID', async () => {
    const config = { DAV_URL: dav.url, DAV_AUTH_METHOD: 'basic', DAV_USERNAME: 'u', DAV_PASSWORD: 'p', DAV_DEFAULT_CALENDAR: 'mine' } as Config;
    const clients = await createDualClients(config, logger);
    const service = new CalendarService(clients.caldav, logger, config);

    dav.requests.length = 0;
    await service.findEventByUid('a-uid', 'mine').catch(() => null);
    const queried = dav.requests.filter((request) => request.method === 'REPORT').map((request) => request.url);
    expect(queried.length).toBeGreaterThan(0);
    expect(queried.every((url) => url.includes('/Perso/'))).toBe(true);
  });

  it('still finds an event by UID when the server refuses the UID filter and the default is a group', async () => {
    const refusing = await startFakeDav(['Perso', 'Shared'], { readOnly: ['Shared'] });
    refusing.handler = (req) => {
      if (req.method !== 'REPORT') return null;
      // the server does not support the UID property filter: a 501 makes the code scan the calendars
      if (req.body.includes('UID')) return { status: 501 };
      return calendarObjects([{ href: '/calendars/u1/Perso/a.ics', ical: event('a', 'Event of Perso') }]);
    };
    try {
      const config = { DAV_URL: refusing.url, DAV_AUTH_METHOD: 'basic', DAV_USERNAME: 'u', DAV_PASSWORD: 'p', DAV_DEFAULT_CALENDAR: 'mine' } as Config;
      const clients = await createDualClients(config, logger);
      const service = new CalendarService(clients.caldav, logger, config);

      await expect(service.findEventByUid('a', 'mine')).resolves.toMatchObject({ uid: 'a' });
    } finally {
      await refusing.close();
    }
  });

  it('lets a calendar really named "mine" keep it for the tools that find an event by UID', async () => {
    const named = await startFakeDav(['Perso', 'mine'], { readOnly: ['mine'] });
    named.handler = (req) => {
      if (req.method !== 'REPORT') return null;
      const calendar = ['Perso', 'mine'].find((c) => req.url.includes(`/${c}/`));
      if (!calendar) return { status: 404 };
      return calendarObjects([{ href: `/calendars/u1/${calendar}/${calendar}.ics`, ical: event(calendar, `Event of ${calendar}`) }]);
    };
    try {
      const config = { DAV_URL: named.url, DAV_AUTH_METHOD: 'basic', DAV_USERNAME: 'u', DAV_PASSWORD: 'p' } as Config;
      const clients = await createDualClients(config, logger);
      const service = new CalendarService(clients.caldav, logger, config);

      named.requests.length = 0;
      // the event the calendar named "mine" holds
      await expect(service.findEventByUid('mine', 'mine')).resolves.toMatchObject({ uid: 'mine' });
      const queried = named.requests.filter((request) => request.method === 'REPORT').map((request) => request.url);
      expect(queried.length).toBeGreaterThan(0);
      expect(queried.every((url) => url.includes('/mine/'))).toBe(true);
    } finally {
      await named.close();
    }
  });

  it('says a calendar name or a group matches nothing, instead of "event not found"', async () => {
    const config = { DAV_URL: dav.url, DAV_AUTH_METHOD: 'basic', DAV_USERNAME: 'u', DAV_PASSWORD: 'p' } as Config;
    const clients = await createDualClients(config, logger);
    const service = new CalendarService(clients.caldav, logger, config);

    // a misspelled name
    await expect(service.findEventByUid('a', 'Persoo')).rejects.toThrow(/Calendar "Persoo" not found/);

    // a group with no calendar in it: an account that shares nothing
    const lonely = await startFakeDav(['Perso']);
    try {
      const lonelyConfig = { DAV_URL: lonely.url, DAV_AUTH_METHOD: 'basic', DAV_USERNAME: 'u', DAV_PASSWORD: 'p' } as Config;
      const lonelyClients = await createDualClients(lonelyConfig, logger);
      const lonelyService = new CalendarService(lonelyClients.caldav, logger, lonelyConfig);
      await expect(lonelyService.findEventByUid('a', 'shared-write')).rejects.toThrow(/No calendar with write access shared by somebody else/);
    } finally {
      await lonely.close();
    }
  });

  it('says a group matches nothing on a server that publishes no rights', async () => {
    const blind = await startFakeDav(['Perso'], { withoutAccessRights: true });
    try {
      const config = { DAV_URL: blind.url, DAV_AUTH_METHOD: 'basic', DAV_USERNAME: 'u', DAV_PASSWORD: 'p', DAV_ORGANIZER_EMAIL: 'u@example.com' } as Config;
      const clients = await createDualClients(config, logger);
      const service = new CalendarService(clients.caldav, logger, config);

      await expect(service.findEventByUid('a', 'mine')).rejects.toThrow(/does not publish the access rights/);
      await expect(service.listPendingInvitations(undefined, 'mine')).rejects.toThrow(/does not publish the access rights/);
    } finally {
      await blind.close();
    }
  });

  it('refuses to create an event in a group before asking for approval', async () => {
    const config = { DAV_URL: dav.url, DAV_AUTH_METHOD: 'basic', DAV_USERNAME: 'u', DAV_PASSWORD: 'p' } as Config;
    const clients = await createDualClients(config, logger);
    const service = new CalendarService(clients.caldav, logger, config);
    const server = createServer(service, new AddressBookService(clients.carddav, logger), logger, 'mine');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const scoped = new Client({ name: 'test', version: '1' }, { capabilities: {} });
    await scoped.connect(clientTransport);

    const answer = await scoped.callTool({ name: 'create_event', arguments: { title: 'Point', start: '2026-11-12T10:00:00', end: '2026-11-12T11:00:00' } });
    const text = (answer.content as Array<{ text: string }>).map((content) => content.text).join('\n');
    expect(text).toContain('"mine" is a group of calendars');
    // nothing was written, and no approval was asked
    expect(dav.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
    await scoped.close();
  });

  it('creates an event in a calendar really named "mine"', async () => {
    const named = await startFakeDav(['Perso', 'mine'], { readOnly: ['mine'] });
    named.handler = (req) => (req.method === 'PUT' ? { status: 201, headers: { etag: '"1"' } } : null);
    try {
      const config = { DAV_URL: named.url, DAV_AUTH_METHOD: 'basic', DAV_USERNAME: 'u', DAV_PASSWORD: 'p', DAV_APPROVAL: 'client' } as Config;
      const clients = await createDualClients(config, logger);
      const service = new CalendarService(clients.caldav, logger, config);
      const server = createServer(service, new AddressBookService(clients.carddav, logger), logger, 'mine', undefined, undefined, { DAV_APPROVAL: 'client' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const scoped = new Client({ name: 'test', version: '1' }, { capabilities: {} });
      await scoped.connect(clientTransport);

      const answer = await scoped.callTool({ name: 'create_event', arguments: { title: 'Point', start: '2026-11-12T10:00:00', end: '2026-11-12T11:00:00' } });
      const text = (answer.content as Array<{ text: string }>).map((content) => content.text).join('\n');
      // the calendar keeps its name: the group is not refused, the event goes there
      expect(text).not.toContain('is a group of calendars');
      expect(named.requests.some((request) => request.method === 'PUT' && request.url.includes('/mine/'))).toBe(true);
      await scoped.close();
    } finally {
      await named.close();
    }
  });

  it('reads "all" the same way in every tool, whatever the case', async () => {
    for (const name of ['all', 'ALL', ' All ']) {
      dav.requests.length = 0;
      const text = await call('get_todays_schedule', { calendar: name });
      expect(text, name).toContain('Event of Perso');
      expect(text, name).toContain('Event of Team');
      expect(text, name).not.toContain('not found');
    }
  });

  it('follows the default calendar in respond_to_invitation, like list_invitations', async () => {
    const config = { DAV_URL: dav.url, DAV_AUTH_METHOD: 'basic', DAV_USERNAME: 'u', DAV_PASSWORD: 'p', DAV_DEFAULT_CALENDAR: 'mine', DAV_ORGANIZER_EMAIL: 'u@example.com' } as Config;
    const clients = await createDualClients(config, logger);
    const service = new CalendarService(clients.caldav, logger, config);

    dav.requests.length = 0;
    await service.findInvitation('a').catch(() => null);
    const queried = dav.requests.filter((request) => request.method === 'REPORT').map((request) => request.url);
    // "mine" holds Perso only: the colleague's calendars are not asked
    expect(queried.length).toBeGreaterThan(0);
    expect(queried.every((url) => !url.includes('/Shared/') && !url.includes('/Team/'))).toBe(true);
  });

  it('does not take an odd calendar name for a group', async () => {
    // "constructor" and "__proto__" are properties of every object: they must be read as calendar names
    for (const name of ['constructor', '__proto__']) {
      await expect(call('get_todays_schedule', { calendar: name })).resolves.toContain(`Calendar "${name}" not found`);
    }
  });

  it('names the empty group and how to list the calendars', async () => {
    const lonely = await startFakeDav(['Perso']);
    try {
      const config = { DAV_URL: lonely.url, DAV_AUTH_METHOD: 'basic', DAV_USERNAME: 'u', DAV_PASSWORD: 'p' } as Config;
      const clients = await createDualClients(config, logger);
      const service = new CalendarService(clients.caldav, logger, config);

      await expect(service.fetchEventsByAccess('read')).rejects.toThrow(
        /No calendar with read-only access was found\.[\s\S]*list_calendars/
      );
    } finally {
      await lonely.close();
    }
  });
});
