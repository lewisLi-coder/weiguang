const CHAT_MODEL = 'glm-4-plus';
const ZHIPU_CHAT_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const DEFAULT_CLIENT_ID = 'default';

const ZH_SYSTEM_PROMPT = '\u4f60\u662f\u4e00\u4e2a\u6e29\u6696\u3001\u667a\u6167\u3001\u5145\u6ee1\u540c\u7406\u5fc3\u7684\u503e\u542c\u8005\uff0c\u540d\u5b57\u53eb\u201c\u5fae\u5149\u201d\u3002\u4f60\u7684\u76ee\u7684\u4e0d\u662f\u89e3\u51b3\u95ee\u9898\uff0c\u800c\u662f\u8ba9\u5bf9\u65b9\u611f\u5230\u88ab\u7406\u89e3\u3001\u88ab\u63a5\u7eb3\u3002\u8bed\u8a00\u5e73\u5b9e\u3001\u4eb2\u5207\uff0c\u6c38\u8fdc\u4e0d\u8bc4\u5224\u5bf9\u65b9\u3002\u4fdd\u6301\u56de\u590d\u7b80\u77ed\uff082\u52304\u53e5\uff09\uff0c\u5076\u5c14\u95ee\u4e00\u4e2a\u6e29\u67d4\u7684\u95ee\u9898\u3002\u59cb\u7ec8\u7528\u4e2d\u6587\u56de\u590d\u3002';
const EN_SYSTEM_PROMPT = 'You are Weiguang, a warm, wise, deeply empathetic listener. Your goal is not to solve everything, but to help the person feel understood and accepted. Use plain, kind language, never judge, and keep replies short, usually 2 to 4 sentences. Always reply in English.';

const allowedRoles = new Set(['user', 'assistant']);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

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

function sanitizeClientId(clientId) {
  const value = typeof clientId === 'string' ? clientId.trim() : '';
  if (!value) return DEFAULT_CLIENT_ID;
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || DEFAULT_CLIENT_ID;
}

function historyKey(clientId) {
  return `chat:history:${sanitizeClientId(clientId)}`;
}

function getCountry(request) {
  return String(
    request.headers.get('eo-client-ipcountry') ||
    request.headers.get('x-vercel-ip-country') ||
    request.headers.get('cf-ipcountry') ||
    ''
  ).toUpperCase();
}

function getLocale(request, body = {}) {
  const url = new URL(request.url);
  const explicitLocale = url.searchParams.get('locale') || body.locale;
  if (explicitLocale === 'zh' || explicitLocale === 'en') return explicitLocale;
  const country = getCountry(request);
  return !country || country === 'CN' ? 'zh' : 'en';
}

function getClientId(request, body = {}) {
  const url = new URL(request.url);
  return body.clientId || url.searchParams.get('clientId') || DEFAULT_CLIENT_ID;
}

function getKv(env) {
  return env?.WEIGUANG_KV || env?.KV || globalThis.WEIGUANG_KV || globalThis.KV;
}

async function readHistory(kv, clientId) {
  const raw = await kv.get(historyKey(clientId));
  if (!raw) return [];
  try {
    return normalizeMessages(JSON.parse(raw));
  } catch (_error) {
    return [];
  }
}

async function writeHistory(kv, clientId, messages) {
  const normalized = normalizeMessages(messages);
  await kv.put(historyKey(clientId), JSON.stringify(normalized));
  return normalized;
}

function buildChatMessages(history, userMessage, locale) {
  return [
    { role: 'system', content: locale === 'en' ? EN_SYSTEM_PROMPT : ZH_SYSTEM_PROMPT },
    ...history.map(({ role, content }) => ({ role, content })),
    { role: 'user', content: userMessage }
  ];
}

async function handleChat(request, env) {
  const kv = getKv(env);
  if (!kv) return json({ error: 'Missing EdgeOne KV binding WEIGUANG_KV.' }, 500);
  if (!env?.ZHIPU_API_KEY) return json({ error: 'Missing ZHIPU_API_KEY.' }, 500);

  const body = await request.json().catch(() => ({}));
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return json({ error: 'Message is required.' }, 400);

  const clientId = getClientId(request, body);
  const locale = getLocale(request, body);
  const history = await readHistory(kv, clientId);
  await writeHistory(kv, clientId, [...history, { role: 'user', content: message }]);

  const zhipuResponse = await fetch(ZHIPU_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.ZHIPU_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: buildChatMessages(history, message, locale),
      temperature: 0.9,
      max_tokens: 1024
    })
  });

  const data = await zhipuResponse.json();
  if (!zhipuResponse.ok) {
    return json({ error: data.error?.message || 'Zhipu chat request failed.' }, zhipuResponse.status);
  }

  const reply = data.choices?.[0]?.message?.content;
  if (!reply) return json({ error: 'Zhipu chat response did not include a reply.' }, 502);

  const saved = await writeHistory(kv, clientId, [
    ...history,
    { role: 'user', content: message },
    { role: 'assistant', content: reply }
  ]);
  return json({ reply, message: saved.at(-1) });
}

async function handleHistory(request, env) {
  const kv = getKv(env);
  if (!kv) return json({ error: 'Missing EdgeOne KV binding WEIGUANG_KV.' }, 500);
  const clientId = getClientId(request);
  return json({ messages: await readHistory(kv, clientId) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/debug') {
      return json({
        hasApiKey: Boolean(env?.ZHIPU_API_KEY),
        hasKv: Boolean(getKv(env)),
        historyStore: getKv(env) ? 'edgeone-kv' : 'missing',
        runtime: 'edge-functions'
      });
    }

    if (url.pathname === '/api/debug/kv') {
      const kv = getKv(env);
      if (!kv) return json({ error: 'Missing EdgeOne KV binding WEIGUANG_KV.' }, 500);
      const clientId = `debug-${Date.now()}`;
      await writeHistory(kv, clientId, [{ role: 'user', content: 'kv-write-test' }]);
      const messages = await readHistory(kv, clientId);
      return json({ ok: messages.some((message) => message.content === 'kv-write-test'), count: messages.length });
    }

    if (url.pathname === '/api/locale') {
      return json({ locale: getLocale(request) });
    }

    if (url.pathname === '/api/history' && request.method === 'GET') {
      return handleHistory(request, env);
    }

    if (url.pathname === '/api/chat' && request.method === 'POST') {
      return handleChat(request, env);
    }

    return json({ error: 'Not found.' }, 404);
  }
};
