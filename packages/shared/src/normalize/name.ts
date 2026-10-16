// Letters NFKD doesn't decompose into base + mark.
const FOLD: Record<string, string> = { ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', ł: 'l', đ: 'd', ð: 'd', þ: 'th', ı: 'i' };

/**
 * One name component: NFKD, diacritics and emoji stripped, lowercased, whitespace collapsed and trimmed.
 * Trimming happens per component (the native nameKey trimmed "first|last" as a whole, so "Sam |Lee" and
 * "Sam|Lee" were different keys).
 */
export function normalizeNamePart(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[\p{Extended_Pictographic}‍️]/gu, '')
    .toLowerCase()
    .replace(/[øæœßłđðþı]/g, (c) => FOLD[c] ?? c)
    .replace(/\s+/g, ' ')
    .trim();
}

/** "first|last" exact-match key; "" when both parts are empty. */
export function nameKey(first: string | null | undefined, last: string | null | undefined): string {
  const f = normalizeNamePart(first);
  const l = normalizeNamePart(last);
  return f || l ? `${f}|${l}` : '';
}

/** Jaro-Winkler similarity in [0, 1] (prefix scale 0.1, max prefix 4). */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return a.length ? 1 : 0;
  if (!a.length || !b.length) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aHit = new Array<boolean>(a.length).fill(false);
  const bHit = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(b.length - 1, i + window);
    for (let j = lo; j <= hi; j++) {
      if (bHit[j] || a[i] !== b[j]) continue;
      aHit[i] = bHit[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aHit[i]) continue;
    while (!bHit[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - transpositions / 2) / m) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Tiny nickname table (formal name → common short forms). The matcher may load a fuller list later;
 * this covers the frequent English cases.
 */
const NICKNAMES: Record<string, string[]> = {
  alexander: ['alex', 'xander', 'sasha'],
  alexandra: ['alex', 'lexi', 'sasha'],
  andrew: ['andy', 'drew'],
  anthony: ['tony'],
  benjamin: ['ben', 'benji'],
  catherine: ['cat', 'cathy', 'kate', 'katie'],
  christopher: ['chris', 'topher'],
  christina: ['chris', 'tina'],
  daniel: ['dan', 'danny'],
  david: ['dave', 'davey'],
  elizabeth: ['liz', 'beth', 'lizzie', 'eliza', 'betsy'],
  james: ['jim', 'jimmy', 'jamie'],
  jennifer: ['jen', 'jenny'],
  john: ['jack', 'johnny'],
  jonathan: ['jon', 'jonny'],
  joseph: ['joe', 'joey'],
  joshua: ['josh'],
  katherine: ['kate', 'katie', 'kat', 'kathy'],
  margaret: ['maggie', 'meg', 'peggy'],
  matthew: ['matt'],
  michael: ['mike', 'mikey', 'mick'],
  nicholas: ['nick', 'nico'],
  patricia: ['pat', 'patty', 'trish'],
  rebecca: ['becca', 'becky'],
  richard: ['rick', 'rich', 'dick'],
  robert: ['rob', 'bob', 'bobby', 'robbie'],
  samantha: ['sam', 'sammy'],
  samuel: ['sam', 'sammy'],
  stephanie: ['steph'],
  steven: ['steve'],
  stephen: ['steve'],
  thomas: ['tom', 'tommy'],
  timothy: ['tim', 'timmy'],
  victoria: ['vicky', 'tori'],
  william: ['will', 'bill', 'billy', 'liam'],
};

const CANONICAL = new Map<string, Set<string>>();
for (const [formal, shorts] of Object.entries(NICKNAMES)) {
  for (const n of [formal, ...shorts]) {
    const set = CANONICAL.get(n) ?? new Set<string>();
    set.add(formal);
    CANONICAL.set(n, set);
  }
}

/** Canonical first names a (normalized) first name may stand for: "sam" → {samuel, samantha}. */
export function canonicalFirstNames(first: string): Set<string> {
  const n = normalizeNamePart(first);
  return CANONICAL.get(n) ?? new Set(n ? [n] : []);
}

/** First-name compatibility: 1 (canonical sets meet), 0.9 (JW ≥ 0.92), 0.5 (initial-only), else 0. */
export function firstNameScore(a: string, b: string): number {
  const x = normalizeNamePart(a).replace(/\.$/, '');
  const y = normalizeNamePart(b).replace(/\.$/, '');
  if (!x || !y) return 0;
  const cx = canonicalFirstNames(x);
  for (const c of canonicalFirstNames(y)) if (cx.has(c)) return 1;
  if (jaroWinkler(x, y) >= 0.92) return 0.9;
  if ((x.length === 1 || y.length === 1) && x[0] === y[0]) return 0.5;
  return 0;
}

/** Last-name compatibility: 1 (JW ≥ 0.92), 0.6 (one side missing), 0 = conflict (both present, JW < 0.85). */
export function lastNameScore(a: string | null | undefined, b: string | null | undefined): number {
  const x = normalizeNamePart(a);
  const y = normalizeNamePart(b);
  if (!x || !y) return 0.6;
  const jw = jaroWinkler(x, y);
  if (jw >= 0.92) return 1;
  return jw < 0.85 ? 0 : 0.6;
}
