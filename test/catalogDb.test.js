import test from 'node:test';
import assert from 'node:assert/strict';
import { upsertCatalogVariation } from '../src/db.js';

test('upsertCatalogVariation records field history when inserting a catalog item', async () => {
  const statements = [];
  const db = {
    execute: async (sql, params = {}) => {
      statements.push({ sql, params });
      if (sql.includes('SELECT *') && sql.includes('SKU_Temp')) return [[]];
      if (sql.includes('SELECT *') && sql.includes('SKU')) return [[]];
      return [{}];
    },
  };

  const result = await upsertCatalogVariation(db, {
    skuTemp: 'SKU_Temp',
    skuMain: 'SKU',
    skuHistory: 'SKU_History',
  }, {
    token: 'VAR123',
    itemName: 'Catalog Item',
    description: '',
    category: 'Body',
    sku: '123456789012',
    gtin: '',
    variationName: 'NS,NC,Mimic',
    price: '10.99',
    cost: '5.10',
    vendor: 'Vendor',
    quantity: 7,
    alertEnabled: 'N',
    alertCount: null,
    tax: 'Y',
  }, new Date('2026-07-26T23:18:59Z'));

  assert.equal(result.status, 'success');
  assert.equal(result.changed, true);

  const historyRows = statements
    .filter((statement) => statement.sql.includes('INSERT INTO `SKU_History`'))
    .map((statement) => statement.params);

  assert.equal(historyRows.some((row) => row.fieldName === 'INSERT'), true);
  assert.equal(historyRows.some((row) => row.fieldName === 'Cost' && row.newValue === '5.10'), true);
  assert.equal(historyRows.some((row) => row.fieldName === 'Price' && row.newValue === '10.99'), true);
  assert.equal(historyRows.some((row) => row.fieldName === 'Quantity' && row.newValue === '7'), true);
  assert.equal(historyRows.some((row) => row.fieldName === 'Size' && row.newValue === 'NS'), true);
  assert.equal(historyRows.some((row) => row.fieldName === 'Color' && row.newValue === 'NC'), true);
  assert.equal(historyRows.some((row) => row.fieldName === 'Style' && row.newValue === 'Mimic'), true);
  assert.equal(historyRows.some((row) => row.fieldName === 'Deleted'), false);

  const tempInsert = statements.find((statement) => statement.sql.includes('INSERT INTO `SKU_Temp`'));
  assert.equal(tempInsert.params.Size, 'NS');
  assert.equal(tempInsert.params.Color, 'NC');
  assert.equal(tempInsert.params.Style, 'Mimic');

  const mainInsert = statements.find((statement) => statement.sql.includes('INSERT INTO `SKU`'));
  assert.equal(Object.hasOwn(mainInsert.params, 'Size'), false);
});

test('upsertCatalogVariation truncates parsed SKU_Temp detail fields to column limits', async () => {
  const statements = [];
  const db = {
    execute: async (sql, params = {}) => {
      statements.push({ sql, params });
      if (sql.includes('SELECT *') && sql.includes('SKU_Temp')) return [[]];
      if (sql.includes('SELECT *') && sql.includes('SKU')) return [[]];
      return [{}];
    },
  };

  await upsertCatalogVariation(db, {
    skuTemp: 'SKU_Temp',
    skuMain: 'SKU',
    skuHistory: 'SKU_History',
  }, {
    token: 'VAR456',
    itemName: 'Long Detail Item',
    description: '',
    category: 'Body',
    sku: '123456789013',
    gtin: '',
    variationName: `${'S'.repeat(30)},${'C'.repeat(60)},${'T'.repeat(70)}`,
    price: '10.99',
    cost: '5.10',
    vendor: 'Vendor',
    quantity: 7,
    alertEnabled: 'N',
    alertCount: null,
    tax: 'Y',
  }, new Date('2026-07-26T23:18:59Z'));

  const tempInsert = statements.find((statement) => statement.sql.includes('INSERT INTO `SKU_Temp`'));
  assert.equal(tempInsert.params.Size, 'S'.repeat(20));
  assert.equal(tempInsert.params.Color, 'C'.repeat(50));
  assert.equal(tempInsert.params.Style, 'T'.repeat(50));
});

