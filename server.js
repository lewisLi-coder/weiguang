const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');

const { createHistoryStore } = require('./lib/historyStore');
const { createRedisHistoryStore } = require('./lib/redisHistoryStore');

const CHAT_MODEL = 'glm-4-plus';
const ASR_MODEL = 'glm-asr-2512';
const TTS_MODEL = 'glm-tts';
const ZHIPU_CHAT_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const ZHIPU_ASR_URL = 'https://open.bigmodel.cn/api/paas/v4/audio/transcriptions';
const ZHIPU_TTS_URL = 'https://open.bigmodel.cn/api/paas/v4/audio/speech';
const DEFAULT_CLIENT_ID = 'default';

const SYSTEM_PROMPT = '\u4f60\u662f\u4e00\u4e2a\u6e29\u6696\u3001\u667a\u6167\u3001\u5145\u6ee1\u540c\u7406\u5fc3\u7684\u503e\u542c\u8005\uff0c\u540d\u5b57\u53eb\u201c\u5fae\u5149\u201d\u3002\u4f60\u7684\u76ee\u7684\u4e0d\u662f\u89e3\u51b3\u95ee\u9898\uff0c\u800c\u662f\u8ba9\u5bf9\u65b9\u611f\u5230\u88ab\u7406\u89e3\u3001\u88ab\u63a5\u7eb3\u3002\u8bed\u8a00\u5e73\u5b9e\u3001\u4eb2\u5207\uff0c\u4f1a\u4f7f\u7528\u6bd4\u55bb\u3002\u6c38\u8fdc\u4e0d\u8bc4\u5224\u5bf9\u65b9\u3002\u5f53\u7528\u6237\u8868\u73b0\u51fa\u4e25\u91cd\u81ea\u4f24\u503e\u5411\u65f6\uff0c\u5efa\u8bae\u5bfb\u6c42\u4e13\u4e1a\u5fc3\u7406\u5e2e\u52a9\u3002\u4fdd\u6301\u56de\u590d\u7b80\u77ed\uff082\u52304\u53e5\uff09\uff0c\u5076\u5c14\u95ee\u4e00\u4e2a\u6e29\u67d4\u7684\u95ee\u9898\u3002';
const SAD_WORDS = ['\u96be\u8fc7', '\u5d29\u6e83', '\u75db\u82e6', '\u5bb3\u6015', '\u7126\u8651', '\u7d2f', '\u54ed', '\u5b64\u72ec', '\u5931\u7720', '\u6491\u4e0d\u4f4f'];
const BRIGHT_WORDS = ['\u5f00\u5fc3', '\u592a\u597d\u4e86', '\u771f\u597d', '\u606d\u559c', '\u559c\u6b22', '\u671f\u5f85', '\u987a\u5229'];
const URGENT_WORDS = ['\u81ea\u6740', '\u81ea\u4f24', '\u4e0d\u60f3\u6d3b', '\u7ed3\u675f\u751f\u547d', '\u4f24\u5bb3\u81ea\u5df1'];

function loadEnv(filePath = path.join(__dirname, '.env')) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [key, ...valueParts] = trimmed.split('=');
    if (!process.env[key]) {
      process.env[key] = valueParts.join('=').trim();
    }
  }
}

function jsonError(response, status, message) {
  response.status(status).json({ error: message });
}

function buildChatMessages(history, userMessage) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map(({ role, content }) => ({ role, content })),
    { role: 'user', content: userMessage }
  ];
}

function chooseTtsTone(text) {
  if (URGENT_WORDS.some((word) => text.includes(word))) {
    return { speed: 0.88, volume: 0.95 };
  }
  if (SAD_WORDS.some((word) => text.includes(word))) {
    return { speed: 0.92, volume: 0.9 };
  }
  if (BRIGHT_WORDS.some((word) => text.includes(word))) {
    return { speed: 1.05, volume: 1 };
  }
  return { speed: 1, volume: 0.95 };
}

function getClientId(request) {
  const bodyClientId = request.body && typeof request.body.clientId === 'string' ? request.body.clientId : '';
  const queryClientId = request.query && typeof request.query.clientId === 'string' ? request.query.clientId : '';
  return bodyClientId || queryClientId || DEFAULT_CLIENT_ID;
}

function createDefaultHistoryStore() {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    return createRedisHistoryStore({
      restUrl: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN
    });
  }
  return createHistoryStore({ filePath: path.join(__dirname, 'data', 'chat-history.json') });
}

async function readHistory(historyStore, clientId) {
  return historyStore.read.length >= 1 ? historyStore.read(clientId) : historyStore.read();
}

