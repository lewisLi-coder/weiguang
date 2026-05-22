# Chat Backend History ASR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a simple local backend that hides the Zhipu API key, proxies chat and GLM-ASR-2512 requests, and persists chat history for later visits.

**Architecture:** Use Express to serve the existing `index.html` and expose `/api/chat`, `/api/asr`, `/api/history`, and `/api/config-status`. Store history in `data/chat-history.json` through a small storage module. Keep front-end state synchronized by loading history on startup and saving server-side after each assistant reply.

**Tech Stack:** Node.js, Express, Multer, native `fetch`, Node test runner, plain HTML/CSS/JavaScript.

---

### Task 1: History Store

**Files:**
- Create: `lib/historyStore.js`
- Create: `test/historyStore.test.js`
- Modify: `package.json`

- [ ] Add tests for default history, append, replace, and malformed JSON recovery.
- [ ] Run `npm test -- --test-name-pattern historyStore` and verify tests fail because the store does not exist.
- [ ] Implement `createHistoryStore({ filePath })` with `read`, `replace`, and `append`.
- [ ] Run the same test and verify it passes.

### Task 2: Backend API

**Files:**
- Create: `server.js`
- Create: `test/server.test.js`
- Modify: `package.json`
- Create: `.env.example`
- Create: `data/.gitkeep`

- [ ] Add tests for `/api/history`, `/api/chat` missing API key behavior, `/api/chat` success through injected fetch, and `/api/asr` missing API key behavior.
- [ ] Run `npm test -- --test-name-pattern server` and verify tests fail because the server module does not exist.
- [ ] Implement `createApp` and `startServer` in `server.js`.
- [ ] Run the server tests and verify they pass.

### Task 3: Frontend Integration

**Files:**
- Modify: `index.html`

- [ ] Remove the hard-coded API key and direct Zhipu chat request.
- [ ] Load `/api/history` on startup and render stored messages.
- [ ] Send chat messages to `/api/chat`.
- [ ] Add a microphone button that records audio and posts to `/api/asr`.
- [ ] Fill the input with recognized text so the user can review before sending.

### Task 4: Verification

**Files:**
- No new files.

- [ ] Run `npm test`.
- [ ] Run `node --check server.js`.
- [ ] Run `node --check` against generated JavaScript is not needed because front-end code is embedded in HTML.
- [ ] Start the local server with `npm start` and report the URL.
