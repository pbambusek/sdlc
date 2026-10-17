import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Declaration, findValues, parseDeclaration, type Read, readCredentials, secretValues, startProxy } from '../../src/verify/credentials.mts';
import { needs, temp } from './helpers.mts';

const verifyMd = (block: unknown) => `# VERIFY\n\n## Surface\n\nweb\n\n## Credentials\n\n\`\`\`json\n${JSON.stringify(block, null, 2)}\n\`\`\`\n\n## Other\n`;
const declaration: Declaration = {
  vault: 'example-vault',
  credentials: [{ name: 'API_TOKEN', secret: 'api-token', hosts: ['api.example.com'] }],
};
const read = (over: Partial<Read> = {}): Read =>
  ({ name: 'API_TOKEN', secret: 'api-token', hosts: ['api.example.com'], outcome: 'read', value: 'real-value-1234', ...over }) as Read;

describe('parseDeclaration', () => {
  it('returns null when VERIFY.md declares no credentials', () => {
    expect(parseDeclaration('# VERIFY\n\n## Surface\n\nweb\n')).toBeNull();
  });

  it('returns the declaration from the Credentials section', () => {
    expect(parseDeclaration(verifyMd(declaration))).toEqual(declaration);
  });

  it('throws when the section has no json block', () => {
    expect(() => parseDeclaration('## Credentials\n\nnone yet\n')).toThrow('has no ```json block');
  });

  it('lists every problem in a malformed declaration', () => {
    const bad = { vault: 'x', credentials: [{ name: 'lower', secret: 'no spaces allowed', hosts: [], header: 'Bad Header', format: 'Bearer', basic: 'yes' }] };
    const message = (() => {
      try {
        parseDeclaration(verifyMd(bad));
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    })();
    for (const p of [
      'vault:',
      'credentials.0.name',
      'credentials.0.secret',
      'credentials.0.hosts',
      'credentials.0.header',
      'credentials.0.format',
      'credentials.0.basic',
    ])
      expect(message).toContain(p);
  });

  it('refuses two credentials on one host', () => {
    const twice = { vault: 'example-vault', credentials: [declaration.credentials[0], { name: 'OTHER', secret: 'other', hosts: ['api.example.com'] }] };
    expect(() => parseDeclaration(verifyMd(twice))).toThrow('credentials.1.hosts: api.example.com is already declared');
  });

  it('refuses an empty credential list', () => {
    expect(() => parseDeclaration(verifyMd({ vault: 'example-vault', credentials: [] }))).toThrow('credentials: a non-empty list');
  });
});

describe('readCredentials', () => {
  let path: string | undefined;
  beforeEach(() => {
    path = process.env.PATH;
  });
  afterEach(() => {
    process.env.PATH = path;
  });
  // A stand-in for the Azure CLI on PATH, so the read runs without a login or a real vault.
  const fakeAz = (script: string) => {
    const bin = temp();
    writeFileSync(join(bin, 'az'), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, 'az'), 0o755);
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    return bin;
  };

  it('reads a value with the vault and secret declared', async () => {
    const bin = fakeAz(`echo "$@" > "$(dirname "$0")/args"; echo real-value-1234`);
    const [r] = await readCredentials(declaration);
    expect(r).toMatchObject({ name: 'API_TOKEN', outcome: 'read', value: 'real-value-1234' });
    expect(readFileSync(join(bin, 'args'), 'utf8')).toContain('keyvault secret show --vault-name example-vault --name api-token');
  });

  it('marks a credential unavailable with the CLI error when the read fails', async () => {
    fakeAz('echo "ERROR: Forbidden: no access to the vault" >&2; exit 1');
    const [r] = await readCredentials(declaration);
    expect(r).toMatchObject({ outcome: 'unavailable', reason: 'example-vault/api-token: Forbidden: no access to the vault' });
  });

  it('marks a credential unavailable when the secret is empty', async () => {
    fakeAz('echo ""');
    const [r] = await readCredentials(declaration);
    expect(r).toMatchObject({ outcome: 'unavailable', reason: 'example-vault/api-token: the secret is empty' });
  });

  it('says the Azure CLI is missing when it is not installed', async () => {
    process.env.PATH = temp();
    const [r] = await readCredentials(declaration);
    expect(r).toMatchObject({ outcome: 'unavailable', reason: 'example-vault/api-token: the Azure CLI (az) is not installed' });
  });
});

describe('secretValues', () => {
  it('scans for read values only, skipping known calibration credentials', () => {
    const reads: Read[] = [
      read(),
      read({ name: 'KNOWN', value: 'public', known: true }),
      { ...declaration.credentials[0]!, name: 'GONE', outcome: 'unavailable', reason: 'x' },
    ];
    expect(secretValues(reads)).toEqual([{ name: 'API_TOKEN', value: 'real-value-1234' }]);
  });
});

describe('findValues', () => {
  const values = [{ name: 'API_TOKEN', value: 'real-value-1234' }];

  it('reports a value in a named text by credential and text, never the value', () => {
    expect(findValues({ values, texts: { 'the session transcript': '... real-value-1234 ...' } })).toEqual(['API_TOKEN in the session transcript']);
  });

  it('finds nothing in a clean text', () => {
    expect(findValues({ values, texts: { transcript: 'placeholder-token' } })).toEqual([]);
  });
});

describe('startProxy', () => {
  const t = needs('gives the run a token, never the value, the proxy settings to reach it, and a trust bundle it can read', 'nono');
  it.skipIf(t.skip)(t.name, async () => {
    const dir = temp();
    const files = { profileFile: join(dir, 'profile.json'), nonoLog: join(dir, 'nono.log'), log: join(dir, 'requests.jsonl'), trustFile: join(dir, 'ca.pem') };
    const unavailable: Read = { name: 'GONE', secret: 'gone', hosts: ['other.example.com'], outcome: 'unavailable', reason: 'x' };
    const proxy = await startProxy({ reads: [read(), unavailable], ...files, baseEnv: { PATH: process.env.PATH, GONE: 'stale' } });
    try {
      const token = proxy.env.API_TOKEN!;
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(proxy.env.HTTPS_PROXY).toMatch(new RegExp(`^http://nono:${token}@127\\.0\\.0\\.1:\\d+$`));
      expect(proxy.env.NODE_EXTRA_CA_CERTS).toBe(files.trustFile);
      expect(readFileSync(files.trustFile, 'utf8')).toContain('BEGIN CERTIFICATE');
      expect(proxy.env.GONE).toBeUndefined();
      expect(Object.values(proxy.env).join('\n')).not.toContain('real-value-1234');
      expect(readFileSync(files.profileFile, 'utf8')).not.toContain('real-value-1234');
      expect(proxy.values).toEqual([{ name: 'API_TOKEN', value: 'real-value-1234' }]);
    } finally {
      await proxy.stop();
    }
  });
});
