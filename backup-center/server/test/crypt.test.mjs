import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { encryptText, decryptText, hashPassword, verifyPassword, hashToken } from '../src/crypt.mjs';
import { parseJson, id, timingSafeEqualStr } from '../src/util.mjs';

test('AES-256-GCM 加解密', () => {
  const key = crypto.randomBytes(32);
  const enc = encryptText(key, '仓库密码-测试');
  assert.match(enc, /^v1:/);
  assert.equal(decryptText(key, enc), '仓库密码-测试');
  const tampered = enc.slice(0, -2) + 'AA';
  assert.throws(() => decryptText(key, tampered));
});

test('scrypt 口令哈希与校验', () => {
  const h = hashPassword('p@ssw0rd');
  assert.equal(verifyPassword('p@ssw0rd', h), true);
  assert.equal(verifyPassword('wrong', h), false);
});

test('hashToken 稳定且不可逆', () => {
  assert.equal(hashToken('abc'), hashToken('abc'));
  assert.notEqual(hashToken('abc'), hashToken('abd'));
  assert.equal(hashToken('abc').length, 64);
});

test('工具函数', () => {
  assert.equal(parseJson('{"a":1}').a, 1);
  assert.equal(parseJson('bad', { x: 2 }).x, 2);
  assert.match(id('c'), /^c_[0-9a-f]{12}$/);
  assert.equal(timingSafeEqualStr('abc', 'abc'), true);
  assert.equal(timingSafeEqualStr('abc', 'abd'), false);
});
