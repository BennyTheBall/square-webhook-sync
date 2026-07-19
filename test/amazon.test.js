import test from 'node:test';
import assert from 'node:assert/strict';
import { amazonAdvertisedQuantity } from '../src/marketplaces/amazon.js';

test('keeps normal Amazon quantities unchanged', () => {
  assert.equal(amazonAdvertisedQuantity({ skuRecord: { Vendor: 'Other' }, quantity: 9 }), 9);
});

test('caps selected Amazon vendors to a random quantity between 2 and actual', () => {
  assert.equal(amazonAdvertisedQuantity({ skuRecord: { Vendor: 'Inis' }, quantity: 9, random: () => 0 }), 2);
  assert.equal(amazonAdvertisedQuantity({ skuRecord: { Vendor: 'Inis' }, quantity: 9, random: () => 0.99 }), 9);
});

test('does not randomize selected vendors at two or below', () => {
  assert.equal(amazonAdvertisedQuantity({ skuRecord: { Vendor: 'TRF' }, quantity: 2, random: () => 0.99 }), 2);
});
