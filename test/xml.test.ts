import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { branches, decode, priceItems } from '../src/xml.ts';

const price = `<?xml version="1.0" encoding="utf-8"?><Root><ChainID>7290058140886</ChainID><Items>
<Item><ItemCode>7290004131074</ItemCode><ItemName>חלב בקרטון 3% שומן 1 ל</ItemName><ManufactureName>תנובה &amp; שות'</ManufactureName><UnitQty>ליטר</UnitQty><Quantity>1.00</Quantity><bIsWeighted>0</bIsWeighted><ItemPrice>7.20</ItemPrice></Item>
<ITEM><ITEMCODE>0007290000068237</ITEMCODE><ITEMNAME>קוטג</ITEMNAME><ITEMPRICE>6.10</ITEMPRICE><UnitQty>לא ידוע</UnitQty><UnitOfMeasure>100 גרם</UnitOfMeasure></ITEM>
<Item><ItemCode>123</ItemCode><ItemPrice>1</ItemPrice></Item>
<Item><ItemCode>7290000000009</ItemCode><ItemPrice>0</ItemPrice></Item>
</Items></Root>`;

test('reads items in any tag case, in agorot, skipping bad rows', () => {
  const items = [...priceItems(price)];
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { barcode: '7290004131074', name: 'חלב בקרטון 3% שומן 1 ל', manufacturer: "תנובה & שות'", quantity: 1, unit: 'ליטר', weighted: false, priceAgorot: 720 });
  assert.equal(items[1].barcode, '7290000068237');
  assert.equal(items[1].unit, '100 גרם');
});

test('decodes gzip, a UTF-8 BOM and UTF-16', () => {
  assert.equal(decode(gzipSync(Buffer.from('<a/>'))), '<a/>');
  assert.equal(decode(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<a/>')])), '<a/>');
  assert.equal(decode(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<a/>', 'utf16le')])), '<a/>');
});

test('reads branches from both Stores layouts', () => {
  const shufersal = '<asx:values><STORES><STORE><STOREID>444</STOREID><STORENAME>אקספרס</STORENAME><ADDRESS>יעקב כהן 8</ADDRESS><CITY>9000</CITY></STORE></STORES></asx:values>';
  const rami = '<Root><Branches><Branch><StoreId>0711</StoreId><StoreName>רגר</StoreName><City>באר שבע</City></Branch></Branches></Root>';
  assert.deepEqual([...branches(shufersal)], [{ store: '444', name: 'אקספרס', address: 'יעקב כהן 8', city: '9000' }]);
  assert.equal([...branches(rami)][0].store, '711');
});
