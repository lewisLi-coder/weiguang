const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createHistoryStore } = require('../lib/historyStore');
const { createApp } = require('../server');

async function createTestServer(options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-server-'));
  const historyStore = options.historyStore || createHistoryStore({ filePath: path.join(dir, 'history.json') });
  const app = createApp({
    historyStore,
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl,
    staticDir: dir
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  return {
    historyStore,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test('GET /api/history returns saved history', async () => {
  const server = await createTestServer();
  try {
    await server.historyStore.replace([{ role: 'user', content: '你好' }]);

    const response = await fetch(`${server.baseUrl}/api/history`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].content, '你好');
  } finally {
    await server.close();
  }
});

test('GET /api/history passes clientId to the history store', async () => {
  const seen = [];
  const historyStore = {
    read: async (clientId) => {
      seen.push(clientId);
      return [{ role: 'assistant', content: '历史在这里。', createdAt: '2026-05-22T01:00:00.000Z' }];
    },
    replace: async () => [],
    append: async () => ({ role: 'user', content: 'unused', createdAt: '2026-05-22T01:00:00.000Z' })
  };
  const server = await createTestServer({ historyStore });
  try {
    const response = await fetch(`${server.baseUrl}/api/history?clientId=browser-123`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(seen[0], 'browser-123');
    assert.equal(body.messages[0].content, '历史在这里。');
  } finally {
    await server.close();
  }
});

test('POST /api/chat returns 500 when API key is missing', async () => {
  const server = await createTestServer();
  try {
    const response = await fetch(`${server.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '你好' })
    });
    const body = await response.json();

    assert.equal(response.status, 500);
    assert.match(body.error, /ZHIPU_API_KEY/);
  } finally {
    await server.close();
  }
});

test('POST /api/chat sends history to Zhipu and saves the reply for a clientId', async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), authorization: options.headers.Authorization });
    return Response.json({
      choices: [{ message: { content: '我听见你了。' } }]
    });
  };
  const server = await createTestServer({ apiKey: 'test-key', fetchImpl: fakeFetch });
  try {
    const response = await fetch(`${server.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '今天有点累', clientId: 'browser-123' })
    });
    const body = await response.json();
    const history = await server.historyStore.read('browser-123');

    assert.equal(response.status, 200);
    assert.equal(body.reply, '我听见你了。');
    assert.equal(calls[0].authorization, 'Bearer test-key');
    assert.equal(calls[0].body.model, 'glm-4-plus');
    assert.equal(calls[0].body.messages.at(-1).content, '今天有点累');
    assert.deepEqual(history.map((item) => item.role), ['user', 'assistant']);
  } finally {
    await server.close();
  }
});

test('GET /api/locale returns English for non-China country headers', async () => {
  const server = await createTestServer();
  try {
    const response = await fetch(`${server.baseUrl}/api/locale`, {
      headers: { 'x-vercel-ip-country': 'US' }
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.locale, 'en');
  } finally {
    await server.close();
  }
});

test('GET /api/locale supports EdgeOne country header', async () => {
  const server = await createTestServer();
  try {
    const response = await fetch(`${server.baseUrl}/api/locale`, {
      headers: { 'eo-client-ipcountry': 'US' }
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.locale, 'en');
  } finally {
    await server.close();
  }
});

test('POST /api/chat uses English system prompt for foreign IP requests', async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), authorization: options.headers.Authorization });
    return Response.json({
      choices: [{ message: { content: 'I hear you.' } }]
    });
  };
  const server = await createTestServer({ apiKey: 'test-key', fetchImpl: fakeFetch });
  try {
    const response = await fetch(`${server.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-vercel-ip-country': 'US'
      },
      body: JSON.stringify({ message: 'I feel tired', clientId: 'browser-us' })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.reply, 'I hear you.');
    assert.match(calls[0].body.messages[0].content, /Always reply in English/);
  } finally {
    await server.close();
  }
});
