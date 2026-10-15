/**
 * Runs inside a run's workspace and executes each command the verifier's shell sends it, so every command a run executes is
 * confined, and a server a command starts in the background keeps running for the next one.
 *   node workspace-server.mts <socket>
 * A client connects, sends one JSON line `{ "script": "<bash script>", "cwd": "<folder>" }`, and gets JSON lines back:
 * `{ "out": "<base64>" }` and `{ "err": "<base64>" }` as the command writes, `{ "cwd": "<folder>" }` when it ends in one, and
 * last `{ "exit": <status> }`. A client that disconnects first stops its command. SIGTERM stops every command still running.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';

const socket = process.argv[2];
if (!socket) {
  console.error('usage: workspace-server.mts <socket>');
  process.exit(2);
}

const running = new Set<ChildProcess>();
// Each command leads its own process group, so stopping it stops what it started in the foreground too.
const stop = (child: ChildProcess) => {
  try {
    process.kill(-child.pid!, 'SIGTERM');
  } catch {}
};

const server = createServer((conn) => {
  const lines = createInterface({ input: conn });
  lines.once('line', (line) => {
    lines.close();
    let request: { script?: unknown; cwd?: unknown };
    try {
      request = JSON.parse(line);
    } catch {
      request = {};
    }
    const send = (message: object) => conn.writable && conn.write(JSON.stringify(message) + '\n');
    if (typeof request.script !== 'string' || typeof request.cwd !== 'string') {
      send({ err: Buffer.from('workspace: malformed request\n').toString('base64') });
      send({ exit: 2 });
      conn.end();
      return;
    }
    // fd 3 carries the folder the command ended in, apart from its own output.
    const child = spawn('bash', ['-c', request.script], {
      cwd: existsSync(request.cwd) ? request.cwd : process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      detached: true,
    });
    running.add(child);
    child.stdout!.on('data', (b: Buffer) => send({ out: b.toString('base64') }));
    child.stderr!.on('data', (b: Buffer) => send({ err: b.toString('base64') }));
    let cwd = '';
    (child.stdio[3] as NodeJS.ReadableStream).on('data', (b: Buffer) => (cwd += b.toString()));
    child.once('error', (e) => {
      send({ err: Buffer.from(`workspace: ${e.message}\n`).toString('base64') });
    });
    // A command ends when its shell exits. What it left running in the background may hold its output open, so the output is
    // waited for only until it closes or goes quiet.
    let open = 3;
    let quietSince = 0;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      running.delete(child);
      if (cwd.trim()) send({ cwd: cwd.trim() });
      send({ exit: code ?? 128 + (signal === 'SIGKILL' ? 9 : 15) });
      conn.end();
    };
    for (const s of [child.stdout!, child.stderr!, child.stdio[3] as NodeJS.ReadableStream]) {
      s.on('data', () => (quietSince = Date.now()));
      s.once('end', () => open--);
    }
    child.once('exit', (code, signal) => {
      quietSince = Date.now();
      const wait = setInterval(() => {
        if (open > 0 && Date.now() - quietSince < 200) return;
        clearInterval(wait);
        finish(code, signal);
      }, 20);
    });
    conn.once('close', () => running.has(child) && stop(child));
  });
  conn.on('error', () => {});
});

const shutdown = () => {
  for (const child of running) stop(child);
  server.close();
  try {
    unlinkSync(socket);
  } catch {}
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

if (existsSync(socket)) unlinkSync(socket);
server.listen(socket, () => console.log('workspace ready'));
