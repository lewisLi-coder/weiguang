const fs = require('node:fs/promises');
const path = require('node:path');

const allowedRoles = new Set(['user', 'assistant']);

function normalizeMessage(message) {
  if (!message || !allowedRoles.has(message.role)) return null;
  const content = typeof message.content === 'string' ? message.content.trim() : '';
  if (!content) return null;

  return {
    role: message.role,
    content,
    createdAt: message.createdAt || new Date().toISOString()
  };
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map(normalizeMessage).filter(Boolean);
}

function createHistoryStore({ filePath }) {
  async function ensureDirectory() {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
  }

  async function read() {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      return normalizeMessages(JSON.parse(raw));
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) {
        return [];
      }
      throw error;
    }
  }

  async function replace(messages) {
    const normalized = normalizeMessages(messages);
    await ensureDirectory();
    await fs.writeFile(filePath, JSON.stringify(normalized, null, 2), 'utf8');
    return normalized;
  }

  async function append(message) {
    const normalized = normalizeMessage(message);
    if (!normalized) {
      throw new Error('History message must include role and content.');
    }
    const messages = await read();
    messages.push(normalized);
    await replace(messages);
    return normalized;
  }

  return { read, replace, append };
}

module.exports = { createHistoryStore, normalizeMessages };
