/**
 * Places without geocoding (intelligence §5 "Travel intel", without the gazetteer download): a city / region string
 * is normalized (diacritics, case, punctuation, street segments, states, ZIP codes, countries) and matched against a
 * small built-in table of metros. Each metro lists its own aliases plus neighborhoods and towns within roughly 80 km
 * and its airport codes, so "Brooklyn", "JFK" and "New York, NY 10001" are all one place. Anything the table doesn't
 * know stays a plain normalized place ("place:lakeside"), compared by string. Pure functions only.
 *
 * Modes (how much a string has to look like a place):
 *   strict   the metro table only (Partiful locations, flight locations: "Birch Loft" is not a city);
 *   venue    strict, and a venue's own name must BE an alias to count ("Boston Market" is not Boston; the city slot of
 *            "Boston Market, 1 Example St, Springfield" decides);
 *   address  the table, else the city slot of a multi-part address ("…, Lakeside, CA 90000" → lakeside);
 *   venue_address  venue rules for the first segment (a hotel or host's venue name), else the address city slot
 *            (lodging and Partiful locations: "The Austin Motel, 1 Example St, Lakeside" is in Lakeside);
 *   name     the table, else the whole cleaned string when it is 1–3 words (a home-city setting, a location fact).
 */

export interface Place {
  /** 'metro:<id>' (known metro) or 'place:<normalized name>[|<country>]'. */
  key: string;
  /** Display label: the metro's name or the place as written (title-cased). */
  label: string;
  /** In the metro table. */
  known: boolean;
}

export type PlaceMode = 'strict' | 'venue' | 'address' | 'venue_address' | 'name';

interface Metro {
  id: string;
  label: string;
  country: string;
  aliases: string[];
  airports: string[];
}

const m = (id: string, label: string, country: string, aliases: string, airports = ''): Metro => ({
  id,
  label,
  country,
  aliases: aliases.split('|').map((a) => a.trim()).filter(Boolean),
  airports: airports.split(' ').filter(Boolean),
});

