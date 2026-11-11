/**
 * The "All-day events" section of check_availability lists an event once, even when several
 * calendars hold it: the busy periods are merged by themselves, but that list would repeat it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
const CALENDARS = ['Perso', 'Shared', 'Team'];

const holiday = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:ferie@example.com\r\nDTSTAMP:20260101T000000Z\r\nDTSTART;VALUE=DATE:20261111\r\nDTEND;VALUE=DATE:20261112\r\nSUMMARY:Armistice\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

describe('check_availability with an event on several calendars', () => {
  let dav: FakeDav;
  let client: Client;

  beforeAll(async () => {
    dav = await startFakeDav(CALENDARS);
    dav.handler = (req) => {
      if (req.method !== 'REPORT') return null;
      const calendar = CALENDARS.find((name) => req.url.includes(`/${name}/`));
      if (!calendar) return { status: 404 };
      return calendarObjects([{ href: `/calendars/u1/${calendar}/ferie.ics`, ical: holiday }]);
    };
    const config = { DAV_URL: dav.url, DAV_AUTH_METHOD: 'basic', DAV_USERNAME: 'u', DAV_PASSWORD: 'p' } as Config;
    const clients = await createDualClients(config, logger);
    const server = createServer(new CalendarService(clients.caldav, logger, config), new AddressBookService(clients.carddav, logger), logger, undefined, undefined, 'UTC');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await dav.close();
  });

  it('names the all-day event once', async () => {
    const answer = await client.callTool({ name: 'check_availability', arguments: { start: '2026-11-11T06:00:00Z', end: '2026-11-11T18:00:00Z' } });
    const text = (answer.content as Array<{ text: string }>).map((content) => content.text).join('\n');

    expect(text.match(/Armistice/g) ?? []).toHaveLength(1);
  });
});
