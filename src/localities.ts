import { getJson } from './http.ts';

/**
 * Most chains publish a branch's city as the CBS locality code (9000 = באר
 * שבע), some as a name, some not at all. The government's locality list
 * (data.gov.il) turns codes into names; when there is no usable code, the
 * name is looked for in the branch's own name and address ("רגר באר שבע").
 */
const LOCALITIES = 'https://data.gov.il/api/3/action/datastore_search?resource_id=5c78e9fa-c2e2-4771-93ff-7f400a12f7ba&limit=5000';

interface Record {
  סמל_ישוב: string | number;
  שם_ישוב: string;
}

export interface Localities {
  byCode: Map<string, string>;
  /** Longest first, so "קריית ים" wins over "ים". */
  names: string[];
}

const clean = (name: string) => name.replace(/\s+/g, ' ').replace(/[()]/g, '').trim();

export async function loadLocalities(): Promise<Localities> {
  const body = await getJson<{ result: { records: Record[] } }>(LOCALITIES);
  const byCode = new Map<string, string>();
  for (const r of body.result.records) {
    const name = clean(String(r.שם_ישוב));
    if (name) byCode.set(String(Number(r.סמל_ישוב)), name);
  }
  const names = [...new Set(byCode.values())].filter((n) => n.length >= 3).sort((a, b) => b.length - a.length);
  return { byCode, names };
}

/** The branch's city as a name, or '' when it cannot be told. */
export function cityName(localities: Localities, city: string, name: string, address: string): string {
  const trimmed = city.trim();
  if (/^\d+$/.test(trimmed) && Number(trimmed) > 0) return localities.byCode.get(String(Number(trimmed))) ?? '';
  if (trimmed && !/^\d+$/.test(trimmed)) return clean(trimmed);
  const text = ` ${name} ${address} `.replace(/["׳']/g, '');
  return localities.names.find((n) => text.includes(` ${n} `) || text.includes(` ${n},`)) ?? '';
}