/** Metros (aliases are normalized: lowercase, no diacritics, no punctuation). */
export const METROS: readonly Metro[] = [
  m('nyc', 'New York', 'us', 'new york|new york city|nyc|ny|manhattan|brooklyn|queens|bronx|the bronx|staten island|williamsburg|bushwick|astoria|harlem|long island city|jersey city|hoboken|greenpoint|park slope|soho|tribeca|chelsea|east village|west village|lower east side|upper west side|upper east side', 'JFK LGA EWR'),
  m('sf-bay', 'SF Bay Area', 'us', 'san francisco|sf|san fran|bay area|sf bay area|oakland|berkeley|palo alto|mountain view|menlo park|san mateo|redwood city|sunnyvale|cupertino|san jose|santa clara|fremont|sausalito|mill valley|daly city|emeryville|alameda|walnut creek|south san francisco|burlingame|los altos|marin|the mission|mission district', 'SFO OAK SJC'),
  m('la', 'Los Angeles', 'us', 'los angeles|la|l a|santa monica|venice|venice beach|west hollywood|weho|hollywood|pasadena|burbank|culver city|long beach|malibu|silver lake|silverlake|echo park|beverly hills|glendale|downtown la|dtla|koreatown|los feliz|manhattan beach|marina del rey|studio city', 'LAX BUR LGB'),
  m('oc', 'Orange County', 'us', 'orange county|irvine|newport beach|anaheim|costa mesa|huntington beach|laguna beach|santa ana', 'SNA'),
  m('san-diego', 'San Diego', 'us', 'san diego|la jolla|del mar|encinitas|carlsbad|coronado', 'SAN'),
  m('seattle', 'Seattle', 'us', 'seattle|bellevue|redmond|kirkland|capitol hill', 'SEA'),
  m('portland', 'Portland', 'us', 'portland|portland oregon|portland or', 'PDX'),
  m('chicago', 'Chicago', 'us', 'chicago|evanston|oak park|wicker park|logan square', 'ORD MDW'),
  m('boston', 'Boston', 'us', 'boston|cambridge|somerville|brookline|newton|back bay', 'BOS'),
  m('dc', 'Washington, DC', 'us', 'washington dc|washington d c|dc|d c|district of columbia|arlington|alexandria|bethesda|silver spring|georgetown', 'DCA IAD'),
  m('baltimore', 'Baltimore', 'us', 'baltimore', 'BWI'),
  m('philadelphia', 'Philadelphia', 'us', 'philadelphia|philly', 'PHL'),
  m('miami', 'Miami', 'us', 'miami|miami beach|south beach|brickell|wynwood|coral gables|fort lauderdale|ft lauderdale', 'MIA FLL'),
  m('austin', 'Austin', 'us', 'austin|atx', 'AUS'),
  m('dallas', 'Dallas', 'us', 'dallas|fort worth|plano|irving|dfw', 'DFW DAL'),
  m('houston', 'Houston', 'us', 'houston', 'IAH HOU'),
  m('san-antonio', 'San Antonio', 'us', 'san antonio', 'SAT'),
  m('denver', 'Denver', 'us', 'denver|boulder|aurora', 'DEN'),
  m('phoenix', 'Phoenix', 'us', 'phoenix|scottsdale|tempe|mesa', 'PHX'),
  m('las-vegas', 'Las Vegas', 'us', 'las vegas|vegas', 'LAS'),
  m('salt-lake', 'Salt Lake City', 'us', 'salt lake city|salt lake|slc|park city', 'SLC'),
  m('atlanta', 'Atlanta', 'us', 'atlanta|atl|decatur', 'ATL'),
  m('nashville', 'Nashville', 'us', 'nashville', 'BNA'),
  m('new-orleans', 'New Orleans', 'us', 'new orleans|nola', 'MSY'),
  m('minneapolis', 'Minneapolis', 'us', 'minneapolis|st paul|saint paul|twin cities', 'MSP'),
  m('detroit', 'Detroit', 'us', 'detroit|ann arbor', 'DTW'),
  m('pittsburgh', 'Pittsburgh', 'us', 'pittsburgh', 'PIT'),
  m('charlotte', 'Charlotte', 'us', 'charlotte', 'CLT'),
  m('raleigh', 'Raleigh-Durham', 'us', 'raleigh|durham|chapel hill|research triangle', 'RDU'),
  m('orlando', 'Orlando', 'us', 'orlando', 'MCO'),
  m('tampa', 'Tampa', 'us', 'tampa|st petersburg|saint petersburg|clearwater', 'TPA'),
  m('honolulu', 'Honolulu', 'us', 'honolulu|oahu|waikiki', 'HNL'),
  m('maui', 'Maui', 'us', 'maui|lahaina|kahului|wailea', 'OGG'),
  m('tahoe', 'Lake Tahoe', 'us', 'lake tahoe|tahoe|south lake tahoe|truckee|squaw valley|palisades tahoe'),
  m('reno', 'Reno', 'us', 'reno', 'RNO'),
  m('napa', 'Napa & Sonoma', 'us', 'napa|napa valley|sonoma|healdsburg|wine country'),
  m('palm-springs', 'Palm Springs', 'us', 'palm springs|joshua tree|coachella|indio', 'PSP'),
  m('sacramento', 'Sacramento', 'us', 'sacramento', 'SMF'),
  m('london', 'London', 'gb', 'london', 'LHR LGW STN LCY LTN'),
  m('paris', 'Paris', 'fr', 'paris', 'CDG ORY'),
  m('lisbon', 'Lisbon', 'pt', 'lisbon|lisboa', 'LIS'),
  m('madrid', 'Madrid', 'es', 'madrid', 'MAD'),
  m('barcelona', 'Barcelona', 'es', 'barcelona', 'BCN'),
  m('rome', 'Rome', 'it', 'rome|roma', 'FCO'),
  m('milan', 'Milan', 'it', 'milan|milano', 'MXP LIN'),
  m('amsterdam', 'Amsterdam', 'nl', 'amsterdam', 'AMS'),
  m('berlin', 'Berlin', 'de', 'berlin', 'BER'),
  m('munich', 'Munich', 'de', 'munich|munchen', 'MUC'),
  m('dublin', 'Dublin', 'ie', 'dublin', 'DUB'),
  m('edinburgh', 'Edinburgh', 'gb', 'edinburgh', 'EDI'),
  m('copenhagen', 'Copenhagen', 'dk', 'copenhagen', 'CPH'),
  m('stockholm', 'Stockholm', 'se', 'stockholm', 'ARN'),
  m('reykjavik', 'Reykjavik', 'is', 'reykjavik', 'KEF'),
  m('athens', 'Athens', 'gr', 'athens', 'ATH'),
  m('istanbul', 'Istanbul', 'tr', 'istanbul', 'IST'),
  m('tokyo', 'Tokyo', 'jp', 'tokyo', 'HND NRT'),
  m('kyoto', 'Kyoto', 'jp', 'kyoto'),
  m('osaka', 'Osaka', 'jp', 'osaka', 'KIX ITM'),
  m('seoul', 'Seoul', 'kr', 'seoul', 'ICN GMP'),
  m('hong-kong', 'Hong Kong', 'hk', 'hong kong', 'HKG'),
  m('singapore', 'Singapore', 'sg', 'singapore', 'SIN'),
  m('bangkok', 'Bangkok', 'th', 'bangkok', 'BKK'),
  m('bali', 'Bali', 'id', 'bali|ubud|canggu|seminyak', 'DPS'),
  m('sydney', 'Sydney', 'au', 'sydney', 'SYD'),
  m('melbourne', 'Melbourne', 'au', 'melbourne', 'MEL'),
  m('mexico-city', 'Mexico City', 'mx', 'mexico city|cdmx|ciudad de mexico', 'MEX'),
  m('cancun', 'Cancun', 'mx', 'cancun|playa del carmen', 'CUN'),
  m('tulum', 'Tulum', 'mx', 'tulum'),
  m('toronto', 'Toronto', 'ca', 'toronto', 'YYZ'),
  m('vancouver', 'Vancouver', 'ca', 'vancouver', 'YVR'),
  m('montreal', 'Montreal', 'ca', 'montreal', 'YUL'),
  m('buenos-aires', 'Buenos Aires', 'ar', 'buenos aires', 'EZE'),
  m('rio', 'Rio de Janeiro', 'br', 'rio de janeiro|rio', 'GIG'),
  m('sao-paulo', 'Sao Paulo', 'br', 'sao paulo', 'GRU'),
  m('cape-town', 'Cape Town', 'za', 'cape town', 'CPT'),
  m('dubai', 'Dubai', 'ae', 'dubai', 'DXB'),
  m('tel-aviv', 'Tel Aviv', 'il', 'tel aviv', 'TLV'),
];

