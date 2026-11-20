/**
 * MCP server factory for testability
 *
 * Separates server creation from transport connection to enable
 * in-memory testing via InMemoryTransport.
 */

import { VERSION } from './version.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import type { CalendarService } from './caldav/calendar-service.js';
import type { AddressBookService } from './caldav/addressbook-service.js';
import { registerAllTools } from './tools/index.js';
import { z } from 'zod';
import { installBatch } from './batch/index.js';
import { approverFor, WRITE_TOOLS } from './approval.js';

/**
 * Create and configure an MCP server with all tools registered
 *
 * This function does NOT connect any transport - that's the caller's responsibility.
 * This design enables both production (stdio) and test (in-memory) usage.
 *
 * @param calendarService - Calendar service for calendar tools
 * @param addressBookService - AddressBook service for contact tools
 * @param logger - Pino logger
 * @returns Configured but unconnected McpServer instance
 */
export function createServer(
  calendarService: CalendarService,
  addressBookService: AddressBookService,
  logger: Logger,
  defaultCalendar?: string,
  defaultAddressBook?: string,
  userTimezone?: string,
  config?: {
    DAV_USERNAME?: string;
    DAV_ORGANIZER_EMAIL?: string;
    DAV_ORGANIZER_NAME?: string;
    DAV_RECURRING_WRITES?: 'true' | 'false';
    DAV_APPROVAL?: 'elicit' | 'client';
    DAV_APPROVAL_TIMEOUT_MS?: number;
    USER_LANGUAGE?: string;
  },
): McpServer {
  // Initialize MCP server
  const server = new McpServer({
    name: 'mcp-twake-dav',
    version: VERSION,
  });

  // approve_batch, and batchId on every write tool: installed before the tools are registered (spec §5)
  installBatch(server, {
    writeTools: WRITE_TOOLS,
    z,
    confirm: (message) => approverFor(server).confirmText(message),
    clientMode: () => approverFor(server).opts.mode === 'client',
    language: () => approverFor(server).opts.language,
    // the account and time zone the approval texts are written for
    settings: () => JSON.stringify([approverFor(server).opts.as ?? '', approverFor(server).opts.timeZone ?? '']),
  });

  // Register all calendar and contact query tools
  registerAllTools(server, calendarService, addressBookService, logger, defaultCalendar, defaultAddressBook, userTimezone, config);
  logger.info('Calendar and contact tools registered');

  return server;
}
