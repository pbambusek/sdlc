// ~/.sdlc/config.json: who approves, which repo each Jira project builds in, and how stages are launched.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Limits, RepoConfig } from './types.mts';
import { DEFAULT_PRICES, type Price } from './usage.mts';

export const HOME = process.env.SDLC_HOME ?? join(homedir(), '.sdlc');

export interface Config {
  /** baseUrl is the site. REST calls find their own way: the site, or the API gateway for a scoped token. apiUrl only overrides that. */
  jira: { baseUrl: string; apiUrl?: string; email: string; jql: string };
  /** Jira account ids whose sdlc-approved label counts. `foreman whoami` prints yours. */
  approvers: string[];
  /** Jira project key → repo. */
  repos: Record<string, RepoConfig>;
  /** `skill` is the build skill's command; the tick adds the spec, source, branch, report and result to it. */
  build: { skill: string; permissionMode?: string; disallowedTools: string[]; model?: string };
  /** The feedback skill's command; the tick adds the commit, PR, spec, verify run and output file. Permission mode and model default to the build's. */
  feedback: { skill: string; permissionMode?: string; model?: string };
  /** The verifier's model, for the tick's runs and `foreman verify`; Claude Code's default when unset. */
  verify: { model?: string };
  maxConcurrent: number;
  limits: Limits;
  /** Dollars per million tokens by model id, over the list prices in usage.mts: what stats and the status page charge. */
  prices: Record<string, Price>;
}

const defaults = {
  jira: { jql: 'labels = sdlc AND resolution = Unresolved ORDER BY created ASC' },
  build: { skill: '/sdlc:build', disallowedTools: [] as string[] },
  maxConcurrent: 2,
  feedback: { skill: '/sdlc:feedback' },
  // A Terraform plan or an end-to-end suite can take most of an hour; two cover a slow queue too.
  limits: { maxBuilds: 5, maxInvalidVerifies: 2, maxFeedbackRuns: 2, roundTimeoutMinutes: 120 },
};

export const configPath = () => process.env.SDLC_CONFIG ?? join(HOME, 'config.json');

export const loadConfig = (): Config => {
  const path = configPath();
  if (!existsSync(path)) throw new Error(`no config at ${path}: copy config.example.json there and fill it in`);
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (!raw.jira?.baseUrl) throw new Error(`${path}: jira.baseUrl is required`);
  if (!raw.jira?.email) throw new Error(`${path}: jira.email is required`);
  const repos: Record<string, RepoConfig> = {};
  for (const [project, r] of Object.entries<Partial<RepoConfig>>(raw.repos ?? {})) {
    if (!r.path || !r.github) throw new Error(`${path}: repos.${project} needs path and github`);
    repos[project] = { path: r.path, github: r.github, verifyCopy: r.verifyCopy ?? [], review: r.review ?? null };
  }
  if (raw.build?.command) throw new Error(`${path}: build.command is now build.skill, the build skill's command without arguments ("/sdlc:build")`);
  return {
    jira: { ...defaults.jira, ...raw.jira },
    approvers: raw.approvers ?? [],
    repos,
    build: { ...defaults.build, ...raw.build },
    feedback: { ...defaults.feedback, ...raw.feedback },
    verify: { ...raw.verify },
    maxConcurrent: raw.maxConcurrent ?? defaults.maxConcurrent,
    limits: { ...defaults.limits, ...raw.limits },
    prices: { ...DEFAULT_PRICES, ...raw.prices },
  };
};
