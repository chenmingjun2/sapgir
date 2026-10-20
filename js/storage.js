/**
 * Storage layer. Uses chrome.storage.local inside the extension and falls
 * back to localStorage so the UI can also be previewed as a plain web page.
 */

const PREFIX = 'dsv2.';

const chromeStorage =
  typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local
    ? chrome.storage.local
    : (typeof window !== 'undefined' && window.__sapgirStorage) || null;

const chromeSession =
  typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session
    ? chrome.storage.session
    : null;

function localGetRaw(key) {
  const raw = localStorage.getItem(PREFIX + key);
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return undefined;
  }
}

function localSetRaw(key, value) {
  localStorage.setItem(PREFIX + key, JSON.stringify(value));
}

export async function getItem(key, fallback = undefined) {
  if (chromeStorage) {
    const obj = await chromeStorage.get(PREFIX + key);
    const value = obj[PREFIX + key];
    return value === undefined ? fallback : value;
  }
  const value = localGetRaw(key);
  return value === undefined ? fallback : value;
}

export async function setItem(key, value) {
  if (chromeStorage) {
    await chromeStorage.set({ [PREFIX + key]: value });
    return;
  }
  localSetRaw(key, value);
}

async function removeItem(key) {
  if (chromeStorage) {
    await chromeStorage.remove(PREFIX + key);
    return;
  }
  localStorage.removeItem(PREFIX + key);
}

