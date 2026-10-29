import { basename } from 'node:path';

/** The launcher's command line: what to verify, at which ref, and how. */
export const USAGE =
  'usage: foreman verify <spec path> [ref] | --claims <file> [--source <label>] [ref] | --export-only [ref]  [--copy <path>]… [--slug <name>] [--out <folder>] [--model <id>] [--interactive]';

export interface Options {
  exportOnly: boolean;
  interactive: boolean;
  spec: string | undefined;
  claimsFile: string | undefined;
  source: string | undefined;
  ref: string;
  copies: string[];
  // The verifier's model; Claude Code's default when unset.
  model: string | undefined;
  // The run folder's name: --slug, else the spec's file name, else `export` or `claims`, with anything but letters, digits and `-` folded to `-`.
  slug: string;
  // The run folder; <repo>/.verify/<slug>/<timestamp>-<commit> when unset.
  out: string | undefined;
}

/** Parses the launcher's arguments. Throws with the usage line when they are incomplete. */
export const parseArgs = (args: string[]): Options => {
  const usage = (): never => {
    throw new Error(USAGE);
  };
  const flags = new Map<string, string | true>();
  const copies: string[] = [];
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--interactive' || a === '--export-only') flags.set(a, true);
    else if (a === '--copy') copies.push(args[++i] ?? usage());
    else if (a.startsWith('--')) flags.set(a, args[++i] ?? usage());
    else positional.push(a);
  }
  const exportOnly = flags.has('--export-only');
  const claimsFile = flags.get('--claims') as string | undefined;
  const spec = claimsFile || exportOnly ? undefined : (positional.shift() ?? usage());
  const ref = positional.shift() ?? 'HEAD';
  const slug = ((flags.get('--slug') as string | undefined) ?? (spec ? basename(spec).replace(/\.md$/, '') : exportOnly ? 'export' : 'claims')).replace(
    /[^a-zA-Z0-9-]+/g,
    '-',
  );
  return {
    exportOnly,
    interactive: flags.has('--interactive'),
    spec,
    claimsFile,
    source: flags.get('--source') as string | undefined,
    ref,
    copies,
    model: flags.get('--model') as string | undefined,
    slug,
    out: flags.get('--out') as string | undefined,
  };
};
