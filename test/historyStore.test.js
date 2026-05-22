const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createHistoryStore } = require('../lib/historyStore');

async function tempFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-history-'));
  return path.join(dir, 'history.json');
}

test('historyStore returns an empty list when no history file exists', async () => {
  const store = createHistoryStore({ filePath: await tempFile() });

  assert.deepEqual(await store.read(), []);
});

test('historyStore replaces history with normalized message records', async () => {
  const filePath = await tempFile();
  const store = createHistoryStore({ filePath });

  await store.replace([
    { role: 'user', content: '你好', createdAt: '2026-05-22T01:00:00.000Z' },
    { role: 'assistant', content: '我在这里。', createdAt: '2026-05-22T01:00:01.000Z' },
    { role: 'system', content: 'should be removed' },
    { role: 'user', content: '' }
  ]);

  assert.deepEqual(await store.read(), [
    { role: 'user', content: '你好', createdAt: '2026-05-22T01:00:00.000Z' },
    { role: 'assistant', content: '我在这里。', createdAt: '2026-05-22T01:00:01.000Z' }
  ]);
});

test('historyStore appends messages and creates timestamps', async () => {
  const store = createHistoryStore({ filePath: await tempFile() });

  const saved = await store.append({ role: 'user', content: '今天有点累' });

  assert.equal(saved.role, 'user');
  assert.equal(saved.content, '今天有点累');
  assert.match(saved.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(await store.read(), [saved]);
});

test('historyStore recovers from malformed JSON by returning empty history', async () => {
  const filePath = await tempFile();
  await fs.writeFile(filePath, '{broken json', 'utf8');
  const store = createHistoryStore({ filePath });

  assert.deepEqual(await store.read(), []);
});
