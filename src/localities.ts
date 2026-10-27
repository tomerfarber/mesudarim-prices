import { AREA_CITIES, CHAIN_CITY_CODES, CITY_ALIASES } from './cityAliases.ts';
import { getJson } from './http.ts';

/**
 * Most chains publish a branch's city as the CBS locality code (9000 = באר
 * שבע), some as a name, some not at all. The government's locality list
 * (data.gov.il) turns codes into names; when there is no usable code, a city
 * is looked for in the branch's own name ("רגר באר שבע"), then in its
 * address. The database maps every spelling to one canonical city
 * (price_city_aliases), so a CBS name or a known alias is enough here.
 */
const LOCALITIES = 'https://data.gov.il/api/3/action/datastore_search?resource_id=5c78e9fa-c2e2-4771-93ff-7f400a12f7ba&limit=5000';

interface Record {
  סמל_ישוב: string | number;
  שם_ישוב: string;
}

export interface Localities {
  byCode: Map<string, string>;
  /** Searchable spellings (normalized) and the city each one means; longest first, so "קריית ים" wins over "ים". */
  names: [string, string][];
}

const clean = (name: string) => name.replace(/\s+/g, ' ').replace(/[()]/g, '').trim();

/** Free text in one form: Hebrew quote marks as ASCII, hyphens, dashes and punctuation as spaces. */
const normalize = (text: string) =>
  ` ${text.replace(/״/g, '"').replace(/׳/g, "'").replace(/[-–—,.;:()/\\|]+/g, ' ').replace(/\s+/g, ' ').trim()} `;

/** Localities that are real CBS names but also common words in addresses; never taken from free text. */
const NEVER_FROM_TEXT = new Set(['אזור', 'רחוב', 'כרמל', 'אלון', 'כרמים', 'מבקיעים']);
/** Street names that contain a locality's name. */
const STREETS = ['יגאל אלון', 'אריאל שרון', 'רבנו ירוחם', 'קרן היסוד', 'שדרות ירושלים'];
/** "רחוב X", "רח' X", "שדרות X", "שד' X", "דרך X": X is a street, not a city ("שדרות" alone is the city Sderot). */
const STREET_PHRASE = / (?:רחוב|רח'|רח|שדרות|שד'|דרך) [^\s\d]+/g;

function searchable(name: string): string | null {
  const n = normalize(name).trim();
  if (NEVER_FROM_TEXT.has(n)) return null;
  // Two-letter nicknames ("תא") are too common as words; abbreviations with a quote mark (ת"א) are safe.
  if (n.length < 3 && !/["']/.test(n)) return null;
  return n;
}

export function buildLocalities(records: readonly { code: string; name: string }[]): Localities {
  const byCode = new Map<string, string>();
  for (const r of records) {
    const name = clean(r.name);
    if (name) byCode.set(String(Number(r.code)), name);
  }
  const names = new Map<string, string>();
  for (const city of [...byCode.values(), ...AREA_CITIES]) {
    const key = searchable(city);
    if (key) names.set(key, city);
  }
  for (const [alias, city] of Object.entries(CITY_ALIASES)) {
    const key = searchable(alias);
    if (key && !names.has(key)) names.set(key, city);
  }
  return { byCode, names: [...names].sort((a, b) => b[0].length - a[0].length) };
}

export async function loadLocalities(): Promise<Localities> {
  const body = await getJson<{ result: { records: Record[] } }>(LOCALITIES);
  return buildLocalities(body.result.records.map((r) => ({ code: String(r.סמל_ישוב), name: String(r.שם_ישוב) })));
}

function findIn(localities: Localities, text: string): string {
  let t = normalize(text);
  for (const street of STREETS) t = t.replaceAll(` ${street} `, ' ');
  t = t.replace(STREET_PHRASE, ' ');
  return localities.names.find(([key]) => t.includes(` ${key} `))?.[1] ?? '';
}

/** The branch's city as a name, or '' when it cannot be told. */
export function cityName(localities: Localities, city: string, name: string, address: string, chainId = ''): string {
  const trimmed = city.trim();
  if (/^\d+$/.test(trimmed) && Number(trimmed) > 0) {
    const code = String(Number(trimmed));
    const known = CHAIN_CITY_CODES[chainId]?.[code] ?? localities.byCode.get(code);
    if (known) return known;
  } else if (trimmed && !/^\d+$/.test(trimmed) && !/^unknown$/i.test(trimmed)) {
    return clean(trimmed);
  }
  // The branch's own name says where it is more reliably than an address, which may name a street after a city.
  return findIn(localities, name) || findIn(localities, address);
}
