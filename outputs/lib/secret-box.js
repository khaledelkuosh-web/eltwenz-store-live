'use strict';

const crypto = require('node:crypto');

function sealSecret(value, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError('Encryption key must be 32 bytes.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return JSON.stringify({ version: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') });
}

function openSecret(value, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError('Encryption key must be 32 bytes.');
  const record = JSON.parse(value);
  if (record.version !== 1) throw new Error('Unsupported encrypted secret version.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

module.exports = { sealSecret, openSecret };
