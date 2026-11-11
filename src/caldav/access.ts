/**
 * Calendar access rights
 *
 * A CalDAV account usually sees more than its own calendars: colleagues share
 * theirs, some read-only, and a team calendar is writable without being owned.
 * `DAV:current-user-privilege-set` (RFC 3744) tells what the account may do with
 * each of them, and `DAV:owner` who owns it, which is enough to put every calendar
 * in one of three groups: the user's own, shared with write access, shared
 * read-only.
 *
 * Servers without ACL support simply answer nothing: the access of every calendar
 * stays unknown and the caller falls back to listing them all.
 */

import type { Logger } from 'pino';
import type { DAVCalendar } from 'tsdav';
import type { DAVClientType } from './client.js';

/** What the account may do with a calendar */
export type CalendarAccess = 'mine' | 'write' | 'read';

export interface CalendarSharing {
  access: CalendarAccess;
  /** href of the DAV:owner principal, as the server gives it */
  owner?: string;
}

/** Privileges that allow changing the events of a calendar (DAV:write, DAV:write-content, and DAV:all) */
const WRITE_PRIVILEGES = new Set(['write', 'writecontent', 'all']);

/** Normalize an href or an URL to the path that identifies the collection (prefix, encoding, trailing slash aside) */
export function calendarKey(value: string): string {
  let path = value;
  try {
    path = new URL(value, 'http://dav.invalid').pathname;
  } catch {
    // an href the parser refuses is compared as it came
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    // a malformed escape: keep it as it came
  }
  return path.replace(/\/+$/, '');
}

/** Whether two hrefs name the same principal (trailing slashes and encoding aside) */
export function samePrincipal(a?: string, b?: string): boolean {
  return !!a && !!b && calendarKey(a) === calendarKey(b);
}

/**
 * Privilege names of a `DAV:current-user-privilege-set`, as tsdav parses them
 *
 * tsdav gives `<d:privilege><d:write-content/></d:privilege>` as `{ writeContent: {} }`.
 *
 * @param privilegeSet - the parsed property, in any of its shapes
 * @returns the privilege names, lower-cased
 */
export function privilegeNames(privilegeSet: unknown): string[] {
  const value = (privilegeSet as { privilege?: unknown } | undefined)?.privilege;
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list
    .flatMap((entry) => Object.keys((entry ?? {}) as Record<string, unknown>))
    .map((name) => name.toLowerCase());
}

/**
 * The access a calendar was shared with, when the server publishes it
 *
 * `DAV:share-access` (the CalDAV sharing extension, also on SabreDAV) answers `read` or
 * `read-write` for a calendar somebody shares with the account, and nothing for its own.
 * It is the only reliable signal there: such a server answers the receiving account as
 * `DAV:owner`, so the owner alone cannot tell a calendar shared with write access from
 * one the account owns.
 *
 * @param props - the properties of one calendar, as tsdav parses them
 * @returns the sharing access, or undefined when the server says nothing
 */
export function shareAccess(props: Record<string, unknown> | undefined): 'read' | 'read-write' | undefined {
  if (!props) return undefined;
  for (const [key, value] of Object.entries(props)) {
    if (!/share-?access$/i.test(key.replace(/^\{[^}]*\}/, ''))) continue;
    const inner = Object.keys((value ?? {}) as Record<string, unknown>).map((name) => name.toLowerCase().replace(/[-_]/g, ''));
    if (inner.includes('readwrite')) return 'read-write';
    if (inner.includes('read')) return 'read';
  }
  return undefined;
}

/**
 * Put a calendar in one of the three groups
 *
 * A calendar the account cannot write to is read-only, whoever owns it: some servers
 * answer the account's own principal as `DAV:owner` for a calendar shared with it
 * read-only (SabreDAV does), the privileges are the reliable half of the answer.
 *
 * @param owner - href of `DAV:owner`, when the server gives one
 * @param principal - href of `DAV:current-user-principal`
 * @param privileges - lower-cased privilege names, see privilegeNames()
 * @returns "read" without a write privilege, else "mine" when the account owns the
 *   calendar, or "write" when it is somebody else's calendar shared with write access
 */
