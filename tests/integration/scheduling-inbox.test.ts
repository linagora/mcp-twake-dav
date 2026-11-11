/**
 * The scheduling inbox is read from the principal with a PROPFIND whose shape tsdav accepts.
 *
 * tsdav builds the body itself (`<propfind><prop>…`): properties nested under a `propfind` key end up
 * as a property *named* propfind, which a server answers 404 for — the inbox was never found.
 */

import { describe, it, expect, afterAll } from 'vitest';
import pino from 'pino';
import { createDualClients } from '../../src/caldav/client.js';
import { discoverSchedulingInbox } from '../../src/caldav/discovery.js';
import type { Config } from '../../src/config/schema.js';
import { startFakeDav, type FakeDav } from '../helpers/fake-dav.js';

const logger = pino({ level: 'silent' });
const INBOX = '/calendars/u1/inbox/';

/** The principal answers schedule-inbox-URL when, and only when, the request asks for it. */
function answer(fake: FakeDav): void {
  fake.handler = (req) => {
    if (req.method !== 'PROPFIND') return null;
    if (!req.body.includes('schedule-inbox-URL')) return { status: 207, body: '<d:multistatus xmlns:d="DAV:"/>' };
    // a server only returns well-formed properties: a request nesting <propfind> inside <prop> asks
    // for a property named propfind, and gets a 404 for it
    const nested = /<(?:\w+:)?prop>\s*<(?:\w+:)?propfind/.test(req.body);
    return {
      status: 207,
      headers: { 'content-type': 'application/xml; charset=utf-8' },
      body: nested
        ? '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/principals/u1/</d:href><d:propstat><d:prop><d:propfind/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response></d:multistatus>'
        : `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/principals/u1/</d:href><d:propstat><d:prop><c:schedule-inbox-URL><d:href>${INBOX}</d:href></c:schedule-inbox-URL></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
    };
  };
}

describe('discoverSchedulingInbox', () => {
  const servers: FakeDav[] = [];

  afterAll(async () => {
    for (const server of servers) await server.close();
  });

  const connect = async () => {
    const fake = await startFakeDav(['Perso']);
    servers.push(fake);
    const config = { DAV_URL: fake.url, DAV_AUTH_METHOD: 'basic', DAV_USERNAME: 'u', DAV_PASSWORD: 'p' } as Config;
    const clients = await createDualClients(config, logger);
    return { fake, client: clients.caldav };
  };

  it('reads the inbox the server publishes', async () => {
    const { fake, client } = await connect();
    answer(fake);

    await expect(discoverSchedulingInbox(client, `${fake.url}principals/u1/`, logger)).resolves.toBe(INBOX);
    const request = fake.requests.find((candidate) => candidate.body.includes('schedule-inbox-URL'));
    expect(request?.body).not.toMatch(/<(?:\w+:)?prop>\s*<(?:\w+:)?propfind/);
  });

  it('returns null when the server does not publish it', async () => {
    const { fake, client } = await connect();
    fake.handler = (req) => (req.method === 'PROPFIND' ? { status: 207, headers: { 'content-type': 'application/xml' }, body: '<d:multistatus xmlns:d="DAV:"/>' } : null);

    await expect(discoverSchedulingInbox(client, `${fake.url}principals/u1/`, logger)).resolves.toBeNull();
  });
});
