const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');

const { createHistoryStore } = require('./lib/historyStore');

const CHAT_MODEL = 'glm-4-plus';
const ASR_MODEL = 'glm-asr-2512';
const TTS_MODEL = 'glm-tts';
const ZHIPU_CHAT_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const ZHIPU_ASR_URL = 'https://open.bigmodel.cn/api/paas/v4/audio/transcriptions';
const ZHIPU_TTS_URL = 'https://open.bigmodel.cn/api/paas/v4/audio/speech';

const defaultClientId = 'default';

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
    {
      role: 'system',
      content: '你是一个温暖、智慧、充满同理心的倾听者，名字叫“微光”。你的目的不是解决问题，而是让对方感到被理解、被接纳。语言平实、亲切，会使用比喻。永远不评判对方。当用户表现出严重自伤倾向时，建议寻求专业心理帮助。保持回复简短（2到4句），偶尔问一个温柔的问题。'
    },
    ...history.map(({ role, content }) => ({ role, content })),
    { role: 'user', content: userMessage }
  ];
}

function chooseTtsTone(text) {
  const sadWords = ['难过', '崩溃', '痛苦', '害怕', '焦虑', '累', '哭', '孤独', '失眠', '撑不住'];
  const brightWords = ['开心', '太好了', '真好', '恭喜', '喜欢', '期待', '顺利'];
  const urgentWords = ['自杀', '自伤', '不想活', '结束生命', '伤害自己'];

  if (urgentWords.some((word) => text.includes(word))) {
    return { speed: 0.88, volume: 0.95 };
  }
  if (sadWords.some((word) => text.includes(word))) {
    return { speed: 0.92, volume: 0.9 };
  }
  if (brightWords.some((word) => text.includes(word))) {
    return { speed: 1.05, volume: 1 };
  }
  return { speed: 1, volume: 0.95 };
}

function getClientId(request) {
  const bodyClientId = request.body && typeof request.body.clientId === 'string' ? request.body.clientId : '';
  const queryClientId = request.query && typeof request.query.clientId === 'string' ? request.query.clientId : '';
  return bodyClientId || queryClientId || defaultClientId;
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
  historyStore = createHistoryStore({ filePath: path.join(__dirname, 'data', 'chat-history.json') }),
  apiKey = process.env.ZHIPU_API_KEY,
  fetchImpl = global.fetch,
  staticDir = __dirname
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

  app.get('/api/history', async (_request, response, next) => {
    try {
      response.json({ messages: await readHistory(historyStore, getClientId(_request)) });
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
      if (!apiKey) {
        return jsonError(response, 500, 'Missing ZHIPU_API_KEY in .env.');
      }
      const message = typeof request.body.message === 'string' ? request.body.message.trim() : '';
      if (!message) {
        return jsonError(response, 400, 'Message is required.');
      }

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
      if (!reply) {
        return jsonError(response, 502, 'Zhipu chat response did not include a reply.');
      }

      const savedReply = await appendHistory(historyStore, clientId, { role: 'assistant', content: reply });
      response.json({ reply, message: savedReply });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/asr', upload.single('audio'), async (request, response, next) => {
    try {
      if (!apiKey) {
        return jsonError(response, 500, 'Missing ZHIPU_API_KEY in .env.');
      }
      if (!request.file) {
        return jsonError(response, 400, 'Audio file is required.');
      }

      const form = new FormData();
      const blob = new Blob([request.file.buffer], { type: request.file.mimetype || 'audio/webm' });
      form.append('file', blob, request.file.originalname || 'recording.webm');
      form.append('model', ASR_MODEL);
      form.append('stream', 'false');

      const zhipuResponse = await fetchImpl(ZHIPU_ASR_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`
        },
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
      if (!apiKey) {
        return jsonError(response, 500, 'Missing ZHIPU_API_KEY in .env.');
      }

      const text = typeof request.body.text === 'string' ? request.body.text.trim() : '';
      if (!text) {
        return jsonError(response, 400, 'Text is required.');
      }

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

module.exports = { createApp, startServer, buildChatMessages, chooseTtsTone, loadEnv };