test('upsertCatalogVariation treats comma-less variation names as style', async () => {
  const statements = [];
  const db = {
    execute: async (sql, params = {}) => {
      statements.push({ sql, params });
      if (sql.includes('SELECT *') && sql.includes('SKU_Temp')) return [[]];
      if (sql.includes('SELECT *') && sql.includes('SKU')) return [[]];
      return [{}];
    },
  };

  await upsertCatalogVariation(db, {
    skuTemp: 'SKU_Temp',
    skuMain: 'SKU',
    skuHistory: 'SKU_History',
  }, {
    token: 'VAR789',
    itemName: 'Style Only Item',
    description: '',
    category: 'Body',
    sku: '123456789014',
    gtin: '',
    variationName: 'Mimic',
    price: '10.99',
    cost: '5.10',
    vendor: 'Vendor',
    quantity: 7,
    alertEnabled: 'N',
    alertCount: null,
    tax: 'Y',
  }, new Date('2026-07-26T23:18:59Z'));

  const tempInsert = statements.find((statement) => statement.sql.includes('INSERT INTO `SKU_Temp`'));
  assert.equal(tempInsert.params.Size, '');
  assert.equal(tempInsert.params.Color, '');
  assert.equal(tempInsert.params.Style, 'Mimic');
});

test('upsertCatalogVariation prefers matching existing SKU rows before token rows', async () => {
  const statements = [];
  const db = {
    execute: async (sql, params = {}) => {
      statements.push({ sql, params });
      if (sql.includes('SELECT *') && sql.includes('SKU_Temp')) return [[]];
      if (sql.includes('SELECT *') && sql.includes('SKU')) return [[]];
      return [{}];
    },
  };

  await upsertCatalogVariation(db, {
    skuTemp: 'SKU_Temp',
    skuMain: 'SKU',
    skuHistory: 'SKU_History',
  }, {
    token: 'VAR-SKU-FIRST',
    itemName: 'SKU First Item',
    description: '',
    category: 'Body',
    sku: '123456789015',
    gtin: '',
    variationName: 'Mimic',
    price: '10.99',
    cost: '5.10',
    vendor: 'Vendor',
    quantity: 7,
    alertEnabled: 'N',
    alertCount: null,
    tax: 'Y',
  }, new Date('2026-07-26T23:18:59Z'));

  const lookup = statements.find((statement) => statement.sql.includes('SELECT *') && statement.sql.includes('SKU_Temp'));
  assert.match(lookup.sql, /WHEN :sku <> '' AND SKU = :sku THEN 0/);
  assert.match(lookup.sql, /WHEN Token = :token THEN 1/);
});

test('upsertCatalogVariation clears stale deleted SKU token conflicts before updating current SKU', async () => {
  const statements = [];
  const currentValues = {
    Token: 'NEW-TOKEN',
    ItemName: 'SKU First Item',
    Description: '',
    Cat: 'Body',
    SKU: '123456789016',
    GTIN: '',
    VarName: 'Mimic',
    Price: '10.99',
    Cost: '5.10',
    Vendor: 'Vendor',
    Quantity: 7,
    AlertEnable: 'N',
    AlertCount: null,
    Tax: 'Y',
    Remove: 'N',
  };
  const db = {
    execute: async (sql, params = {}) => {
      statements.push({ sql, params });
      if (sql.includes('SELECT *') && sql.includes('SKU_Temp')) {
        return [[{ ID: 20, Deleted: null, Size: '', Color: '', Style: 'Mimic', ...currentValues }]];
      }
      if (sql.includes('SELECT *') && sql.includes('SKU')) {
        return [[{ ID: 10, Deleted: 'Y', ...currentValues, Token: 'OLD-TOKEN' }]];
      }
      if (sql.includes('SELECT ID, SKU, Token, Deleted') && sql.includes('SKU')) {
        return [[{ ID: 11, SKU: 'OLD-SKU', Token: 'NEW-TOKEN', Deleted: 'Y' }]];
      }
      return [{}];
    },
  };

  await upsertCatalogVariation(db, {
    skuTemp: 'SKU_Temp',
    skuMain: 'SKU',
    skuHistory: 'SKU_History',
  }, {
    token: 'NEW-TOKEN',
    itemName: 'SKU First Item',
    description: '',
    category: 'Body',
    sku: '123456789016',
    gtin: '',
    variationName: 'Mimic',
    price: '10.99',
    cost: '5.10',
    vendor: 'Vendor',
    quantity: 7,
    alertEnabled: 'N',
    alertCount: null,
    tax: 'Y',
  }, new Date('2026-07-26T23:18:59Z'));

  assert.equal(statements.some((statement) =>
    statement.sql.includes('UPDATE `SKU`') &&
    statement.sql.includes('Token = :staleToken') &&
    statement.params.staleToken === 'STALE-11'
  ), true);
  assert.equal(statements.some((statement) =>
    statement.sql.includes('INSERT INTO `SKU_History`') &&
    statement.params.sku === 'OLD-SKU' &&
    statement.params.fieldName === 'Token' &&
    statement.params.oldValue === 'NEW-TOKEN' &&
    statement.params.newValue === 'STALE-11'
  ), true);
});
