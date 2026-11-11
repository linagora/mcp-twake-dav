/**
 * Access rights of the calendars: which group a calendar falls in, and how the
 * PROPFIND answer is read.
 */

import { describe, it, expect } from 'vitest';
import {
  calendarKey,
  classifyAccess,
  privilegeNames,
  samePrincipal,
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
