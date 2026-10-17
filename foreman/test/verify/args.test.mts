import { describe, expect, it } from 'vitest';
import { parseArgs, USAGE } from '../../src/verify/args.mts';

describe('parseArgs', () => {
  it('takes a spec path and defaults the ref to HEAD', () => {
    expect(parseArgs(['specs/backlog.md'])).toEqual({
      exportOnly: false,
      interactive: false,
      spec: 'specs/backlog.md',
      claimsFile: undefined,
      source: undefined,
      ref: 'HEAD',
      copies: [],
      slug: 'backlog',
    });
  });

  it('takes a ref after the spec path', () => {
    expect(parseArgs(['specs/backlog.md', 'main']).ref).toBe('main');
  });

  it('takes claims from a file with a source, and needs no spec', () => {
    const o = parseArgs(['--claims', 'claims.md', '--source', 'https://example.com/issue/1', 'abc123']);
    expect(o).toMatchObject({ spec: undefined, claimsFile: 'claims.md', source: 'https://example.com/issue/1', ref: 'abc123', slug: 'claims' });
  });

  it('collects every --copy, in order', () => {
    expect(parseArgs(['--export-only', '--copy', '.env', '--copy', 'config/local.json']).copies).toEqual(['.env', 'config/local.json']);
  });

  it('needs no spec for --export-only, and names the run export', () => {
    expect(parseArgs(['--export-only'])).toMatchObject({ exportOnly: true, spec: undefined, ref: 'HEAD', slug: 'export' });
  });

  it('sets --interactive', () => {
    expect(parseArgs(['s.md', '--interactive']).interactive).toBe(true);
  });

  it('folds anything but letters, digits and dashes in the slug to a dash', () => {
    expect(parseArgs(['s.md', '--slug', 'ABC 12/retry']).slug).toBe('ABC-12-retry');
    expect(parseArgs(['specs/my_feature.v2.md']).slug).toBe('my-feature-v2');
  });

  it('throws the usage line without a spec, claims or --export-only', () => {
    expect(() => parseArgs([])).toThrow(USAGE);
  });

  it('throws the usage line when a flag has no value', () => {
    expect(() => parseArgs(['s.md', '--copy'])).toThrow(USAGE);
    expect(() => parseArgs(['--claims'])).toThrow(USAGE);
  });
});