export function classifyAccess(
  owner: string | undefined,
  principal: string | undefined,
  privileges: string[],
  shared: 'read' | 'read-write' | undefined = undefined
): CalendarAccess {
  // what the server says about the sharing wins, in both directions: a calendar shared with write
  // access is writable, one shared read-only is not, whatever the privileges add
  if (shared === 'read') return 'read';
  if (shared === 'read-write') return 'write';
  if (!privileges.some((name) => WRITE_PRIVILEGES.has(name))) return 'read';
  return !owner || !principal || samePrincipal(owner, principal) ? 'mine' : 'write';
}

/**
 * Ask the calendar home for the access rights of every calendar
 *
 * One PROPFIND on the parent of the calendars: its answer covers all of them. The
 * caller decides what a failure means; a server without ACL properties simply answers
 * no privilege, which classifies nothing.
 *
 * @param client - CalDAV client instance
 * @param calendars - calendars discovered by tsdav
 * @param logger - Pino logger
 * @returns access rights per calendar, under the key of calendarKey(url)
 * @throws whatever the PROPFIND throws, so that the caller can retry it
 */
export async function discoverCalendarAccess(
  client: DAVClientType,
  calendars: DAVCalendar[],
  logger: Logger
): Promise<Map<string, CalendarSharing>> {
  const sharing = new Map<string, CalendarSharing>();
  const first = calendars[0]?.url;
  if (!first) return sharing;

  // one home usually holds every calendar, but an account may have several: ask each
  const homes = [...new Set(calendars.map((calendar) => new URL('..', calendar.url.endsWith('/') ? calendar.url : `${calendar.url}/`).href))];
  const responses: Array<{ href?: string; props?: Record<string, unknown> }> = [];
  let failure: unknown;
  for (const home of homes) {
    try {
      responses.push(...(await client.propfind({
        url: home,
        depth: '1',
        props: {
          'd:displayname': {},
          'd:owner': {},
          'd:current-user-principal': {},
          'd:current-user-privilege-set': {},
          'd:share-access': {},
        },
      })));
    } catch (err) {
      // one home that refuses must not hide the rights of the others
      logger.warn({ err, home }, 'Calendar access rights not available for one calendar home');
      failure ??= err;
    }
  }
  // every home failed: the caller retries, and leaves the rights unknown if it keeps failing
  if (responses.length === 0 && failure !== undefined) throw failure;

  const principal =
    responses.map((response) => (response.props?.currentUserPrincipal as { href?: string } | undefined)?.href).find((href) => !!href) ??
    // some servers give the principal of the account with the client, not with the calendar home
    (client as { account?: { principalUrl?: string } }).account?.principalUrl;

  // the home itself, the inbox and the outbox answer the same properties: only the calendars count
  const discovered = new Set(calendars.map((calendar) => calendarKey(calendar.url)));

  for (const response of responses) {
    if (!response.href || !discovered.has(calendarKey(response.href))) continue;
    const privileges = privilegeNames(response.props?.currentUserPrivilegeSet);
    if (privileges.length === 0) continue; // the server does not tell
    const owner = (response.props?.owner as { href?: string } | undefined)?.href;
    const entry: CalendarSharing = { access: classifyAccess(owner, principal, privileges, shareAccess(response.props)), ...(owner ? { owner } : {}) };
    sharing.set(calendarKey(response.href), entry);
  }

  logger.info({ count: sharing.size, homes }, 'Discovered calendar access rights');
  return sharing;
}

/** The names the query tools accept for a group of calendars, by lowercase name */
export const CALENDAR_GROUPS: Record<string, CalendarAccess[]> = {
  mine: ['mine'],
  // everything the account may write: its own calendars and the ones shared with write access
  writable: ['mine', 'write'],
  'shared-write': ['write'],
  'read-only': ['read'],
  readonly: ['read'],
};

/**
 * Whether a name designates a group of calendars rather than one calendar
 *
 * @param name - what the model or the configuration gave as a calendar
 * @returns true for "mine", "writable", "shared-write", "read-only" and "readonly", whatever the case and spaces
 */
export function isCalendarGroup(name: string): boolean {
  return Object.hasOwn(CALENDAR_GROUPS, name.trim().toLowerCase());
}
