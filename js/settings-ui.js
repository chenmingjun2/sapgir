/**
 * Settings form rendering, persistence and the two "test" actions.
 * The app injects its state/DOM and a few UI callbacks at startup.
 */

import { DEFAULT_SETTINGS, DEFAULT_SYSTEM_PROMPT, saveSettings } from './storage.js';
import { listModels, normalizeBase } from './api.js';
import { messagesSearch } from './anthropic.js';

let ctx = null;

export function initSettingsUi(context) {
  ctx = context;
}

function app() {
  if (!ctx) throw new Error('settings UI is not initialized');
  return ctx;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampFloat(value, min, max, fallback) {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitizeBaseUrl(value) {
  const base = normalizeBase(value);
  try {
    const url = new URL(base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return base;
  } catch (_) {
    return null;
  }
}

export function populateSettingsForm() {
  const { state, dom } = app();
  const s = state.settings;
  dom.setApiKey.value = s.apiKey || '';
  dom.setApiKey.type = 'password';
  dom.toggleKey.textContent = '显示';
  state.keyVisible = false;
  dom.setBaseUrl.value = s.baseUrl || DEFAULT_SETTINGS.baseUrl;
  dom.setModel.value = s.model || DEFAULT_SETTINGS.model;
  dom.setEffort.value = s.thinkingEffort || 'high';
  dom.setMaxTokens.value = String(s.maxTokens ?? DEFAULT_SETTINGS.maxTokens);
  dom.setSystemPrompt.value = s.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  dom.setThinking.checked = !!s.thinking;
  dom.setFoldThinking.checked = s.foldThinking !== false;
  dom.setIncludeUsage.checked = s.includeUsage !== false;
  dom.setSendOnEnter.checked = s.sendOnEnter !== false;
  dom.setSearchCount.value = String(s.searchCount ?? 5);
  dom.setTemperature.value = String(s.temperature ?? 1);
  dom.setTheme.value = s.theme || 'auto';
  dom.setFontSize.value = String(s.fontSize || 16);
  dom.testResult.textContent = '';
  dom.testResult.className = 'test-result';
  dom.testSearchResult.textContent = '';
  dom.testSearchResult.className = 'test-result';
}

export async function saveSettingsFromForm() {
  const {
    state,
    dom,
    toast,
    applyTheme,
    applyFontSize,
    updateModelUI,
    updateApiNotice,
    updateToggles,
    setStreamingUI,
    updateScrollBottomPosition,
    updateScrollState,
  } = app();
  const next = { ...state.settings };
  const baseUrl = sanitizeBaseUrl(dom.setBaseUrl.value);
  if (!baseUrl) {
    toast('Base URL 无效，请填写 http(s) 地址');
    dom.setBaseUrl.focus();
    return;
  }
  next.apiKey = dom.setApiKey.value.trim();
  next.baseUrl = baseUrl;
  next.model = dom.setModel.value.trim() || DEFAULT_SETTINGS.model;
  next.thinkingEffort = dom.setEffort.value;
  next.maxTokens = clampInt(dom.setMaxTokens.value, 0, 393216, DEFAULT_SETTINGS.maxTokens);
  next.systemPrompt = dom.setSystemPrompt.value.trim() || DEFAULT_SYSTEM_PROMPT;
  next.thinking = dom.setThinking.checked;
  next.foldThinking = dom.setFoldThinking.checked;
  next.includeUsage = dom.setIncludeUsage.checked;
  next.sendOnEnter = dom.setSendOnEnter.checked;
  next.searchCount = clampInt(dom.setSearchCount.value, 2, 8, 5);
  next.temperature = clampFloat(dom.setTemperature.value, 0, 2, 1);
  next.theme = dom.setTheme.value;
  next.fontSize = Number(dom.setFontSize.value) || 16;

  try {
    state.settings = await saveSettings(next);
  } catch (err) {
    toast(`保存设置失败：${err.message}`);
    return;
  }
  if (!state.convo) {
    state.thinkingOn = state.settings.thinking;
  }

  applyTheme();
  applyFontSize();
  updateModelUI();
  updateApiNotice();
  updateToggles();
  setStreamingUI(!!state.streaming);
  dom.settingsDialog.close();
  setTimeout(() => {
    updateScrollBottomPosition();
    updateScrollState();
  }, 80);
  toast('设置已保存');
}

async function runSettingsTest(button, resultEl, loadingText, task) {
  button.disabled = true;
  resultEl.textContent = loadingText;
  resultEl.className = 'test-result';
  try {
    resultEl.textContent = await task();
    resultEl.className = 'test-result ok';
  } catch (err) {
    resultEl.textContent = err.message;
    resultEl.className = 'test-result err';
  } finally {
    button.disabled = false;
  }
}

export async function testConnection() {
  const { state, dom } = app();
  const baseUrl = sanitizeBaseUrl(dom.setBaseUrl.value);
  const apiKey = dom.setApiKey.value.trim();
  if (!baseUrl) {
    dom.testResult.textContent = 'Base URL 无效，请填写 http(s) 地址';
    dom.testResult.className = 'test-result err';
    return;
  }
  if (!apiKey) {
    dom.testResult.textContent = '请先填写 API Key';
    dom.testResult.className = 'test-result err';
    return;
  }

  await runSettingsTest(dom.testConnection, dom.testResult, '正在连接…', async () => {
    const models = await listModels({ baseUrl, apiKey });
    state.modelList = models;
    if (models.length) {
      dom.modelPresets.innerHTML = '';
      for (const id of models) {
        const option = document.createElement('option');
        option.value = id;
        dom.modelPresets.appendChild(option);
      }
    }
    const chosen = dom.setModel.value.trim();
    const hasChosen = models.length === 0 || models.includes(chosen);
    return models.length
      ? `连接成功，可用模型：${models.slice(0, 6).join('、')}${models.length > 6 ? '…' : ''}${hasChosen ? '' : '（当前模型不在列表中）'}`
      : '连接成功，但 /models 没有返回模型列表。';
  });
}

export async function testWebSearch() {
  const { state, dom } = app();
  const baseUrl = sanitizeBaseUrl(dom.setBaseUrl.value) || state.settings.baseUrl;
  const apiKey = dom.setApiKey.value.trim();
  const model = dom.setModel.value.trim() || state.settings.model;

  await runSettingsTest(dom.testSearch, dom.testSearchResult, '正在搜索…', async () => {
    const out = await messagesSearch({
      baseUrl,
      apiKey,
      model,
      query: 'DeepSeek 最新公告',
      count: 3,
    });
    return `服务端搜索 · ${out.sources.length} 个来源 · ${
      out.sources[0]?.title || '无结果'
    }`;
  });
}
