/**
 * Minimal DAV server for tests that must exercise the real tsdav and its HTTP
 * handling: discovery answers are fixed, REPORT answers come from the test.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface DavReply {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

export interface DavRequest {
  method: string;
  url: string;
  body: string;
  headers: http.IncomingHttpHeaders;
}

export type DavHandler = (req: DavRequest, res: http.ServerResponse) => DavReply | null | void;
/** How the fake server shares its calendars (RFC 3744 properties) */
export interface FakeDavOptions {
  /** Calendars the account owns but may only read */
  readOnly?: string[];
  /** Calendars owned by somebody else and shared with write access */
  sharedWithWrite?: string[];
  /** A server without ACL support: answers no owner and no privilege */
  withoutAccessRights?: boolean;
  /** Calendars somebody shares with the account, and with which access (DAV:share-access) */
  shareAccess?: Record<string, 'read' | 'read-write'>;
}

const PRINCIPAL = '<d:href>/principals/u1/</d:href>';

/** DAV:owner, DAV:current-user-principal and DAV:current-user-privilege-set of one calendar */
function accessProps(name: string, options: FakeDavOptions, asked: (property: string) => boolean): string {
  if (options.withoutAccessRights) return '';
  const owner = options.sharedWithWrite?.includes(name) ? '<d:href>/principals/team-1/</d:href>' : PRINCIPAL;
  const privileges = options.readOnly?.includes(name)
    ? '<d:privilege><d:read/></d:privilege><d:privilege><d:read-free-busy/></d:privilege>'
    : '<d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege><d:privilege><d:write-content/></d:privilege>';
  // a WebDAV server only returns the properties of the request: so does this one, which is
  // what proves that the code asks for DAV:share-access
  const shared = asked('share-access') ? options.shareAccess?.[name] : undefined;
  const shareAccessProp = shared ? `<d:share-access><d:${shared}/></d:share-access>` : '';
  return `<d:owner>${owner}</d:owner><d:current-user-principal>${PRINCIPAL}</d:current-user-principal><d:current-user-privilege-set>${privileges}</d:current-user-privilege-set>${shareAccessProp}`;
}
const XML = { 'content-type': 'application/xml; charset=utf-8' };
const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:cs="http://calendarserver.org/ns/"';

function multistatus(responses: string): string {
  return `<?xml version="1.0"?><d:multistatus ${NS}>${responses}</d:multistatus>`;
}

function propResponse(href: string, props: string): string {
  return `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

/** A 207 calendar-query answer listing iCalendar objects. */
export function calendarObjects(objects: Array<{ href: string; ical: string }>): DavReply {
  const body = objects
    .map((o) => propResponse(o.href, `<d:getetag>"${o.href}"</d:getetag><c:calendar-data>${o.ical}</c:calendar-data>`))
    .join('');
  return { status: 207, body: multistatus(body), headers: XML };
}

/** A 207 addressbook-query answer listing vCards. */
export function addressObjects(objects: Array<{ href: string; vcard: string }>): DavReply {
  const body = objects
    .map((o) => propResponse(o.href, `<d:getetag>"${o.href}"</d:getetag><card:address-data>${o.vcard}</card:address-data>`))
    .join('');
  return { status: 207, body: multistatus(body), headers: XML };
}

function discovery(req: DavRequest, calendars: string[], options: FakeDavOptions = {}): DavReply {
  if (req.url.startsWith('/.well-known')) return { status: 404 };
  const prop = (name: string) => req.body.includes(name);
  if (req.url === '/calendars/u1/') {
    const list = calendars.map((c) =>
      propResponse(
        `/calendars/u1/${c}/`,
        `<d:displayname>${c}</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set><cs:getctag>1</cs:getctag>${accessProps(c, options, prop)}`
      )
    );
    return { status: 207, body: multistatus(list.join('')), headers: XML };
  }
  if (req.url === '/addressbooks/u1/') {
    const props = '<d:displayname>Contacts</d:displayname><d:resourcetype><d:collection/><card:addressbook/></d:resourcetype><cs:getctag>1</cs:getctag>';
    return { status: 207, body: multistatus(propResponse('/addressbooks/u1/contacts/', props)), headers: XML };
  }
  if (prop('supported-report-set')) {
    const reports = '<d:supported-report-set><d:supported-report><d:report><c:calendar-query/></d:report></d:supported-report><d:supported-report><d:report><c:calendar-multiget/></d:report></d:supported-report></d:supported-report-set>';
    return { status: 207, body: multistatus(propResponse(req.url, reports)), headers: XML };
  }
  if (prop('current-user-principal')) {
    return { status: 207, body: multistatus(propResponse('/', '<d:current-user-principal><d:href>/principals/u1/</d:href></d:current-user-principal>')), headers: XML };
  }
  const homes = '<c:calendar-home-set><d:href>/calendars/u1/</d:href></c:calendar-home-set><card:addressbook-home-set><d:href>/addressbooks/u1/</d:href></card:addressbook-home-set>';
  return { status: 207, body: multistatus(propResponse('/principals/u1/', homes)), headers: XML };
}

export interface FakeDav {
  url: string;
  requests: DavRequest[];
  /** Answers every request first; return nothing to fall through to discovery. */
  handler: DavHandler;
  close(): Promise<void>;
}

export async function startFakeDav(calendars = ['Perso'], options: FakeDavOptions = {}): Promise<FakeDav> {
  const fake: FakeDav = {
    url: '',
    requests: [],
    handler: () => null,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
  const server = http.createServer((incoming, res) => {
    let body = '';
    incoming.on('data', (chunk) => { body += chunk; });
    incoming.on('end', () => {
      const req: DavRequest = { method: incoming.method ?? '', url: incoming.url ?? '', body, headers: incoming.headers };
      fake.requests.push(req);
      const isDiscovery = req.method === 'PROPFIND' || req.url.startsWith('/.well-known');
      const reply = fake.handler(req, res) ?? (isDiscovery ? discovery(req, calendars, options) : undefined);
      // A handler that wrote nothing and returned undefined keeps the socket open on purpose.
      if (!reply) return;
      res.writeHead(reply.status, reply.headers);
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return fake;
}