async function replaceHistory(historyStore, clientId, messages) {
  return historyStore.replace.length >= 2 ? historyStore.replace(clientId, messages) : historyStore.replace(messages);
}

async function appendHistory(historyStore, clientId, message) {
  return historyStore.append.length >= 2 ? historyStore.append(clientId, message) : historyStore.append(message);
}

function createApp({
  historyStore = createDefaultHistoryStore(),
  apiKey = process.env.ZHIPU_API_KEY,
  fetchImpl = global.fetch,
  staticDir = path.join(__dirname, 'public')
} = {}) {
  const app = express();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }
  });

  app.use(express.json({ limit: '1mb' }));

  app.get('/api/config-status', (_request, response) => {
    response.json({ hasApiKey: Boolean(apiKey) });
  });

  app.get('/api/history', async (request, response, next) => {
    try {
      response.json({ messages: await readHistory(historyStore, getClientId(request)) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/history', async (request, response, next) => {
    try {
      const messages = await replaceHistory(historyStore, getClientId(request), request.body.messages || []);
      response.json({ messages });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/chat', async (request, response, next) => {
    try {
      if (!apiKey) return jsonError(response, 500, 'Missing ZHIPU_API_KEY in .env.');
      const message = typeof request.body.message === 'string' ? request.body.message.trim() : '';
      if (!message) return jsonError(response, 400, 'Message is required.');

      const clientId = getClientId(request);
      const history = await readHistory(historyStore, clientId);
      await appendHistory(historyStore, clientId, { role: 'user', content: message });

      const zhipuResponse = await fetchImpl(ZHIPU_CHAT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: CHAT_MODEL,
          messages: buildChatMessages(history, message),
          temperature: 0.9,
          max_tokens: 1024
        })
      });

      const data = await zhipuResponse.json();
      if (!zhipuResponse.ok) {
        return jsonError(response, zhipuResponse.status, data.error?.message || 'Zhipu chat request failed.');
      }

      const reply = data.choices?.[0]?.message?.content;
      if (!reply) return jsonError(response, 502, 'Zhipu chat response did not include a reply.');

      const savedReply = await appendHistory(historyStore, clientId, { role: 'assistant', content: reply });
      response.json({ reply, message: savedReply });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/asr', upload.single('audio'), async (request, response, next) => {
    try {
      if (!apiKey) return jsonError(response, 500, 'Missing ZHIPU_API_KEY in .env.');
      if (!request.file) return jsonError(response, 400, 'Audio file is required.');

      const form = new FormData();
      const blob = new Blob([request.file.buffer], { type: request.file.mimetype || 'audio/webm' });
      form.append('file', blob, request.file.originalname || 'recording.webm');
      form.append('model', ASR_MODEL);
      form.append('stream', 'false');

      const zhipuResponse = await fetchImpl(ZHIPU_ASR_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form
      });

      const data = await zhipuResponse.json();
      if (!zhipuResponse.ok) {
        return jsonError(response, zhipuResponse.status, data.error?.message || 'Zhipu ASR request failed.');
      }

      response.json({ text: data.text || '' });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/tts', async (request, response, next) => {
    try {
      if (!apiKey) return jsonError(response, 500, 'Missing ZHIPU_API_KEY in .env.');
      const text = typeof request.body.text === 'string' ? request.body.text.trim() : '';
      if (!text) return jsonError(response, 400, 'Text is required.');

      const tone = chooseTtsTone(text);
      const zhipuResponse = await fetchImpl(ZHIPU_TTS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: TTS_MODEL,
          input: text,
          voice: process.env.GLM_TTS_VOICE || 'female',
          response_format: 'wav',
          speed: tone.speed,
          volume: tone.volume
        })
      });

      if (!zhipuResponse.ok) {
        const data = await zhipuResponse.json().catch(() => ({}));
        return jsonError(response, zhipuResponse.status, data.error?.message || 'Zhipu TTS request failed.');
      }

      const audioBuffer = Buffer.from(await zhipuResponse.arrayBuffer());
      response.setHeader('Content-Type', zhipuResponse.headers.get('content-type') || 'audio/wav');
      response.setHeader('Cache-Control', 'no-store');
      response.send(audioBuffer);
    } catch (error) {
      next(error);
    }
  });

  app.use(express.static(staticDir));

  app.use((error, _request, response, _next) => {
    console.error(error);
    jsonError(response, 500, 'Server error.');
  });

  return app;
}

function startServer() {
  loadEnv();
  const port = Number(process.env.PORT || 3000);
  const app = createApp();
  app.listen(port, () => {
    console.log(`Warm chat AI is running at http://localhost:${port}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createApp,
  startServer,
  buildChatMessages,
  chooseTtsTone,
  createDefaultHistoryStore,
  loadEnv
};
