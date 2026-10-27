import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLocalities, cityName } from '../src/localities.ts';

// A slice of the government list, with the real codes; the tricky names are real CBS localities.
const localities = buildLocalities(
  [
    ['9000', 'באר שבע'], ['70', 'אשדוד'], ['2800', 'קריית שמונה'], ['8400', 'רחובות'], ['8500', 'רמלה'], ['3000', 'ירושלים'],
    ['7100', 'אשקלון'], ['1031', 'שדרות'], ['3570', 'אריאל'], ['831', 'ירוחם'], ['1290', 'כרמים'], ['1342', 'מבקיעים'],
    ['1264', 'כרמל'], ['330', 'אלון'], ['1269', 'רחוב'], ['1301', 'אזור'], ['4000', 'חיפה'], ['5000', 'תל אביב - יפו'],
    ['1200', 'מודיעין-מכבים-רעות'], ['3797', 'מודיעין עילית'], ['2710', 'אום אל-פחם'], ['7300', 'נצרת'],
  ].map(([code, name]) => ({ code, name })),
);
const city = (c: string, name: string, address = '', chain = '') => cityName(localities, c, name, address, chain);

test('a code becomes its name, a name stays, unknown codes fall back to the text', () => {
  assert.equal(city('9000', 'x'), 'באר שבע');
  assert.equal(city('0070', 'x'), 'אשדוד');
  assert.equal(city('תל  אביב', 'x'), 'תל אביב');
  assert.equal(city('0', 'רגר באר שבע', 'יעקב כהן 12'), 'באר שבע');
  assert.equal(city('', 'סניף', 'הרצל 3, קריית שמונה'), 'קריית שמונה');
  assert.equal(city('', 'סניף', ''), '');
  assert.equal(city('99999', 'אקספרס אשקלון'), 'אשקלון');
  assert.equal(city('unknown', 'אקספרס אשקלון'), 'אשקלון');
});

test("Shufersal's own codes that are not CBS codes", () => {
  assert.equal(city('10098', 'BE דלית אל כרמל', 'דלית אל כרמל', 'shufersal'), 'דאלית אל-כרמל');
  assert.equal(city('10044', 'BE אפרת', 'זית שמן 3', 'shufersal'), 'אפרת');
  assert.equal(city('50', 'אקספרס גבעת עדה', 'חי 67', 'shufersal'), 'בנימינה-גבעת עדה');
  assert.equal(city('10018', 'יוניברס עמק חפר- אזור תעשיה', '', 'shufersal'), 'עמק חפר');
  assert.equal(city('1306', 'יוניברס צור יגאל- מרכז מסחרי', '', 'shufersal'), 'כוכב יאיר-צור יגאל');
  // Another chain's 50 is not Shufersal's.
  assert.equal(city('50', 'סניף', '', 'rami_levy'), '');
});

test('the branch name wins over the address, and streets named after places are not cities (the wrong cities in the 2026-10-27 data)', () => {
  assert.equal(city('', 'רמלה', 'שדרות ירושלים פינת נופי חמד'), 'רמלה');
  assert.equal(city('', 'יש חסד שדרות', '19 אריאל שרון'), 'שדרות');
  assert.equal(city('', 'מבקיעים אשקלון', 'מתחם גלובוס סנטר, מבקיעים'), 'אשקלון');
  assert.equal(city('', 'מודיעין כרמים', 'unknown'), 'מודיעין-מכבים-רעות');
  assert.equal(city('', 'יפו מכללה יום ביום', 'רבנו ירוחם 2'), 'תל אביב-יפו');
  assert.equal(city('', 'דליית אל כרמל', 'ואדי אלפש, כביש 672 0'), 'דאלית אל-כרמל');
  assert.equal(city('', 'קאסם', 'התאנה , אזור תעשייה לב הארץ 5'), 'כפר קאסם');
  // Nothing to go on: better no city than a street's.
  assert.equal(city('', 'יוחננוף מפוח', 'רחוב המפוח 11, אזור התעשיה'), '');
  assert.equal(city('', 'אחד העם', 'רחוב אחד העם 19'), '');
  assert.equal(city('', 'יד אליהו', 'יגאל אלון 57'), '');
  assert.equal(city('', 'מרכז', "רח' ירושלים 5"), '');
});

test('nicknames and abbreviations in names', () => {
  assert.equal(city('', 'ראשלצ רמת אליהו', 'משורר השואה 15'), 'ראשון לציון');
  assert.equal(city('', 'בן צבי תל אביב', 'unknown'), 'תל אביב-יפו');
  assert.equal(city('', 'ת"א - אחד העם', 'unknown'), 'תל אביב-יפו');
  assert.equal(city('', 'ת״א - אחד העם', 'unknown'), 'תל אביב-יפו');
  assert.equal(city('', 'יפת-יפו תל אביב יום ביום', 'יפת 65 65'), 'תל אביב-יפו');
  assert.equal(city('', 'סכנין', "אל ג'ליל  , קניון סכנין מול 805"), "סח'נין");
  assert.equal(city('', 'מיני קינג דיר חנא', 'אלקודס 0'), 'דייר חנא');
  assert.equal(city('', 'עקרון', 'המלך חסן 1'), 'קרית עקרון');
  assert.equal(city('', 'מודיעין ישפרו', 'unknown'), 'מודיעין-מכבים-רעות');
  assert.equal(city('', 'צמח', 'צומת צמח מול כנרת'), 'צמח');
  assert.equal(city('', 'BE פרישמן ת"א', 'דיזינגוף 102'), 'תל אביב-יפו');
});

test('without the government list a coded city is left empty (the server keeps the one it has); names and known spellings still work', () => {
  const none = buildLocalities([]);
  assert.equal(none.codes, false);
  assert.equal(cityName(none, '9000', 'רגר באר שבע', ''), '');
  assert.equal(cityName(none, '10044', 'BE אפרת', '', 'shufersal'), 'אפרת');
  assert.equal(cityName(none, 'באר שבע', 'x', ''), 'באר שבע');
  assert.equal(cityName(none, '', 'שלי תל אביב', ''), 'תל אביב-יפו');
});
