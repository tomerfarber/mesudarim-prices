import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cityName, type Localities } from '../src/localities.ts';

const localities: Localities = {
  byCode: new Map([['9000', 'באר שבע'], ['70', 'אשדוד'], ['2800', 'קריית שמונה']]),
  names: ['קריית שמונה', 'באר שבע', 'אשדוד'],
};

test('a code becomes its name, a name stays, a missing city is found in the branch name', () => {
  assert.equal(cityName(localities, '9000', 'x', ''), 'באר שבע');
  assert.equal(cityName(localities, '0070', 'x', ''), 'אשדוד');
  assert.equal(cityName(localities, 'תל  אביב', 'x', ''), 'תל אביב');
  assert.equal(cityName(localities, '0', 'רגר באר שבע', 'יעקב כהן 12'), 'באר שבע');
  assert.equal(cityName(localities, '', 'סניף', 'הרצל 3, קריית שמונה'), 'קריית שמונה');
  assert.equal(cityName(localities, '', 'סניף', ''), '');
});
