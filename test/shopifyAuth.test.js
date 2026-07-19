import test from 'node:test';
import assert from 'node:assert/strict';
import { signState, verifyState, tokenExpiryDate } from '../src/shopifyAuth.js';

test('signs and verifies Shopify OAuth state', () => {
  const state = signState({
    secret: 'state-secret',
    storeKey: 'nwt',
    shop: 'NewWithTags.myshopify.com',
    nonce: 'fixed',
  });

  assert.deepEqual(verifyState({ secret: 'state-secret', state }), {
    storeKey: 'nwt',
    shop: 'newwithtags.myshopify.com',
    nonce: 'fixed',
  });
  assert.equal(verifyState({ secret: 'wrong-secret', state }), null);
});

test('calculates token expiry with a safety skew', () => {
  const before = Date.now();
  const expiry = tokenExpiryDate(3600, 60);
  const after = Date.now();
  assert.ok(expiry.getTime() >= before + 3540 * 1000);
  assert.ok(expiry.getTime() <= after + 3540 * 1000);
});