export async function getSessionItem(key, fallback = undefined) {
  if (chromeSession) {
    const obj = await chromeSession.get(PREFIX + key);
    const value = obj[PREFIX + key];
    return value === undefined ? fallback : value;
  }
  const raw = sessionStorage.getItem(PREFIX + key);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

export async function removeSessionItem(key) {
  if (chromeSession) {
    await chromeSession.remove(PREFIX + key);
    return;
  }
  sessionStorage.removeItem(PREFIX + key);
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export const DEFAULT_SYSTEM_PROMPT = `你是 Sapgir，一个兼容 DeepSeek Anthropic Messages 端点的 AI 助手。请使用简体中文回答，除非用户使用其他语言或明确要求其他语言。

回答要求：
- 准确、清晰、有条理，适当使用 Markdown 排版（标题、列表、表格、代码块）。
- 代码必须放在带语言标注的代码块中。
- 不要编造事实、链接或数据；不确定时请直接说明，并建议用户核实。
- 联网搜索由服务端控制；涉及实时信息、新闻、价格、版本等问题时，可以调用服务端 web_search，而不是凭记忆回答。`;

/** Fields removed when the app switched to Anthropic-only. */
const LEGACY_SETTINGS_KEYS = [
  'settingsVersion',
  'webSearch',
  'autoSearch',
  'allowFetch',
  'searchBackend',
  'searchProvider',
  'searchKeys',
  'webFetchMode',
  'fallbackDeepSeek',
  'allowPrivateFetch',
  'autoTitle',
];

export const DEFAULT_SETTINGS = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  thinking: true,
  thinkingEffort: 'high',
  maxTokens: 8192,
  temperature: 1.0,
  searchCount: 5,
  foldThinking: true,
  theme: 'auto',
  fontSize: 16,
  sendOnEnter: true,
  includeUsage: true,
};

export async function loadSettings() {
  const saved = (await getItem('settings', {})) || {};
  const settings = { ...DEFAULT_SETTINGS, ...saved };
  for (const key of LEGACY_SETTINGS_KEYS) delete settings[key];

  if (typeof settings.maxTokens !== 'number' || Number.isNaN(settings.maxTokens)) {
    settings.maxTokens = DEFAULT_SETTINGS.maxTokens;
  }
  settings.maxTokens = Math.min(393216, Math.max(0, Math.round(settings.maxTokens)));
  if (!['auto', 'light', 'dark'].includes(settings.theme)) settings.theme = 'auto';
  settings.fontSize = Math.min(24, Math.max(12, Number(settings.fontSize) || 16));
  if (!settings.model || typeof settings.model !== 'string') settings.model = 'deepseek-flash';
  if (!settings.baseUrl || typeof settings.baseUrl !== 'string') {
    settings.baseUrl = DEFAULT_SETTINGS.baseUrl;
  }
  if (!settings.apiKey || typeof settings.apiKey !== 'string') settings.apiKey = '';
  if (typeof settings.systemPrompt !== 'string' || !settings.systemPrompt.trim()) {
    settings.systemPrompt = DEFAULT_SYSTEM_PROMPT;
  }
  // Migrate the old default personas to the Sapgir prompt.
  if (
    /^你是 (DeepSeek|BYOK Chat)[，,]/.test(settings.systemPrompt) ||
    /^你是 Sapgir，一个兼容 DeepSeek 端点/.test(settings.systemPrompt)
  ) {
    settings.systemPrompt = DEFAULT_SYSTEM_PROMPT;
  }
  if (!['low', 'high', 'max'].includes(settings.thinkingEffort)) {
    settings.thinkingEffort = 'high';
  }
  settings.searchCount = Math.min(8, Math.max(2, Number(settings.searchCount) || 5));
  settings.temperature = Math.min(2, Math.max(0, Number(settings.temperature)));
  if (!Number.isFinite(settings.temperature)) settings.temperature = 1;
  for (const key of ['thinking', 'foldThinking', 'includeUsage', 'sendOnEnter']) {
    settings[key] = settings[key] !== false && settings[key] !== 'false';
  }
  return settings;
}

export async function saveSettings(settings) {
  const clean = { ...DEFAULT_SETTINGS, ...settings };
  for (const key of LEGACY_SETTINGS_KEYS) delete clean[key];
  await setItem('settings', clean);
  return clean;
}

/* ------------------------------------------------------------------ */
/* Conversations                                                       */
/* ------------------------------------------------------------------ */

export async function loadIndex() {
  const index = await getItem('index', []);
  return Array.isArray(index) ? index : [];
}

export async function saveIndex(index) {
  await setItem('index', index);
}

export async function loadConversation(id) {
  if (!id) return null;
  return (await getItem(`conv.${id}`, null)) || null;
}

export async function saveConversation(convo) {
  await setItem(`conv.${convo.id}`, convo);
}

export async function deleteConversationData(id) {
  await removeItem(`conv.${id}`);
}

export async function loadUiState() {
  return (await getItem('ui', {})) || {};
}

export async function saveUiState(ui) {
  await setItem('ui', ui);
}

export async function exportAll() {
  const settings = await loadSettings();
  const index = await loadIndex();
  const conversations = [];
  for (const item of index) {
    const convo = await loadConversation(item.id);
    if (!convo) continue;
    convo.pinned = !!item.pinned;
    conversations.push(convo);
  }
  return {
    app: 'byok-chat',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: {
      ...settings,
      apiKey: '',
    },
    conversations,
  };
}

export async function importAll(data) {
  if (
    !data ||
    !['byok-chat', 'deepseek-chat-byok'].includes(data.app) ||
    !Array.isArray(data.conversations)
  ) {
    throw new Error('不是有效的备份文件');
  }
  const index = await loadIndex();
  const byId = new Map(index.map((it) => [it.id, it]));

  for (const convo of data.conversations) {
    if (!convo || !convo.id || !Array.isArray(convo.messages)) continue;
    await saveConversation(convo);
    byId.set(convo.id, {
      id: convo.id,
      title: convo.title || '未命名对话',
      createdAt: convo.createdAt || Date.now(),
      updatedAt: convo.updatedAt || Date.now(),
      messageCount: convo.messages.length,
      pinned: !!convo.pinned,
    });
  }
  await saveIndex([...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt));

  if (data.settings && typeof data.settings === 'object') {
    const current = await loadSettings();
    const merged = {
      ...current,
      ...data.settings,
      apiKey: current.apiKey,
    };
    await saveSettings(merged);
  }
}

export async function clearAllData() {
  if (chromeStorage) {
    const all = await chromeStorage.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(PREFIX));
    if (keys.length) await chromeStorage.remove(keys);
    return;
  }
  for (let i = localStorage.length - 1; i >= 0; i -= 1) {
    const key = localStorage.key(i);
    if (key && key.startsWith(PREFIX)) localStorage.removeItem(key);
  }
}

export async function storageStats() {
  const index = await loadIndex();
  let messages = 0;
  for (const item of index) {
    const convo = await loadConversation(item.id);
    if (convo) messages += convo.messages?.length || 0;
  }
  return { conversations: index.length, messages };
}
