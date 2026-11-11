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

/** Privileges that allow changing the events of a calendar (DAV:write, DAV:write-content) */
const WRITE_PRIVILEGES = new Set(['write', 'writecontent']);

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
export function classifyAccess(owner: string | undefined, principal: string | undefined, privileges: string[]): CalendarAccess {
  if (!privileges.some((name) => WRITE_PRIVILEGES.has(name))) return 'read';
  return !owner || !principal || samePrincipal(owner, principal) ? 'mine' : 'write';
}

/**
 * Ask the calendar home for the access rights of every calendar
 *
 * One PROPFIND on the parent of the calendars: its answer covers all of them.
 * A server that does not support ACL properties, or a failed request, gives an empty
 * map rather than failing the tool call.
 *
 * @param client - CalDAV client instance
 * @param calendars - calendars discovered by tsdav
 * @param logger - Pino logger
 * @returns access rights per calendar, under the key of calendarKey(url) and of name:<display name>
 */
export async function discoverCalendarAccess(
  client: DAVClientType,
  calendars: DAVCalendar[],
  logger: Logger
): Promise<Map<string, CalendarSharing>> {
  const sharing = new Map<string, CalendarSharing>();
  const first = calendars[0]?.url;
  if (!first) return sharing;

  const home = new URL('..', first.endsWith('/') ? first : `${first}/`).href;
  let responses: Array<{ href?: string; props?: Record<string, unknown> }>;
  try {
    responses = await client.propfind({
      url: home,
      depth: '1',
      props: {
        'd:displayname': {},
        'd:owner': {},
        'd:current-user-principal': {},
        'd:current-user-privilege-set': {},
      },
    });
  } catch (err) {
    logger.warn({ err, home }, 'Calendar access rights not available, listing calendars without them');
    return sharing;
  }

  const principal = responses
    .map((response) => (response.props?.currentUserPrincipal as { href?: string } | undefined)?.href)
    .find((href) => !!href);

  for (const response of responses) {
    const privileges = privilegeNames(response.props?.currentUserPrivilegeSet);
    if (privileges.length === 0) continue; // the server does not tell, or this response is not a calendar
    const owner = (response.props?.owner as { href?: string } | undefined)?.href;
    const entry: CalendarSharing = { access: classifyAccess(owner, principal, privileges), ...(owner ? { owner } : {}) };
    if (response.href) sharing.set(calendarKey(response.href), entry);
    const name = response.props?.displayname;
    if (typeof name === 'string' && name) sharing.set(`name:${name.toLowerCase()}`, entry);
  }

  logger.info({ count: sharing.size, home }, 'Discovered calendar access rights');
  return sharing;
}