const BY_ALIAS = new Map<string, Metro>();
const BY_AIRPORT = new Map<string, Metro>();
for (const metro of METROS) {
  for (const a of metro.aliases) if (!BY_ALIAS.has(a)) BY_ALIAS.set(a, metro);
  for (const code of metro.airports) BY_AIRPORT.set(code, metro);
}
const MAX_ALIAS_WORDS = Math.max(...[...BY_ALIAS.keys()].map((a) => a.split(' ').length));
/** Aliases this short (or these ambiguous words) only match a whole segment, never inside a longer phrase. */
const WHOLE_ONLY = new Set(['la', 'l a', 'ny', 'sf', 'dc', 'd c', 'atl', 'atx', 'slc', 'rio', 'mesa', 'venice', 'chelsea', 'soho', 'marin', 'newton', 'aurora', 'georgetown', 'cambridge', 'portland', 'reno', 'irving', 'decatur', 'alexandria', 'arlington']);

export const US_STATES: Record<string, string> = {
  al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california', co: 'colorado', ct: 'connecticut', de: 'delaware',
  fl: 'florida', ga: 'georgia', hi: 'hawaii', id: 'idaho', il: 'illinois', in: 'indiana', ia: 'iowa', ks: 'kansas', ky: 'kentucky',
  la: 'louisiana', me: 'maine', md: 'maryland', ma: 'massachusetts', mi: 'michigan', mn: 'minnesota', ms: 'mississippi',
  mo: 'missouri', mt: 'montana', ne: 'nebraska', nv: 'nevada', nh: 'new hampshire', nj: 'new jersey', nm: 'new mexico',
  ny: 'new york', nc: 'north carolina', nd: 'north dakota', oh: 'ohio', ok: 'oklahoma', or: 'oregon', pa: 'pennsylvania',
  ri: 'rhode island', sc: 'south carolina', sd: 'south dakota', tn: 'tennessee', tx: 'texas', ut: 'utah', vt: 'vermont',
  va: 'virginia', wa: 'washington', wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming', dc: 'district of columbia',
};
const STATE_WORDS = new Set([...Object.keys(US_STATES), ...Object.values(US_STATES)]);

const COUNTRIES: Record<string, string> = {
  usa: 'us', us: 'us', 'u s': 'us', 'u s a': 'us', 'united states': 'us', 'united states of america': 'us', america: 'us',
  uk: 'gb', 'u k': 'gb', 'united kingdom': 'gb', england: 'gb', scotland: 'gb', wales: 'gb', 'great britain': 'gb',
  france: 'fr', portugal: 'pt', spain: 'es', italy: 'it', netherlands: 'nl', 'the netherlands': 'nl', germany: 'de',
  ireland: 'ie', denmark: 'dk', sweden: 'se', iceland: 'is', greece: 'gr', turkey: 'tr', turkiye: 'tr', japan: 'jp',
  'south korea': 'kr', korea: 'kr', 'hong kong sar': 'hk', thailand: 'th', indonesia: 'id', australia: 'au', mexico: 'mx',
  canada: 'ca', argentina: 'ar', brazil: 'br', 'south africa': 'za', 'united arab emirates': 'ae', uae: 'ae', israel: 'il',
};

