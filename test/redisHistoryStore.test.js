const assert = require('node:assert/strict');
const test = require('node:test');

const { createRedisHistoryStore } = require('../lib/redisHistoryStore');

function createFakeFetch(responses = []) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    const next = responses.shift() || { result: null };
    return Response.json(next);
  };
  return { calls, fetchImpl };
}

test('redisHistoryStore reads messages for a clientId', async () => {
  const stored = JSON.stringify([{ role: 'user', content: '你好', createdAt: '2026-05-22T01:00:00.000Z' }]);
  const fake = createFakeFetch([{ result: stored }]);
  const store = createRedisHistoryStore({
    restUrl: 'https://redis.example.com',
    token: 'redis-token',
    fetchImpl: fake.fetchImpl
  });

  const messages = await store.read('client-1');

  assert.deepEqual(messages, [{ role: 'user', content: '你好', createdAt: '2026-05-22T01:00:00.000Z' }]);
  assert.equal(fake.calls[0].url, 'https://redis.example.com');
  assert.equal(fake.calls[0].options.headers.Authorization, 'Bearer redis-token');
  assert.deepEqual(fake.calls[0].body, ['GET', 'chat:history:client-1']);
});

test('redisHistoryStore replaces normalized messages for a clientId', async () => {
  const fake = createFakeFetch([{ result: 'OK' }]);
  const store = createRedisHistoryStore({
    restUrl: 'https://redis.example.com/',
    token: 'redis-token',
    fetchImpl: fake.fetchImpl
  });

  const saved = await store.replace('client-1', [
    { role: 'assistant', content: '我在这里。', createdAt: '2026-05-22T01:00:01.000Z' },
    { role: 'system', content: 'ignore me' }
  ]);

  assert.deepEqual(saved, [{ role: 'assistant', content: '我在这里。', createdAt: '2026-05-22T01:00:01.000Z' }]);
  assert.equal(fake.calls[0].url, 'https://redis.example.com');
  assert.deepEqual(fake.calls[0].body, ['SET', 'chat:history:client-1', JSON.stringify(saved)]);
});

test('redisHistoryStore appends a message for a clientId', async () => {
  const existing = JSON.stringify([{ role: 'user', content: '你好', createdAt: '2026-05-22T01:00:00.000Z' }]);
  const fake = createFakeFetch([{ result: existing }, { result: 'OK' }]);
  const store = createRedisHistoryStore({
    restUrl: 'https://redis.example.com',
    token: 'redis-token',
    fetchImpl: fake.fetchImpl
  });

  const saved = await store.append('client-1', { role: 'assistant', content: '我听见你了。' });

  assert.equal(saved.role, 'assistant');
  assert.equal(saved.content, '我听见你了。');
  assert.match(saved.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(fake.calls[1].url, 'https://redis.example.com');
  assert.equal(JSON.parse(fake.calls[1].body[2]).length, 2);
});
