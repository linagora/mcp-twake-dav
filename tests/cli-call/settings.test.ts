import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSettings, settingsPath, writeSettings } from '../../src/cli-call/settings.js';

describe('settingsPath', () => {
  it('follows mcp-twake-ai: TWAKE_AI_HOME, then APPDATA on Windows, then XDG_CONFIG_HOME or ~/.config', () => {
    expect(settingsPath({ TWAKE_AI_HOME: '/t' }, 'linux', '/home/u')).toBe('/t/config/cli.json');
    expect(settingsPath({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32', 'C:\\Users\\u')).toBe('C:\\Users\\u\\AppData\\Roaming\\twake-ai\\cli.json');
    expect(settingsPath({}, 'win32', 'C:\\Users\\u')).toBe('C:\\Users\\u\\AppData\\Roaming\\twake-ai\\cli.json');
    expect(settingsPath({ XDG_CONFIG_HOME: '/x' }, 'linux', '/home/u')).toBe('/x/twake-ai/cli.json');
    expect(settingsPath({}, 'darwin', '/Users/u')).toBe('/Users/u/.config/twake-ai/cli.json');
  });
});

describe('readSettings / writeSettings', () => {
  it('reads an absent file as empty lists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-settings-'));
    expect(await readSettings(join(dir, 'cli.json'))).toEqual({ version: 1, allowedUnattended: [], agentMarkers: [] });
  });

  it('writes the file readable by the user only, and reads it back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-settings-'));
    const file = join(dir, 'deep', 'cli.json');
    await writeSettings(file, { version: 1, allowedUnattended: ['cron-agenda'], agentMarkers: ['MY_AGENT'] });
    expect(await readSettings(file)).toEqual({ version: 1, allowedUnattended: ['cron-agenda'], agentMarkers: ['MY_AGENT'] });
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1 });
  });

  it('refuses a damaged file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-settings-'));
    for (const content of ['{bad', '[]', '{"version":2,"allowedUnattended":[],"agentMarkers":[]}', '{"version":1,"allowedUnattended":["Bad Name"],"agentMarkers":[]}', '{"version":1,"allowedUnattended":[],"agentMarkers":["a b"]}']) {
      const file = join(dir, 'cli.json');
      await writeFile(file, content);
      await expect(readSettings(file)).rejects.toMatchObject({ exitCode: 4, message: expect.stringContaining(file) });
    }
  });

  it('takes missing lists as empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-settings-'));
    const file = join(dir, 'cli.json');
    await writeFile(file, '{"version":1}');
    expect(await readSettings(file)).toEqual({ version: 1, allowedUnattended: [], agentMarkers: [] });
  });
});
