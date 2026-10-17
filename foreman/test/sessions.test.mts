import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runningFor, type AgentSession } from '../src/sessions.mts';

const session = (over: Partial<AgentSession>): AgentSession => ({ id: 'abc', sessionId: 'abc-1', name: 'sdlc:build PROJ-1 #1', cwd: '/w', ...over });
const stages = (s: AgentSession) => runningFor('PROJ-1', [s], []).map((r) => r.state);

test('a working session is running', () => assert.deepEqual(stages(session({ status: 'busy', state: 'working' })), ['working']));

test('a blocked session still in its turn is waiting for permission', () =>
  assert.deepEqual(stages(session({ status: 'busy', state: 'blocked' })), ['blocked']));

test('a blocked session that went idle has ended, so the tick reads its result', () =>
  assert.deepEqual(stages(session({ status: 'idle', state: 'blocked' })), []));

test('a done session has ended', () => assert.deepEqual(stages(session({ status: 'idle', state: 'done' })), []));
