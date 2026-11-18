import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, nextOccurrence, inWindow, validateCron } from '../src/cron.mjs';

test('parseCron 解析列表/步长/范围', () => {
  const c = parseCron('*/5 1-3 * * 1');
  assert.deepEqual([...c.minute].sort((a, b) => a - b), [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  assert.deepEqual([...c.hour].sort((a, b) => a - b), [1, 2, 3]);
  assert.equal(c.dow.has(1), true);
});

test('nextOccurrence 返回下一次匹配时间', () => {
  const after = new Date('2026-11-18T10:00:00+08:00');
  const next = nextOccurrence('30 23 * * *', after);
  assert.equal(next.getHours(), 23);
  assert.equal(next.getMinutes(), 30);
  assert.ok(next.getTime() > after.getTime());
});

test('inWindow 支持跨午夜窗口', () => {
  const at = (h, m) => new Date(2026, 0, 1, h, m, 0);
  assert.equal(inWindow(at(23, 30), { start: '22:00', end: '06:00' }), true);
  assert.equal(inWindow(at(3, 0), { start: '22:00', end: '06:00' }), true);
  assert.equal(inWindow(at(12, 0), { start: '22:00', end: '06:00' }), false);
  assert.equal(inWindow(at(12, 0), {}), true);
});

test('validateCron 拒绝非法表达式', () => {
  assert.equal(validateCron('0 2 * * *'), true);
  assert.throws(() => validateCron('0 2 * *'));
  assert.throws(() => validateCron('61 2 * * *'));
});
