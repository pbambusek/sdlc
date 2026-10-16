/** The evidence a verifier writes: its schema check, and how a claim's items add up to the claim's status. */
const STATUSES = ['shown', 'not-shown', 'blocked'];
const ITEM_TYPES = ['screenshot', 'http', 'command', 'trace', 'event'];
const ORIGINS = ['quoted', 'extracted', 'probe'];

export type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown) => typeof v === 'string' && v.length > 0;

/** Returns every problem in the evidence, each prefixed with its JSON path. */
export const validate = (e: unknown): string[] => {
  const problems: string[] = [];
  const need = (ok: boolean, where: string, what: string) => ok || problems.push(`${where}: ${what}`);
  if (!isObject(e)) return ['(root): must be an object'];
  need(e.title === undefined || isText(e.title), 'title', 'text when present');
  need(Array.isArray(e.environment) && e.environment.every(isText), 'environment', 'a list of text');
  if (!Array.isArray(e.claims) || e.claims.length === 0) return [...problems, 'claims: a non-empty list'];
  const ids = new Set(e.claims.map((c: unknown) => (isObject(c) ? c.id : undefined)));
  if (e.groups !== undefined) {
    if (!Array.isArray(e.groups)) problems.push('groups: a list when present');
    else {
      const grouped = new Set<unknown>();
      e.groups.forEach((g: unknown, gi) => {
        const at = `groups.${gi}`;
        if (!isObject(g)) return problems.push(`${at}: must be an object`);
        need(isText(g.title), `${at}.title`, 'required text');
        if (!Array.isArray(g.claims) || g.claims.length === 0) return problems.push(`${at}.claims: a non-empty list of claim ids`);
        for (const id of g.claims) {
          need(ids.has(id), `${at}.claims`, `${String(id)} is not a claim id`);
          need(!grouped.has(id), `${at}.claims`, `${String(id)} is already in another group`);
          grouped.add(id);
        }
      });
    }
  }
  e.claims.forEach((c: unknown, ci) => {
    const at = `claims.${ci}`;
    if (!isObject(c)) return problems.push(`${at}: must be an object`);
    for (const k of ['id', 'text']) need(isText(c[k]), `${at}.${k}`, 'required text');
    need(ORIGINS.includes(String(c.origin)), `${at}.origin`, ORIGINS.join(', '));
    if (!Array.isArray(c.items) || c.items.length === 0)
      return problems.push(`${at}.items: a non-empty list; a claim you couldn't check gets one blocked item`);
    c.items.forEach((i: unknown, ii) => {
      const iat = `${at}.items.${ii}`;
      if (!isObject(i)) return problems.push(`${iat}: must be an object`);
      need(ITEM_TYPES.includes(String(i.type)), `${iat}.type`, ITEM_TYPES.join(', '));
      for (const k of ['payload', 'shows', 'how']) need(isText(i[k]), `${iat}.${k}`, 'required text');
      need(STATUSES.includes(String(i.status)), `${iat}.status`, STATUSES.join(', '));
      need(i.reason === undefined || isText(i.reason), `${iat}.reason`, 'text when present');
      need(i.status === 'shown' || isText(i.reason), `${iat}.reason`, 'a not-shown or blocked item needs a reason');
      need(
        i.highlight === undefined || (i.type !== 'screenshot' && Array.isArray(i.highlight) && i.highlight.every(isText)),
        `${iat}.highlight`,
        'a list of text, not on a screenshot',
      );
    });
  });
  return problems;
};

export type Item = { type: string; payload: string; status: string; reason?: string };
export type Claim = { id: string; items: Item[] };

// A claim is not shown if any item is not shown, shown only when every item is, and blocked otherwise.
export const claimStatus = (c: Claim) =>
  c.items.some((i) => i.status === 'not-shown') ? 'not-shown' : c.items.every((i) => i.status === 'shown') ? 'shown' : 'blocked';
