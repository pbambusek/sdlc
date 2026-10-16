import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Claim, claimStatus, validate } from '../../../../plugins/sdlc/runtime/verify/evidence.mts';
import { skillDir } from './helpers.mts';

const example = () => JSON.parse(readFileSync(join(skillDir, 'assets/example/evidence.json'), 'utf8'));
const item = (over: Record<string, unknown> = {}) => ({ type: 'command', payload: 'npm test', shows: 'tests pass', how: 'ran it', status: 'shown', ...over });
const evidence = (over: Record<string, unknown> = {}) => ({
  environment: ['local'],
  claims: [{ id: 'C1', text: 'It works', origin: 'quoted', items: [item()] }],
  ...over,
});

describe('validate', () => {
  it("accepts the skill's example evidence", () => {
    expect(validate(example())).toEqual([]);
  });

  it('accepts minimal evidence', () => {
    expect(validate(evidence())).toEqual([]);
  });

  it('refuses anything but an object', () => {
    expect(validate([])).toEqual(['(root): must be an object']);
  });

  it('needs a non-empty list of claims', () => {
    expect(validate(evidence({ claims: [] }))).toEqual(['claims: a non-empty list']);
  });

  it('names each problem by its JSON path', () => {
    const bad = evidence({
      environment: 'local',
      claims: [{ id: '', text: 'x', origin: 'guessed', items: [item({ type: 'video', status: 'blocked', how: '' })] }],
    });
    expect(validate(bad)).toEqual([
      'environment: a list of text',
      'claims.0.id: required text',
      'claims.0.origin: quoted, extracted, probe',
      'claims.0.items.0.type: screenshot, http, command, trace, event',
      'claims.0.items.0.how: required text',
      'claims.0.items.0.reason: a not-shown or blocked item needs a reason',
    ]);
  });

  it('needs at least one item per claim, a blocked one when it could not be checked', () => {
    expect(validate(evidence({ claims: [{ id: 'C1', text: 'x', origin: 'quoted', items: [] }] }))).toEqual([
      "claims.0.items: a non-empty list; a claim you couldn't check gets one blocked item",
    ]);
  });

  it('refuses a highlight on a screenshot', () => {
    const claims = [{ id: 'C1', text: 'x', origin: 'quoted', items: [item({ type: 'screenshot', payload: 'shots/a.png', highlight: ['x'] })] }];
    expect(validate(evidence({ claims }))).toEqual(['claims.0.items.0.highlight: a list of text, not on a screenshot']);
  });

  it('checks that groups name existing claims, each once', () => {
    const groups = [
      { title: 'A', claims: ['C1', 'C9'] },
      { title: 'B', claims: ['C1'] },
    ];
    expect(validate(evidence({ groups }))).toEqual(['groups.0.claims: C9 is not a claim id', 'groups.1.claims: C1 is already in another group']);
  });
});

describe('claimStatus', () => {
  const claim = (...statuses: string[]): Claim => ({ id: 'C1', items: statuses.map((status) => ({ type: 'command', payload: 'x', status })) });

  it('is shown only when every item is', () => {
    expect(claimStatus(claim('shown', 'shown'))).toBe('shown');
  });

  it('is not shown when any item is not shown', () => {
    expect(claimStatus(claim('shown', 'blocked', 'not-shown'))).toBe('not-shown');
  });

  it('is blocked otherwise', () => {
    expect(claimStatus(claim('shown', 'blocked'))).toBe('blocked');
  });
});
