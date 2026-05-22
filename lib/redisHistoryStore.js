const { normalizeMessages } = require('./historyStore');

function sanitizeClientId(clientId) {
  const value = typeof clientId === 'string' ? clientId.trim() : '';
  if (!value) return 'default';
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'default';
}

function normalizeBaseUrl(restUrl) {
  return restUrl.replace(/\/+$/, '');
}

function createRedisHistoryStore({ restUrl, token, fetchImpl = global.fetch }) {
  if (!restUrl || !token) {
    throw new Error('Upstash Redis restUrl and token are required.');
  }
  const baseUrl = normalizeBaseUrl(restUrl);

  function keyFor(clientId) {
    return `chat:history:${sanitizeClientId(clientId)}`;
  }

  async function request(command) {
    const response = await fetchImpl(baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(command)
    });

    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || 'Upstash Redis request failed.');
    }
    return data.result;
  }

  async function read(clientId) {
    const result = await request(['GET', keyFor(clientId)]);
    if (!result) return [];
    try {
      return normalizeMessages(JSON.parse(result));
    } catch (_error) {
      return [];
    }
  }

  async function replace(clientId, messages) {
    const normalized = normalizeMessages(messages);
    await request(['SET', keyFor(clientId), JSON.stringify(normalized)]);
    return normalized;
  }

  async function append(clientId, message) {
    const normalized = normalizeMessages([message])[0];
    if (!normalized) {
      throw new Error('History message must include role and content.');
    }
    const messages = await read(clientId);
    messages.push(normalized);
    await replace(clientId, messages);
    return normalized;
  }

  return { read, replace, append };
}

module.exports = { createRedisHistoryStore, sanitizeClientId };