/** Words around a destination that aren't part of it ("Austin trip", "Weekend in Tahoe", "Lisbon ✈"). */
const TRAVEL_WORDS = new Set(
  'trip trips travel traveling travelling vacation vacay holiday holidays getaway weekend long weekend flight flights fly flying to in at the a an back home visit visiting visit to stay staying hotel airbnb vrbo pto ooo out of office road roadtrip bound'.split(' '),
);

/** Lowercase, no diacritics, punctuation → spaces (commas kept as separators), collapsed whitespace. */
export function normalizePlaceText(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^\p{L}\p{N},]+/gu, ' ')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s+/g, ' ')
    .trim();
}

const titleCase = (s: string) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());

const metroPlace = (metro: Metro): Place => ({ key: `metro:${metro.id}`, label: metro.label, known: true });

/** The metro of a known airport code (upper case, e.g. "AUS"), or null. */
export function airportPlace(code: string): Place | null {
  const metro = BY_AIRPORT.get(code.toUpperCase());
  return metro ? metroPlace(metro) : null;
}

/** Airport codes written in upper case in `raw`, in order (only codes the table knows). */
export function airportCodes(raw: string): string[] {
  return [...raw.matchAll(/\b([A-Z]{3})\b/g)].map((x) => x[1]!).filter((c) => BY_AIRPORT.has(c));
}

/** A metro named somewhere in `segment` (longest alias first; short/ambiguous aliases only as the whole segment). */
function metroIn(segment: string): Metro | null {
  const whole = BY_ALIAS.get(segment);
  if (whole) return whole;
  const words = segment.split(' ');
  for (let n = Math.min(MAX_ALIAS_WORDS, words.length - 1); n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const phrase = words.slice(i, i + n).join(' ');
      if (WHOLE_ONLY.has(phrase) || (n === 1 && phrase.length < 4)) continue;
      const hit = BY_ALIAS.get(phrase);
      if (hit) return hit;
    }
  }
  return null;
}

/** A metro alias that ends `segment` (2+ words, or one long unambiguous word). */
function metroAtEnd(segment: string): Metro | null {
  const words = segment.split(' ');
  for (let n = Math.min(MAX_ALIAS_WORDS, words.length - 1); n >= 1; n--) {
    const phrase = words.slice(words.length - n).join(' ');
    if (WHOLE_ONLY.has(phrase) || (n === 1 && phrase.length < 5)) continue;
    const hit = BY_ALIAS.get(phrase);
    if (hit) return hit;
  }
  return null;
}

const STREETISH = /\d/;
const isState = (s: string) => STATE_WORDS.has(s) || /^[a-z]{2} \d{5}(?: \d{4})?$/.test(s) || /^\d{5}(?: \d{4})?$/.test(s);
const plausibleName = (s: string) => /^[\p{L} ]{2,40}$/u.test(s) && s.split(' ').length <= 3 && !TRAVEL_WORDS.has(s);

/**
 * The place a free-text location names, or null. See the module header for the modes.
 */
