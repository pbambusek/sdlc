import { expect, test } from 'vitest';
import { runningFor, type AgentSession } from '../src/sessions.mts';

const session = (over: Partial<AgentSession>): AgentSession => ({ id: 'abc', sessionId: 'abc-1', name: 'sdlc:build PROJ-1 #1', cwd: '/w', ...over });
const stages = (s: AgentSession) => runningFor('PROJ-1', [s], []).map((r) => r.state);

test('a working session is running', () => expect(stages(session({ status: 'busy', state: 'working' }))).toStrictEqual(['working']));

test('a blocked session still in its turn is waiting for permission', () =>
  expect(stages(session({ status: 'busy', state: 'blocked' }))).toStrictEqual(['blocked']));

test('a blocked session that went idle has ended, so the tick reads its result', () =>
  expect(stages(session({ status: 'idle', state: 'blocked' }))).toStrictEqual([]));

test('a done session has ended', () => expect(stages(session({ status: 'idle', state: 'done' }))).toStrictEqual([]));
