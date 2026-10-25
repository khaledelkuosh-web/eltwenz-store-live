'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { sealSecret, openSecret } = require('../lib/secret-box');

test('encrypts refresh tokens with authenticated encryption and rejects tampering', () => {
  const key = crypto.randomBytes(32);
  const refreshToken = 'refresh-token-sensitive-test-value';
  const encrypted = sealSecret(refreshToken, key);
  assert.equal(encrypted.includes(refreshToken), false);
  assert.equal(openSecret(encrypted, key), refreshToken);
  const record = JSON.parse(encrypted);
  record.ciphertext = Buffer.from('tampered').toString('base64url');
  assert.throws(() => openSecret(JSON.stringify(record), key));
  assert.throws(() => openSecret(encrypted, crypto.randomBytes(32)));
});