export function parsePlace(raw: string | null | undefined, mode: PlaceMode = 'strict'): Place | null {
  if (!raw) return null;
  const text = raw.slice(0, 300);
  const codes = airportCodes(text);
  const norm = normalizePlaceText(text);
  if (!norm) return codes.length === 1 ? airportPlace(codes[0]!) : null;
  // A country segment (non-US ones keep the place apart from a same-named US city).
  let country: string | null = null;
  const segments: string[] = [];
  for (const raw of norm.split(',')) {
    const s = raw.trim();
    if (!s) continue;
    const c = COUNTRIES[s];
    if (c === undefined) segments.push(s);
    else country = c;
  }
  if (!segments.length) return null;
  // A lone state name or abbreviation is a place only when it is also a metro alias ("ny" → New York).
  const single = segments.length === 1 ? segments[0]! : null;
  if (single && BY_ALIAS.has(single)) {
    const metro = BY_ALIAS.get(single)!;
    if (!country || country === metro.country) return metroPlace(metro);
  }
  // "Washington, DC": the first two segments together can be one alias
  if (segments.length >= 2) {
    const joined = BY_ALIAS.get(`${segments[0]} ${segments[1]}`);
    if (joined && (!country || country === joined.country)) return metroPlace(joined);
  }
  const body = segments.filter((s, i) => !(i > 0 && isState(s)));
  for (const [idx, seg] of body.entries()) {
    if (STREETISH.test(seg)) {
      // A street line ("100 example blvd"): look past it. Alone (no commas), a metro at its very end still counts
      // ("pier 39 san francisco"); a street named after a city ("1 austin st, springfield") never does.
      const metro = body.length === 1 ? metroAtEnd(seg.replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim()) : null;
      if (metro && (!country || country === metro.country)) return metroPlace(metro);
      continue;
    }
    const venueName = (mode === 'venue' || mode === 'venue_address') && idx === 0;
    const metro = venueName ? (BY_ALIAS.get(seg) ?? null) : metroIn(seg);
    if (metro && (!country || country === metro.country)) return metroPlace(metro);
  }
  if (codes.length === 1 && mode !== 'venue' && mode !== 'venue_address') return airportPlace(codes[0]!);
  if (mode === 'strict' || mode === 'venue') return null;
  const named = (s: string): Place => ({ key: `place:${s}${country && country !== 'us' ? `|${country}` : ''}`, label: titleCase(s), known: false });
  const candidates = body.filter((s) => !STREETISH.test(s) && !isState(s) && plausibleName(s));
  if (mode === 'address' || mode === 'venue_address') {
    // the city slot of "venue, city, ST ZIP" / "street, city": the last plain segment, never the first of several
    if (body.length >= 2) {
      const city = [...candidates].reverse().find((s) => s !== body[0]);
      if (city) return named(city);
    }
    return null;
  }
  // mode 'name': a short place name as written
  if (body.length === 1 && candidates.length === 1) return named(candidates[0]!);
  if (body.length >= 2 && candidates.length) return named(candidates[0]!);
  return null;
}

/** Strips travel words around a place name ("Austin trip ✈" → "Austin", "Weekend in Tahoe" → "Tahoe"). */
export function stripTravelWords(raw: string): string {
  const words = normalizePlaceText(raw).replace(/,/g, ' ').split(' ').filter(Boolean);
  let i = 0;
  let j = words.length;
  while (i < j && TRAVEL_WORDS.has(words[i]!)) i++;
  while (j > i && TRAVEL_WORDS.has(words[j - 1]!)) j--;
  return words.slice(i, j).join(' ');
}

const ARRIVAL_PAIR = /\b([A-Z]{3})\s*(?:→|->|–|—|-|>|\bto\b)\s*([A-Z]{3})\b/;
const TO_PHRASE = /(?:^|\s)(?:to|in|@)\s+(\p{Lu}[\p{L}.'’-]*(?:\s+(?:de|del|la|of|\p{Lu}[\p{L}.'’-]*)){0,3})/u;

/**
 * The destination a trip-ish title names: an airport pair's arrival ("SFO → AUS"), "to X" / "in X" with a
 * capitalized place, a title that is only a place plus travel words ("Lisbon trip"), or a metro alias inside it.
 */
export function destinationFromTitle(title: string | null | undefined): Place | null {
  if (!title) return null;
  const t = title.slice(0, 200);
  const pair = ARRIVAL_PAIR.exec(t);
  if (pair) {
    const arrival = airportPlace(pair[2]!);
    if (arrival) return arrival;
  }
  const to = TO_PHRASE.exec(t);
  if (to) {
    const phrase = to[1]!.replace(/\s+(?:on|for|at|from|via|with)\b.*$/i, '');
    const p = parsePlace(phrase, 'name');
    if (p) return p;
  }
  const bare = stripTravelWords(t);
  if (bare) {
    const metro = BY_ALIAS.get(bare) ?? metroIn(bare);
    if (metro) return metroPlace(metro);
  }
  const codes = airportCodes(t);
  if (codes.length === 1) return airportPlace(codes[0]!);
  return null;
}

/** A location fact's value ("Austin, TX", "lives in Brooklyn", "Denver area"). */
export function placeOfFactValue(value: string | null | undefined): Place | null {
  if (!value) return null;
  const cleaned = value.replace(/^\s*(?:lives? in|living in|based in|moved to|moving to|in)\s+/i, '').replace(/\s+(?:area|metro)\s*$/i, '');
  return parsePlace(cleaned, 'name');
}

/** A travel_plan fact's destination ("Lisbon trip", "visiting New York", "Austin Oct 20–23"). */
export function placeOfTravelPlan(value: string | null | undefined): Place | null {
  if (!value) return null;
  const head = value.replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*\d.*$/i, '').replace(/\d.*$/, '');
  return destinationFromTitle(head) ?? parsePlace(stripTravelWords(head), 'name');
}

export const samePlace = (a: Place | null | undefined, b: Place | null | undefined): boolean => !!a && !!b && a.key === b.key;
