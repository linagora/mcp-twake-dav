/**
 * approve_batch: the user approves a list of writes once; each matching call with the batchId then runs
 * without another question, and anything else asks as usual.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from 'pino';
import { createServer } from '../../src/server.js';
import type { CalendarService } from '../../src/caldav/calendar-service.js';
import type { AddressBookService } from '../../src/caldav/addressbook-service.js';
import { buildICalString } from '../../src/transformers/event-builder.js';
import { buildVCardString } from '../../src/transformers/contact-builder.js';

const logger = { info() {}, debug() {}, warn() {}, error() {}, fatal() {}, trace() {}, child() { return logger; } } as unknown as Logger;

const start = new Date('2026-11-05T13:00:00Z');
const end = new Date('2026-11-05T14:00:00Z');
const eventRaw = buildICalString({ title: 'Point budget', start, end, timezone: 'Europe/Paris', organizer: { email: 'alice.martin@example.com', name: 'Alice MARTIN' }, attendees: [{ email: 'bob.durand@example.com', name: 'Bob DURAND' }] });
const event = {
  uid: 'ev-1', summary: 'Point budget', description: undefined, startDate: start, endDate: end, location: 'Salle 2', attendees: ['Bob DURAND'], attendeeDetails: [],
  timezone: 'Europe/Paris', status: undefined, isRecurring: false, allDay: false, recurrenceRule: undefined, url: 'https://dav.example.com/cal/ev-1.ics', etag: '"1"', _raw: eventRaw,
};
const contact = {
  uid: 'c-1', name: { formatted: 'Bob DURAND' }, emails: ['bob.durand@example.com'], phones: ['+33 1 23 45 67 89'], organization: 'Example', version: '4.0',
  url: 'https://dav.example.com/ab/c-1.vcf', etag: '"2"', _raw: buildVCardString({ name: 'Bob DURAND', email: 'bob.durand@example.com', phone: '+33 1 23 45 67 89', organization: 'Example' }),
};

function setup(opts: { answers?: ('accept' | 'decline')[]; elicitation?: boolean; approval?: 'elicit' | 'client' } = {}) {
  const writes: string[] = [];
  const prompts: string[] = [];
  const calendarService = {
    listCalendars: async () => [],
    findEventByUid: async () => event,
    resolveCalendarName: (name?: string) => (name === 'all' ? undefined : name),
    resolveCreateTarget: async () => ({ displayName: 'Perso', url: 'https://dav.example.com/cal/' }),
    createEvent: async () => (writes.push('createEvent'), { url: 'https://dav.example.com/cal/new.ics', etag: '"n"' }),
    updateEvent: async () => (writes.push('updateEvent'), { url: event.url, etag: '"3"' }),
    deleteEvent: async () => void writes.push('deleteEvent'),
    listPendingInvitations: async () => [{ uid: 'inv-1', summary: 'Comité', organizer: { name: 'Bob DURAND', email: 'bob.durand@example.com' }, proposedStart: start, proposedEnd: end, userPartstat: 'NEEDS-ACTION', url: 'x', etag: 'y' }],
    findInvitation: async (uid: string) => (await calendarService.listPendingInvitations()).find((i) => i.uid === uid) ?? null,
    respondToInvitation: async () => void writes.push('respondToInvitation'),
  } as unknown as CalendarService;
  const addressBookService = {
    listAddressBooks: async () => [],
    findContactByUid: async () => contact,
    createContact: async () => (writes.push('createContact'), { url: 'u', etag: 'e' }),
    updateContact: async () => (writes.push('updateContact'), { url: 'u', etag: 'e' }),
    deleteContact: async () => void writes.push('deleteContact'),
  } as unknown as AddressBookService;
  const server = createServer(calendarService, addressBookService, logger, undefined, undefined, 'Europe/Paris', {
    DAV_USERNAME: 'alice.martin@example.com',
    DAV_ORGANIZER_EMAIL: 'alice.martin@example.com',
    DAV_ORGANIZER_NAME: 'Alice MARTIN',
    DAV_APPROVAL: opts.approval ?? 'elicit',
    DAV_APPROVAL_TIMEOUT_MS: 2000,
    USER_LANGUAGE: 'fr',
  });
  const client = new Client({ name: 't', version: '0' }, { capabilities: opts.elicitation === false ? {} : { elicitation: { form: {} } } });
  if (opts.elicitation !== false) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts.push(req.params.message);
      const action = opts.answers?.shift() ?? 'decline';
      return action === 'accept' ? { action, content: {} } : { action };
    });
  }
  const ready = (async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
  })();
  const call = async (name: string, args: Record<string, unknown>) => {
    await ready;
    const r = await client.callTool({ name, arguments: args });
    return { isError: Boolean(r.isError), text: (r.content as { text: string }[]).map((c) => c.text).join('\n') };
  };
  const batchOf = async (actions: { tool: string; arguments: Record<string, unknown> }[]) => {
    const r = await call('approve_batch', { actions });
    return { ...r, batchId: /"batchId":"([0-9a-f]{32})"/.exec(r.text)?.[1] };
  };
  return { call, batchOf, writes, prompts };
}

const WRITES: [string, Record<string, unknown>, string][] = [
  ['create_event', { title: 'Point budget', start: '2026-11-05T14:00:00+01:00', end: '2026-11-05T15:00:00+01:00', attendees: [{ email: 'bob.durand@example.com', name: 'Bob DURAND' }] }, 'createEvent'],
  ['update_event', { uid: 'ev-1', title: 'Point budget Q1' }, 'updateEvent'],
  ['delete_event', { uid: 'ev-1' }, 'deleteEvent'],
  ['add_alarm', { uid: 'ev-1', trigger: '15 minutes' }, 'updateEvent'],
  ['remove_alarm', { uid: 'ev-1', alarmIndex: 'all' }, 'updateEvent'],
  ['respond_to_invitation', { uid: 'inv-1', response: 'accept' }, 'respondToInvitation'],
  ['create_contact', { name: 'Chloé PETIT', email: 'chloe.petit@example.com' }, 'createContact'],
  ['update_contact', { uid: 'c-1', phone: '+33 6 00 00 00 00' }, 'updateContact'],
  ['delete_contact', { uid: 'c-1' }, 'deleteContact'],
];

const second = { ...WRITES[0][1], title: 'Point budget 2' };

describe('approve_batch', () => {
  it('creates two events after one approval of the batch', async () => {
    const t = setup({ answers: ['accept'] });
    const b = await t.batchOf([
      { tool: 'create_event', arguments: WRITES[0][1] },
      { tool: 'create_event', arguments: second },
    ]);
    expect(b.batchId, b.text).toBeDefined();
    expect(t.prompts).toHaveLength(1);
    expect(t.prompts[0]).toContain('2 actions');
    expect(t.prompts[0]).toContain('[1/2] Twake Calendar : Créer un événement');
    expect(t.prompts[0]).toContain('Titre : Point budget 2');
    // one question for the list: no reference and no "do it now" footer per action
    expect(t.prompts[0]).not.toContain('Réf. batch');
    expect(t.prompts[0]).not.toContain('Acceptez pour le faire maintenant');
    expect(t.writes).toEqual([]);
    expect((await t.call('create_event', { ...WRITES[0][1], batchId: b.batchId })).isError).toBe(false);
    expect((await t.call('create_event', { ...second, batchId: b.batchId })).isError).toBe(false);
    expect(t.prompts).toHaveLength(1);
    expect(t.writes).toEqual(['createEvent', 'createEvent']);
  });

  it('asks again for a create_event whose arguments are not in the batch', async () => {
    const t = setup({ answers: ['accept', 'accept'] });
    const b = await t.batchOf([{ tool: 'create_event', arguments: WRITES[0][1] }]);
    const r = await t.call('create_event', { ...WRITES[0][1], title: 'Autre chose', batchId: b.batchId });
    expect(t.prompts).toHaveLength(2);
    expect(t.prompts[1]).toContain('Titre : Autre chose');
    expect(r.text).toContain('lot non utilisé');
    expect(t.writes).toEqual(['createEvent']);
  });

  it('writes nothing while preparing the batch', async () => {
    const t = setup({ answers: ['decline'] });
    const b = await t.batchOf(WRITES.map(([tool, args]) => ({ tool, arguments: args })));
    expect(b.batchId).toBeUndefined();
    expect(b.text).toContain('Lot non approuvé');
    expect(t.prompts).toHaveLength(1);
    expect(t.prompts[0]).toContain(`${WRITES.length} actions`);
    expect(t.writes).toEqual([]);
  });

  it('refuses a batch with a read tool', async () => {
    const t = setup({ answers: ['accept'] });
    const b = await t.batchOf([
      { tool: 'create_event', arguments: WRITES[0][1] },
      { tool: 'get_events_in_range', arguments: { start: '2026-11-05', end: '2026-11-06' } },
    ]);
    expect(b.isError).toBe(true);
    expect(b.text).toContain('action 2.');
    expect(t.prompts).toEqual([]);
  });

  it.each(WRITES)('%s runs once approved in a batch, without another question', async (tool, args, write) => {
    const t = setup({ answers: ['accept'] });
    const b = await t.batchOf([{ tool, arguments: args }]);
    expect(b.batchId, b.text).toBeDefined();
    expect(t.writes).toEqual([]);
    const r = await t.call(tool, { ...args, batchId: b.batchId });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).not.toContain('lot non utilisé');
    expect(t.prompts).toHaveLength(1);
    expect(t.writes).toEqual([write]);
  });

  it('creates no batch with DAV_APPROVAL=client', async () => {
    const t = setup({ approval: 'client' });
    const b = await t.batchOf([{ tool: 'create_event', arguments: WRITES[0][1] }]);
    expect(b.batchId).toBeUndefined();
    expect(b.text).toContain('client');
  });
});
