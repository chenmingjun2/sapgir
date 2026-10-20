/**
 * Sapgir
 * A self-contained AI chat UI compatible with DeepSeek endpoints.
 */

import {
  loadSettings,
  saveSettings,
  DEFAULT_SETTINGS,
  DEFAULT_SYSTEM_PROMPT,
  loadIndex,
  saveIndex,
  loadConversation,
  saveConversation,
  deleteConversationData,
  loadUiState,
  saveUiState,
  getSessionItem,
  removeSessionItem,
  exportAll,
  importAll,
  clearAllData,
  storageStats,
} from './storage.js';

import {
  streamChat,
  listModels,
  executeTool,
  buildApiMessages,
  buildSessionSystemMessage,
  buildToolDefinitions,
  parseRawToolCalls,
  normalizeBase,
} from './api.js';

import { renderMarkdown, copyText } from './markdown.js';
import { messagesSearch, providerLabel } from './websearch.js';
import { buildAnthropicMessages, streamAnthropicTurn } from './anthropic.js';
import { icon, brandMark } from './icons.js';

/* ------------------------------------------------------------------ */
/* Constants & state                                                  */
/* ------------------------------------------------------------------ */

const MAX_ATTACHMENTS = 6;
const MAX_IMAGE_DIM = 1600;
const MAX_TEXT_CHARS = 150000;
const TOOL_LOOP_LIMIT = 6;
// Reuse a keyword-triggered search for regenerations within this window instead
// of paying for the same query again.
const AUTO_SEARCH_TTL = 10 * 60 * 1000;

const TEXT_EXTENSIONS = [
  'txt', 'md', 'markdown', 'csv', 'json', 'log', 'yaml', 'yml', 'xml', 'html',
  'css', 'js', 'ts', 'jsx', 'tsx', 'py', 'go', 'java', 'c', 'cpp', 'h', 'rs',
  'sql', 'sh', 'toml', 'ini', 'env', 'gitignore',
];

const state = {
  settings: null,
  index: [],
  convo: null,
  ui: {},
  attachments: [],
  streaming: null,
  thinkingOn: true,
  webOn: false,
  searchTerm: '',
  menuEl: null,
  collapsed: false,
  mobileOpen: false,
  stick: true,
  renameTarget: null,
  modelList: [],
  dragDepth: 0,
  keyVisible: false,
};

const dom = {};

/* ------------------------------------------------------------------ */
/* Tiny helpers                                                       */
/* ------------------------------------------------------------------ */

function $(id) {
  return document.getElementById(id);
}

function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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

function formatNumber(n) {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

function formatUsage(usage) {
  if (!usage) return '';
  const input = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  const hit =
    Number(usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens) || 0;
  const miss =
    Number(usage.prompt_cache_miss_tokens ?? Math.max(0, input - hit)) || 0;
  if (!input && !output && !hit) return '';

  const parts = [];
  if (hit > 0) {
    const denominator = hit + miss || input || 1;
    parts.push(`缓存 ${Math.round((hit / denominator) * 100)}%`);
  }
  parts.push(`↑${formatNumber(input)} ↓${formatNumber(output)}`);
  return parts.join(' · ');
}

function usageTitle(usage) {
  if (!usage) return '';
  const input = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  const total = usage.total_tokens ?? input + output;
  const hit =
    Number(usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens) || 0;
  const miss =
    Number(usage.prompt_cache_miss_tokens ?? Math.max(0, input - hit)) || 0;
  const cache =
    hit || miss
      ? ` · 缓存命中 ${hit} tokens / 未命中 ${miss} tokens`
      : '';
  return `输入 ${input} tokens · 输出 ${output} tokens · 共 ${total} tokens${cache}`;
}

function fileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function messageWantsSearch(text, convo = null) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (/(不要|不用|别|无需|关闭|不)\s*(搜索|搜|联网|查)/.test(value)) return false;

  const messages = Array.isArray(convo?.messages) ? convo.messages : [];
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const deictic = /(这个|这些|上面|上述|刚才|前面|该来源|这篇|这份)/.test(value);
  const strongFresh =
    /(搜索|搜一下|搜下|查一下|查查|查资料|帮我查|联网|上网查|网上查|最新|实时|新闻|公告|发布|上线|更新|版本|价格|多少钱|费率|政策|法规|天气|气温|空气质量|股价|汇率|比分|赛程|获奖|诺贝尔|今天|今日|现在|当前|最近|今年|2026|抓取|网页抓取|打开网页|访问网页|fetch)/i.test(
      value
    );

  // A follow-up such as "这个来源可靠吗" should use the sources already in
  // context, not trigger another search.
  if (deictic && lastAssistant?.sources?.length && !strongFresh) return false;

  // Freshness / explicit-search intent. This is intentionally conservative:
  // normal coding, translation and follow-up questions stay offline.
  const wantsFresh =
    strongFresh ||
    /(官网|来源|引用|链接|https?:\/\/)/i.test(value);
  if (wantsFresh) return true;

  // Clearly local/static tasks: do not offer web tools.
  if (
    /(代码|编程|函数|实现|算法|bug|报错|异常|重构|单元测试|正则|SQL|翻译|润色|改写|写一篇|写个|故事|诗|数学|证明|公式|推导)/i.test(
      value
    ) ||
    /```/.test(value)
  ) {
    return false;
  }

  // Short follow-ups should use the existing conversation context; only a
  // new freshness word (handled above) should trigger another search.
  if (
    /^(继续|接着|然后呢|展开|详细(点|些)?|总结|概括|为什么|举个例子|还有呢|就这|再说说|解释一下|什么意思|怎么看|如何理解)[？?。！!\s]*$/i.test(
      value
    )
  ) {
    return false;
  }

  // Ambiguous general questions default to no search; the user can force it
  // with the composer toggle or by asking explicitly.
  return false;
}

function cleanSearchText(value) {
  return String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<file[\s\S]*?<\/file>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build a useful one-shot query for keyword-triggered auto search. Short
 * follow-ups such as "那最新价格呢" get the previous question prepended so the
 * search engine has enough context.
 */
function autoSearchQuery(text, convo = null) {
  const current = cleanSearchText(text);
  if (!current) return '';

  if (current.length >= 60) return current.slice(0, 128);

  const messages = Array.isArray(convo?.messages) ? convo.messages : [];
  const previous = [...messages]
    .reverse()
    .find(
      (msg) =>
        msg.role === 'user' &&
        msg.content &&
        cleanSearchText(msg.content) !== current
    );

  if (
    previous &&
    /(这个|那个|它|其|那|还|再|最新|现在|目前|价格|多少钱|怎么样)/.test(current)
  ) {
    return `${cleanSearchText(previous.content).slice(0, 70)} ${current}`.slice(0, 128);
  }

  return current.slice(0, 128);
}

function makeTitle(text, hasImages = false) {
  const cleaned = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<file[\s\S]*?<\/file>/g, ' ')
    .replace(/[#>*_`~[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return hasImages ? '图片对话' : '新对话';
  return cleaned.length > 32 ? `${cleaned.slice(0, 32)}…` : cleaned;
}

function safeHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || '')) ? String(url) : '';
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

function setToggle(el, on) {
  if (!el) return;
  el.classList.toggle('active', !!on);
  el.setAttribute('aria-pressed', String(!!on));
}

function toast(message, ms = 2400) {
  dom.toast.textContent = message;
  dom.toast.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => dom.toast.classList.add('hidden'), ms);
}

function download(filename, content, mime = 'text/markdown;charset=utf-8') {
  // Android WebView has no <a download> support; hand the file to MediaStore.
  if (window.SapgirAndroid?.saveFile) {
    try {
      window.SapgirAndroid.saveFile(filename, mime, String(content));
      return;
    } catch (_) {
      // Fall through to the browser path.
    }
  }

  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function groupLabel(timestamp) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (timestamp >= startOfToday) return '今天';
  if (timestamp >= startOfToday - 86400000) return '昨天';
  if (timestamp >= startOfToday - 7 * 86400000) return '7 天内';
  if (timestamp >= startOfToday - 30 * 86400000) return '30 天内';
  return '更早';
}

/* ------------------------------------------------------------------ */
/* DOM bootstrap                                                      */
/* ------------------------------------------------------------------ */

function cacheDom() {
  dom.app = $('app');
  dom.sidebar = $('sidebar');
  dom.sidebarBackdrop = $('sidebar-backdrop');
  dom.collapseBtn = $('collapse-btn');
  dom.sidebarToggle = $('sidebar-toggle');
  dom.brandLink = $('brand-link');
  dom.newChatBtn = $('new-chat-btn');
  dom.searchBtn = $('search-btn');
  dom.searchBox = $('sidebar-search');
  dom.conversationSearch = $('conversation-search');
  dom.searchClose = $('search-close');
  dom.conversationList = $('conversation-list');
  dom.accountBtn = $('account-btn');
  dom.accountSub = $('account-sub');

  dom.modelBtn = $('model-btn');
  dom.modelName = $('model-name');
  dom.modelMenu = $('model-menu');
  dom.themeToggle = $('theme-toggle');
  dom.settingsBtn = $('settings-btn');

  dom.chatScroll = $('chat-scroll');
  dom.chatInner = $('chat-inner');
  dom.welcome = $('welcome');
  dom.apiNotice = $('api-notice');
  dom.noticeSettings = $('notice-settings');
  dom.suggestions = $('suggestions');
  dom.messages = $('messages');
  dom.scrollBottom = $('scroll-bottom');

  dom.composerArea = $('composer-area');
  dom.composerShell = $('composer-shell');
  dom.composer = $('composer');
  dom.attachments = $('attachments');
  dom.fileInput = $('file-input');
  dom.thinkingToggle = $('thinking-toggle');
  dom.searchToggle = $('search-toggle');
  dom.sendHint = $('send-hint');
  dom.sendBtn = $('send-btn');

  dom.toast = $('toast');
  dom.dropOverlay = $('drop-overlay');
  dom.lightbox = $('lightbox');
  dom.lightboxImg = $('lightbox-img');
  dom.lightboxClose = $('lightbox-close');

  dom.settingsDialog = $('settings-dialog');
  dom.settingsNav = $('settings-nav');
  dom.settingsClose = $('settings-close');
  dom.settingsCancel = $('settings-cancel');
  dom.settingsSave = $('settings-save');

  dom.setApiKey = $('set-api-key');
  dom.toggleKey = $('toggle-key');
  dom.setBaseUrl = $('set-base-url');
  dom.setModel = $('set-model');
  dom.modelPresets = $('model-presets');
  dom.setEffort = $('set-effort');
  dom.setMaxTokens = $('set-max-tokens');
  dom.setSystemPrompt = $('set-system-prompt');
  dom.resetPrompt = $('reset-prompt');
  dom.testConnection = $('test-connection');
  dom.testResult = $('test-result');

  dom.setThinking = $('set-thinking');
  dom.setWebSearch = $('set-web-search');
  dom.setAllowFetch = $('set-allow-fetch');
  dom.setFoldThinking = $('set-fold-thinking');
  dom.setIncludeUsage = $('set-include-usage');
  dom.setSendOnEnter = $('set-send-on-enter');
  dom.setSearchCount = $('set-search-count');
  dom.setTemperature = $('set-temperature');
  dom.setTheme = $('set-theme');
  dom.setFontSize = $('set-font-size');

  dom.setAnthropicSearch = $('set-anthropic-search');
  dom.setAutoSearch = $('set-auto-search');
  dom.setFetchMode = $('set-fetch-mode');
  dom.setFallbackDeepSeek = $('set-fallback-deepseek');
  dom.setAllowPrivateFetch = $('set-allow-private-fetch');
  dom.testSearch = $('test-search');
  dom.testSearchResult = $('test-search-result');

  dom.statConversations = $('stat-conversations');
  dom.statMessages = $('stat-messages');
  dom.exportData = $('export-data');
  dom.importData = $('import-data');
  dom.importFile = $('import-file');
  dom.clearData = $('clear-data');

  dom.renameDialog = $('rename-dialog');
  dom.renameInput = $('rename-input');
  dom.renameCancel = $('rename-cancel');
  dom.renameSave = $('rename-save');

  dom.confirmDialog = $('confirm-dialog');
  dom.confirmTitle = $('confirm-title');
  dom.confirmMessage = $('confirm-message');
  dom.confirmCancel = $('confirm-cancel');
  dom.confirmOk = $('confirm-ok');
}

function hydrateIcons() {
  document.querySelectorAll('[data-icon]').forEach((el) => {
    const size = Number(el.dataset.size) || 16;
    el.innerHTML = icon(el.dataset.icon, size);
  });
}

/* ------------------------------------------------------------------ */
/* Theme                                                              */
/* ------------------------------------------------------------------ */

function systemTheme() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function resolvedTheme(theme = state.settings?.theme || 'light') {
  return theme === 'auto' ? systemTheme() : theme;
}

function applyTheme(previewTheme) {
  const theme = resolvedTheme(previewTheme);
  document.documentElement.dataset.theme = theme;
  if (dom.themeToggle) {
    dom.themeToggle.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
    dom.themeToggle.title = theme === 'dark' ? '切换到浅色主题' : '切换到深色主题';
  }
}

function applyFontSize() {
  const size = Number(state.settings?.fontSize) || 16;
  document.documentElement.style.setProperty('--font-size', `${size}px`);
}

async function toggleTheme() {
  const next = resolvedTheme() === 'dark' ? 'light' : 'dark';
  state.settings.theme = next;
  applyTheme();
  try {
    await saveSettings(state.settings);
  } catch (err) {
    toast(`保存主题失败：${err.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* Sidebar                                                            */
/* ------------------------------------------------------------------ */

function applySidebarState() {
  if (window.innerWidth <= 900) {
    dom.app.classList.toggle('sidebar-open', state.mobileOpen);
    dom.app.classList.remove('sidebar-collapsed');
    return;
  }
  dom.app.classList.remove('sidebar-open');
  dom.app.classList.toggle('sidebar-collapsed', state.collapsed);
}

async function setSidebarCollapsed(collapsed) {
  state.collapsed = collapsed;
  applySidebarState();
  state.ui.sidebarCollapsed = collapsed;
  await saveUiState(state.ui);
  setTimeout(() => {
    updateScrollBottomPosition();
    updateScrollState();
  }, 260);
}

function closeMobileSidebar() {
  if (!state.mobileOpen) return;
  state.mobileOpen = false;
  applySidebarState();
}

function toggleSidebar() {
  if (window.innerWidth <= 900) {
    state.mobileOpen = !state.mobileOpen;
    applySidebarState();
    return;
  }
  setSidebarCollapsed(!state.collapsed);
}

function renderSidebar() {
  const term = state.searchTerm.trim().toLowerCase();
  let items = state.index.slice();
  if (term) {
    items = items.filter((item) => String(item.title || '').toLowerCase().includes(term));
  }
  items.sort((a, b) => {
    const pinned = Number(!!b.pinned) - Number(!!a.pinned);
    if (pinned) return pinned;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });

  const previousScroll = dom.conversationList.scrollTop;
  dom.conversationList.innerHTML = '';

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'conv-empty';
    empty.textContent = term ? '没有匹配的对话' : '还没有对话，点击「新对话」开始';
    dom.conversationList.appendChild(empty);
    dom.conversationList.scrollTop = previousScroll;
    return;
  }

  let currentGroup = '';
  for (const item of items) {
    const label = term ? '搜索结果' : item.pinned ? '置顶' : groupLabel(item.updatedAt || item.createdAt || 0);
    if (label !== currentGroup) {
      const groupEl = document.createElement('div');
      groupEl.className = 'conv-group-label';
      groupEl.textContent = label;
      dom.conversationList.appendChild(groupEl);
      currentGroup = label;
    }

    const row = document.createElement('div');
    row.className = 'conv-item';
    if (state.convo?.id === item.id) row.classList.add('active');
    row.dataset.id = item.id;
    row.setAttribute('role', 'button');
    row.tabIndex = 0;

    const title = document.createElement('span');
    title.className = 'conv-title';
    title.textContent = item.title || '未命名对话';
    title.title = item.title || '';

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'conv-more';
    more.setAttribute('aria-label', '对话操作');
    more.innerHTML = icon('more', 16);

    row.append(title, more);
    dom.conversationList.appendChild(row);
  }
  dom.conversationList.scrollTop = previousScroll;
}

function closeConversationMenu() {
  if (!state.menuEl) return;
  state.menuEl.remove();
  state.menuEl = null;
  document.querySelectorAll('.conv-item.menu-open').forEach((el) => el.classList.remove('menu-open'));
}

function openConversationMenu(id, anchor) {
  closeConversationMenu();
  const item = state.index.find((it) => it.id === id);
  if (!item) return;

  const row = anchor.closest('.conv-item');
  row?.classList.add('menu-open');

  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.style.position = 'fixed';
  menu.style.zIndex = '500';

  const actions = [
    { act: 'rename', label: '重命名', iconName: 'edit' },
    { act: 'pin', label: item.pinned ? '取消置顶' : '置顶对话', iconName: 'pin' },
    { act: 'export', label: '导出 Markdown', iconName: 'download' },
    { sep: true },
    { act: 'delete', label: '删除对话', iconName: 'trash', danger: true },
  ];

  for (const action of actions) {
    if (action.sep) {
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = action.danger ? 'danger' : '';
    btn.innerHTML = `${icon(action.iconName, 14)}<span>${action.label}</span>`;
    btn.addEventListener('click', () => {
      closeConversationMenu();
      if (action.act === 'rename') openRenameDialog(id);
      if (action.act === 'pin') togglePin(id);
      if (action.act === 'export') exportConversation(id);
      if (action.act === 'delete') deleteConversation(id);
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let left = rect.right - menuRect.width;
  let top = rect.bottom + 4;
  if (top + menuRect.height > window.innerHeight - 8) {
    top = rect.top - menuRect.height - 4;
  }
  left = Math.max(8, Math.min(left, window.innerWidth - menuRect.width - 8));
  top = Math.max(8, top);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  state.menuEl = menu;
}

async function togglePin(id) {
  const item = state.index.find((it) => it.id === id);
  if (!item) return;
  item.pinned = !item.pinned;
  await saveIndex(state.index);
  renderSidebar();
  toast(item.pinned ? '已置顶' : '已取消置顶');
}

function openRenameDialog(id) {
  const item = state.index.find((it) => it.id === id);
  if (!item) return;
  state.renameTarget = id;
  dom.renameInput.value = item.title || '';
  dom.renameDialog.returnValue = '';
  dom.renameDialog.showModal();
  setTimeout(() => {
    dom.renameInput.focus();
    dom.renameInput.select();
  }, 30);
}

async function saveRename() {
  const id = state.renameTarget;
  if (!id) return;
  const title = dom.renameInput.value.trim() || '未命名对话';
  const item = state.index.find((it) => it.id === id);
  if (item) item.title = title;
  await saveIndex(state.index);
  const convo = await loadConversation(id);
  if (convo) {
    convo.title = title;
    await saveConversation(convo);
  }
  if (state.convo?.id === id) {
    state.convo.title = title;
    updateDocumentTitle();
  }
  dom.renameDialog.close();
  state.renameTarget = null;
  renderSidebar();
  toast('已重命名');
}

async function deleteConversation(id) {
  const item = state.index.find((it) => it.id === id);
  if (!item) return;
  if (state.streaming?.convo?.id === id) {
    toast('正在生成回答，请先停止后再删除');
    return;
  }
  const ok = await confirmDialog({
    title: '删除对话',
    message: `确定删除「${item.title || '未命名对话'}」吗？此操作无法撤销。`,
    okText: '删除',
  });
  if (!ok) return;

  state.index = state.index.filter((it) => it.id !== id);
  await saveIndex(state.index);
  await deleteConversationData(id);

  if (state.convo?.id === id) {
    state.convo = null;
    updateDocumentTitle();
    dom.messages.innerHTML = '';
    dom.welcome.classList.remove('hidden');
    dom.scrollBottom.classList.add('hidden');
    state.stick = true;
    updateApiNotice();
    state.ui.activeId = null;
    await saveUiState(state.ui);
  }
  renderSidebar();
  toast('对话已删除');
}

/* ------------------------------------------------------------------ */
/* Conversation state                                                 */
/* ------------------------------------------------------------------ */

function setActiveConversation(id) {
  state.ui.activeId = id || null;
  saveUiState(state.ui).catch(() => {});
}

function updateDocumentTitle() {
  document.title = state.convo?.title ? `${state.convo.title} · Sapgir` : 'Sapgir';
}

async function openConversation(id) {
  if (!id) return;
  if (state.streaming) stopStreaming();
  const convo = await loadConversation(id);
  if (!convo) {
    toast('对话不存在或已被删除');
    state.index = state.index.filter((it) => it.id !== id);
    await saveIndex(state.index);
    renderSidebar();
    return;
  }
  closeConversationMenu();
  state.convo = convo;
  state.thinkingOn = convo.thinking ?? state.settings.thinking;
  state.webOn = convo.webSearch ?? state.settings.webSearch;
  updateToggles();
  updateDocumentTitle();
  state.searchTerm = '';
  dom.conversationSearch.value = '';
  dom.searchBox.classList.add('hidden');
  setActiveConversation(id);
  renderMessages();
  renderSidebar();
  closeMobileSidebar();
  dom.welcome.classList.add('hidden');
  updateApiNotice();
  requestAnimationFrame(() => scrollToBottom(true, true));
}

function newChat({ focus = true } = {}) {
  if (state.streaming) stopStreaming();
  closeConversationMenu();
  state.convo = null;
  updateDocumentTitle();
  state.attachments = [];
  state.thinkingOn = state.settings.thinking;
  state.webOn = state.settings.webSearch;
  updateToggles();
  renderAttachments();
  dom.composer.value = '';
  autosize();
  dom.messages.innerHTML = '';
  dom.welcome.classList.remove('hidden');
  setActiveConversation(null);
  renderSidebar();
  updateApiNotice();
  dom.searchBox.classList.add('hidden');
  state.searchTerm = '';
  dom.conversationSearch.value = '';
  closeMobileSidebar();
  dom.chatScroll.scrollTop = 0;
  state.stick = true;
  dom.scrollBottom.classList.add('hidden');
  if (focus) dom.composer.focus();
}

function renderMessages() {
  dom.messages.innerHTML = '';
  if (!state.convo) return;
  const messages = state.convo.messages || [];
  dom.welcome.classList.toggle('hidden', messages.length > 0);
  messages.forEach((msg, index) => {
    const isLast = index === messages.length - 1;
    dom.messages.appendChild(
      msg.role === 'user'
        ? renderUserMessage(msg)
        : renderAssistantMessage(msg, { isLast })
    );
  });
  requestAnimationFrame(updateScrollState);
}

async function persistConversation(convo = state.convo) {
  if (!convo) return;
  convo.updatedAt = Date.now();

  const item = state.index.find((it) => it.id === convo.id);
  if (item) {
    item.title = convo.title || item.title;
    item.updatedAt = convo.updatedAt;
    item.messageCount = convo.messages.length;
    item.createdAt = convo.createdAt || item.createdAt;
  } else {
    state.index.unshift({
      id: convo.id,
      title: convo.title || '未命名对话',
      createdAt: convo.createdAt || Date.now(),
      updatedAt: convo.updatedAt,
      messageCount: convo.messages.length,
      pinned: false,
    });
  }

  try {
    await saveConversation(convo);
    await saveIndex(state.index);
  } catch (err) {
    console.error(err);
    toast('保存对话失败，可能是本地存储空间不足');
  }
  renderSidebar();
}

/* ------------------------------------------------------------------ */
/* Message rendering                                                  */
/* ------------------------------------------------------------------ */

function renderUserMessage(msg) {
  const el = document.createElement('article');
  el.className = 'msg user';
  el.dataset.id = msg.id;

  const main = document.createElement('div');
  main.className = 'msg-main';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (msg.content) {
    const text = document.createElement('div');
    text.style.whiteSpace = 'pre-wrap';
    text.textContent = msg.content;
    bubble.appendChild(text);
  }

  if (msg.images?.length) {
    const images = document.createElement('div');
    images.className = 'bubble-images';
    for (const img of msg.images) {
      if (!img?.dataUrl) continue;
      const image = document.createElement('img');
      image.src = img.dataUrl;
      image.alt = img.name || '图片';
      image.loading = 'lazy';
      image.dataset.zoom = '1';
      images.appendChild(image);
    }
    bubble.appendChild(images);
  }

  if (msg.files?.length) {
    const files = document.createElement('div');
    files.className = 'bubble-files';
    for (const file of msg.files) {
      const chip = document.createElement('div');
      chip.className = 'file-chip';
      chip.innerHTML = `${icon('file', 14)}<span class="name"></span><span class="size">${fileSize(file.size)}</span>`;
      chip.querySelector('.name').textContent = file.name || '文件';
      chip.title = file.name || '';
      files.appendChild(chip);
    }
    bubble.appendChild(files);
  }

  main.appendChild(bubble);

  const actions = document.createElement('div');
  actions.className = 'user-actions';
  actions.innerHTML = `
    <button type="button" data-act="copy" title="复制">${icon('copy', 14)}</button>
    <button type="button" data-act="edit" title="编辑并重新发送">${icon('edit', 14)}</button>`;
  main.appendChild(actions);

  el.appendChild(main);
  return el;
}

function renderAssistantMessage(msg, { isLast = false } = {}) {
  const el = document.createElement('article');
  el.className = 'msg assistant';
  el.dataset.id = msg.id;

  el.innerHTML = `
    <div class="avatar">${brandMark(18)}</div>
    <div class="msg-main">
      <div class="tool-panel hidden"></div>
      <div class="thinking hidden">
        <button class="thinking-toggle" type="button" aria-expanded="false">
          <span class="thinking-icon">${icon('brain', 16)}</span>
          <span class="thinking-label">深度思考</span>
          <span class="thinking-chev">${icon('chevronDown', 14)}</span>
        </button>
        <div class="thinking-body md-body"></div>
      </div>
      <div class="sources hidden"></div>
      <div class="answer-wrap">
        <div class="md-body answer"></div>
        <span class="stream-cursor hidden"></span>
      </div>
      <div class="pending-hint hidden"><span class="spinner"></span><span>正在生成…</span></div>
      <div class="stopped-note hidden">已停止生成</div>
      <div class="error-box hidden">
        <span class="error-text"></span>
        <button type="button" class="retry-btn">重试</button>
      </div>
      <div class="msg-actions">
        <button type="button" data-act="copy" title="复制">${icon('copy', 15)}</button>
        ${isLast ? `<button type="button" data-act="regen" title="重新生成">${icon('refresh', 15)}</button>` : ''}
        <span class="usage"></span>
      </div>
    </div>`;

  const answer = el.querySelector('.answer');
  answer.innerHTML = renderMarkdown(msg.content || '', {
    citations: msg.sources,
    highlight: true,
  });

  if (msg.reasoning) {
    const thinking = el.querySelector('.thinking');
    thinking.classList.remove('hidden');
    const body = el.querySelector('.thinking-body');
    body.innerHTML = renderMarkdown(msg.reasoning, { highlight: false });
    const secs = msg.thinkingSecs || 0;
    el.querySelector('.thinking-label').textContent = secs
      ? `已深度思考（用时 ${secs} 秒）`
      : '已深度思考';
  }

  if (msg.toolRuns?.length) {
    renderToolPanel(el, msg.toolRuns, { open: false, live: false, sources: msg.sources || [] });
  }

  if (msg.sources?.length) {
    renderSources(el, msg.sources);
  }

  if (msg.usage) {
    const usageEl = el.querySelector('.usage');
    usageEl.textContent = formatUsage(msg.usage);
    usageEl.title = usageTitle(msg.usage);
  }

  if (msg.error) {
    showError(el, msg.error, { retry: isLast });
  }

  if (msg.notice || msg.stopped) {
    const note = el.querySelector('.stopped-note');
    note.textContent = msg.notice || '已停止生成';
    note.classList.remove('hidden');
  }

  return el;
}

function showError(el, message, { retry = true } = {}) {
  const box = el.querySelector('.error-box');
  if (!box) return;
  box.classList.remove('hidden');
  box.querySelector('.error-text').textContent = message;
  const retryBtn = box.querySelector('.retry-btn');
  retryBtn.classList.toggle('hidden', !retry);
}

function hideError(el) {
  el.querySelector('.error-box')?.classList.add('hidden');
}

function renderSources(el, sources) {
  const box = el.querySelector('.sources');
  if (!box) return;
  const valid = (sources || []).filter((s) => s && safeHttpUrl(s.url));
  if (!valid.length) {
    box.classList.add('hidden');
    box.classList.remove('open');
    return;
  }

  const wasOpen = box.classList.contains('open');
  box.classList.remove('hidden');
  box.innerHTML = '';

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'sources-head';
  head.setAttribute('aria-expanded', wasOpen ? 'true' : 'false');
  head.innerHTML = `<span class="sources-icon">${icon('link', 13)}</span><span class="sources-title">参考来源 · ${valid.length}</span><span class="sources-chev">${icon('chevronDown', 14)}</span>`;

  const body = document.createElement('div');
  body.className = 'sources-body';
  const list = document.createElement('div');
  list.className = 'sources-list';

  valid.forEach((source, index) => {
    const a = document.createElement('a');
    a.className = 'source';
    a.href = source.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = source.title || source.url;

    const idx = document.createElement('span');
    idx.className = 'source-idx';
    idx.textContent = String(index + 1);

    const text = document.createElement('span');
    text.className = 'source-text';
    const name = document.createElement('span');
    name.className = 'source-title';
    name.textContent = source.title || source.url;
    const site = document.createElement('span');
    site.className = 'source-site';
    let host = source.site || '';
    if (!host) {
      try {
        host = new URL(source.url).hostname;
      } catch (_) {
        host = '';
      }
    }
    site.textContent = host || source.url;
    text.append(name, site);

    a.append(idx, text);
    list.appendChild(a);
  });

  body.appendChild(list);
  box.append(head, body);
  box.classList.toggle('open', wasOpen);
}

function toolNameLabel(name) {
  return name === 'web_search' ? '联网搜索' : name === 'web_fetch' ? '网页抓取' : name || '工具';
}

function renderToolPanel(el, entries, { open = false, live = false, sources = [], pending = null } = {}) {
  const panel = el.querySelector('.tool-panel');
  if (!panel) return;
  const wasOpen = panel.classList.contains('open');
  const list = (entries || []).filter(Boolean);
  if (!list.length && !pending) {
    panel.classList.add('hidden');
    panel.classList.remove('open');
    return;
  }
  panel.classList.remove('hidden');

  const searches = list.filter((e) => e.name === 'web_search');
  const fetches = list.filter((e) => e.name === 'web_fetch');
  const running = list.some((e) => e.status === 'running');
  const pageCount = new Set((sources || []).map((s) => s.url).filter(Boolean)).size;
  const providers = [
    ...new Set(list.map((e) => e.provider).filter(Boolean)),
  ].map((id) => providerLabel(id));
  const providerPrefix = providers.length ? `${providers.join(' / ')} · ` : '';

  let summary;
  if (pending) {
    summary = `${providerPrefix}正在调用 ${toolNameLabel(pending)}…`;
  } else if (running) {
    summary = `${providerPrefix}正在使用联网工具…`;
  } else {
    const bits = [];
    if (searches.length) bits.push(`${searches.length} 次搜索`);
    if (fetches.length) bits.push(`${fetches.length} 次抓取`);
    if (pageCount) bits.push(`${pageCount} 个来源`);
    summary = bits.length ? `${providerPrefix}${bits.join(' · ')}` : '联网工具';
  }

  const head = `
    <button class="tool-head" type="button" aria-expanded="${open ? 'true' : 'false'}">
      ${running || pending ? '<span class="spinner"></span>' : `<span class="tool-icon">${icon('globe', 14)}</span>`}
      <span class="tool-summary"></span>
      <span class="tool-chev">${icon('chevronDown', 14)}</span>
    </button>
    <div class="tool-body"></div>`;

  panel.innerHTML = head;
  panel.querySelector('.tool-summary').textContent = summary;

  const body = panel.querySelector('.tool-body');

  if (pending) {
    const row = document.createElement('div');
    row.className = 'tool-row';
    row.innerHTML = `<span class="spinner"></span><span class="tool-text">正在准备调用 ${toolNameLabel(pending)}…</span>`;
    body.appendChild(row);
  }

  for (const entry of list) {
    const row = document.createElement('div');
    row.className = 'tool-row';

    if (entry.status === 'running') {
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      row.appendChild(spinner);
    } else if (entry.status === 'error') {
      const status = document.createElement('span');
      status.className = 'tool-status-err';
      status.innerHTML = icon('alert', 14);
      row.appendChild(status);
    } else {
      const status = document.createElement('span');
      status.className = 'tool-status-ok';
      status.innerHTML = icon('check', 14);
      row.appendChild(status);
    }

    const text = document.createElement('div');
    text.className = 'tool-text';

    const headLine = document.createElement('div');
    const label = document.createElement('span');
    label.className = 'q';
    if (entry.name === 'web_search') {
      label.textContent = `${entry.auto ? '自动搜索' : '搜索'}${
        entry.cached ? '（复用）' : ''
      }：${entry.args?.query || ''}`;
    } else if (entry.name === 'web_fetch') {
      let host = entry.args?.url || '';
      try {
        host = new URL(entry.args.url).hostname;
      } catch (_) {
        /* keep */
      }
      label.textContent = `阅读：${entry.meta?.title || host}`;
    } else {
      label.textContent = toolNameLabel(entry.name);
    }
    headLine.appendChild(label);

    if (entry.provider) {
      const provider = document.createElement('span');
      provider.className = 'badge provider-badge';
      provider.textContent = providerLabel(entry.provider);
      headLine.appendChild(document.createTextNode(' '));
      headLine.appendChild(provider);
    }

    if (entry.status === 'ok' && entry.name === 'web_search') {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = `${entry.count ?? 0} 条`;
      headLine.appendChild(document.createTextNode(' '));
      headLine.appendChild(badge);
    }
    text.appendChild(headLine);

    if (entry.error) {
      const err = document.createElement('div');
      err.textContent = entry.error;
      text.appendChild(err);
    }

    if (entry.links?.length) {
      const links = document.createElement('div');
      links.className = 'tool-links';
      for (const link of entry.links.slice(0, 5)) {
        const url = safeHttpUrl(link.url);
        if (!url) continue;
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = link.title || url;
        a.title = link.title || url;
        links.appendChild(a);
      }
      if (links.childNodes.length) text.appendChild(links);
    }

    row.appendChild(text);
    body.appendChild(row);
  }

  const shouldOpen = !!open || wasOpen;
  panel.classList.toggle('open', shouldOpen);
  panel.querySelector('.tool-head').setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
}

/* ------------------------------------------------------------------ */
/* Request / streaming                                                */
/* ------------------------------------------------------------------ */

function makeUserMessage(text, attachments) {
  return {
    id: uid('m'),
    role: 'user',
    content: text,
    images: attachments
      .filter((a) => a.type === 'image')
      .map((a) => ({
        id: a.id,
        name: a.name,
        dataUrl: a.dataUrl,
        width: a.width,
        height: a.height,
      })),
    files: attachments
      .filter((a) => a.type === 'text')
      .map((a) => ({
        id: a.id,
        name: a.name,
        text: a.text,
        size: a.size,
      })),
    createdAt: Date.now(),
  };
}

function ensureConversation(firstText, hasImages) {
  if (state.convo) return;
  const id = uid('c');
  const now = Date.now();
  state.convo = {
    id,
    title: makeTitle(firstText, hasImages),
    createdAt: now,
    updatedAt: now,
    thinking: state.thinkingOn,
    webSearch: state.webOn,
    messages: [],
  };
  state.index.unshift({
    id,
    title: state.convo.title,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    pinned: false,
  });
  setActiveConversation(id);
  updateDocumentTitle();
}

async function sendMessage() {
  if (state.streaming) {
    stopStreaming();
    return;
  }
  const text = dom.composer.value.trim();
  if (!text && !state.attachments.length) return;

  if (!state.settings.apiKey) {
    toast('请先配置 API Key');
    openSettings('api');
    return;
  }

  const autoSearch =
    !!text &&
    !state.webOn &&
    state.settings.autoSearch !== false &&
    messageWantsSearch(text, state.convo);
  const useTools = state.webOn || autoSearch;
  if (autoSearch) {
    toast(
      state.settings.searchBackend === 'anthropic'
        ? '本轮命中联网关键词，使用 Messages 原生搜索…'
        : '本轮命中联网关键词，正在自动检索…'
    );
  }

  closeConversationMenu();
  const attachments = state.attachments.slice();
  const hasImages = attachments.some((a) => a.type === 'image');
  if (hasImages && !/flash|vision/i.test(state.settings.model)) {
    toast('提示：当前模型可能不支持图片理解，建议使用 deepseek-flash');
  }
  const fallbackTitle = attachments.find((a) => a.type === 'text')?.name || '';
  ensureConversation(text || fallbackTitle, hasImages);

  const userMsg = makeUserMessage(text, attachments);
  state.convo.messages.push(userMsg);

  dom.welcome.classList.add('hidden');
  dom.messages.appendChild(renderUserMessage(userMsg));

  dom.composer.value = '';
  state.attachments = [];
  renderAttachments();
  autosize();
  state.stick = true;
  scrollToBottom(true, true);
  await persistConversation();

  await runAssistantTurn({ useTools, autoSearch });
}

function startThinkingClock(run) {
  run.thinkingTimer = setInterval(() => {
    if (state.streaming !== run) return;
    if (run.thinkingEnd) return;
    const secs = Math.max(1, Math.round((Date.now() - run.thinkingStart) / 1000));
    const label = run.el.querySelector('.thinking-label');
    if (label) label.textContent = `深度思考中… ${secs}s`;
  }, 500);
}

function ensureThinkingVisible(run) {
  const thinking = run.el.querySelector('.thinking');
  if (!thinking || !thinking.classList.contains('hidden')) return;
  thinking.classList.remove('hidden');
  thinking.classList.add('open', 'streaming');
  thinking.querySelector('.thinking-toggle').setAttribute('aria-expanded', 'true');
  run.el.querySelector('.thinking-label').textContent = '深度思考中…';
}

function handleDelta(run, delta) {
  if (state.streaming !== run) return;

  if (delta.reasoning || delta.content) {
    run.el.querySelector('.pending-hint')?.classList.add('hidden');
  }

  if (delta.reasoning) {
    run.assistant.reasoning += delta.reasoning;
    if (run.current) run.current.reasoning += delta.reasoning;
    ensureThinkingVisible(run);
    scheduleThinkingRender(run);
    autoScroll(run);
  }

  if (delta.content) {
    run.assistant.content += delta.content;
    if (run.current) run.current.content += delta.content;
    if (!run.thinkingEnd && run.assistant.reasoning) {
      run.thinkingEnd = Date.now();
      run.assistant.thinkingSecs = Math.max(1, Math.round((run.thinkingEnd - run.thinkingStart) / 1000));
      const thinking = run.el.querySelector('.thinking');
      thinking?.classList.remove('streaming');
      const label = run.el.querySelector('.thinking-label');
      if (label) label.textContent = `已深度思考（用时 ${run.assistant.thinkingSecs} 秒）`;
      clearInterval(run.thinkingTimer);
      if (state.settings.foldThinking && !run.thinkingTouched) {
        thinking?.classList.remove('open');
        thinking?.querySelector('.thinking-toggle')?.setAttribute('aria-expanded', 'false');
      }
    }
    run.el.querySelector('.stream-cursor')?.classList.remove('hidden');
    scheduleAnswerRender(run);
    autoScroll(run);
  }
}

function scheduleThinkingRender(run) {
  if (run.thinkingRenderTimer) return;
  run.thinkingRenderTimer = setTimeout(() => {
    run.thinkingRenderTimer = null;
    if (state.streaming !== run) return;
    const body = run.el.querySelector('.thinking-body');
    if (!body) return;
    body.innerHTML = renderMarkdown(run.assistant.reasoning, { highlight: false, math: false });
    body.scrollTop = body.scrollHeight;
  }, 80);
}

function scheduleAnswerRender(run) {
  if (run.answerTimer) return;
  run.answerTimer = setTimeout(() => {
    run.answerTimer = null;
    if (state.streaming !== run) return;
    const answer = run.el.querySelector('.answer');
    if (!answer) return;
    answer.innerHTML = renderMarkdown(run.assistant.content, {
      citations: run.assistant.sources,
      highlight: false,
      math: false,
    });
    autoScroll(run);
  }, 70);
}

function autoScroll(run) {
  if (state.streaming !== run) return;
  if (!state.stick) return;
  dom.chatScroll.scrollTop = dom.chatScroll.scrollHeight;
}

function addSources(run, sources) {
  if (!Array.isArray(sources) || !sources.length) return;
  const existing = new Set(run.assistant.sources.map((s) => s.url).filter(Boolean));
  for (const source of sources) {
    if (!source?.url || existing.has(source.url)) continue;
    existing.add(source.url);
    run.assistant.sources.push(source);
  }
  if (run.assistant.sources.length) renderSources(run.el, run.assistant.sources);
}

function anthropicHost(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return '';
  }
}

function mapAnthropicUsage(usage) {
  if (!usage) return null;
  const input = Number(usage.input_tokens) || 0;
  const cacheRead = Number(usage.cache_read_input_tokens) || 0;
  const cacheCreate = Number(usage.cache_creation_input_tokens) || 0;
  const output = Number(usage.output_tokens) || 0;
  if (!input && !cacheRead && !cacheCreate && !output) return null;
  const prompt = input + cacheRead + cacheCreate;
  return {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: prompt + output,
    prompt_cache_hit_tokens: cacheRead,
    prompt_cache_miss_tokens: input + cacheCreate,
    prompt_tokens_details: { cached_tokens: cacheRead },
  };
}

function anthropicToolEntry(run, tool) {
  const id = tool.id || uid('tool');
  let entry = run.toolEntries.find((item) => item.id === id);
  if (entry) return entry;
  entry = {
    id,
    name: tool.name || 'web_search',
    args: tool.input || {},
    status: 'running',
    count: 0,
    links: [],
    error: null,
    meta: null,
    provider: 'messages',
  };
  run.toolEntries.push(entry);
  run.el.querySelector('.pending-hint')?.classList.add('hidden');
  renderToolPanel(run.el, run.toolEntries, {
    open: false,
    live: true,
    sources: run.assistant.sources,
  });
  autoScroll(run);
  return entry;
}

function addAnthropicToolUse(run, tool) {
  if (state.streaming !== run) return;
  anthropicToolEntry(run, tool);
}

function completeAnthropicToolUse(run, data) {
  if (state.streaming !== run) return;
  const results = Array.isArray(data.results) ? data.results : [];
  const sources = [];
  let toolError = '';
  for (const result of results) {
    if (result?.type === 'web_search_tool_result_error') {
      toolError = result.error_code || '搜索失败';
      continue;
    }
    if (!result?.url) continue;
    sources.push({
      title: result.title || anthropicHost(result.url) || result.url,
      url: result.url,
      site: anthropicHost(result.url),
      date: result.page_age || result.published_date || '',
      snippet: '',
      summary: '',
    });
  }

  let entry = run.toolEntries.find((item) => item.id === data.toolUseId);
  if (!entry) {
    entry = anthropicToolEntry(run, {
      id: data.toolUseId || uid('tool'),
      name: 'web_search',
      input: {},
    });
  }
  entry.status = sources.length ? 'ok' : 'error';
  entry.error = sources.length ? null : toolError || '搜索未返回结果';
  entry.count = sources.length;
  entry.links = sources.slice(0, 6).map((source) => ({
    title: source.title,
    url: source.url,
  }));
  entry.meta = {
    query: entry.args?.query || '',
    count: sources.length,
    provider: 'messages',
  };

  addSources(run, sources);
  renderToolPanel(run.el, run.toolEntries, {
    open: false,
    live: true,
    sources: run.assistant.sources,
  });
  autoScroll(run);
}

async function runAnthropicAssistantTurn(run, { systemMessage, useThinking, useTools }) {
  const settings = state.settings;
  let error = null;
  let aborted = false;

  try {
    const messages = buildAnthropicMessages(run.convo.messages.slice(0, -1));
    await streamAnthropicTurn({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      system: systemMessage,
      messages,
      thinking: useThinking,
      effort: settings.thinkingEffort,
      maxTokens: settings.maxTokens,
      tools: useTools,
      searchCount: settings.searchCount,
      signal: run.controller.signal,
      onText: (text) => handleDelta(run, { content: text }),
      onReasoning: (text) => handleDelta(run, { reasoning: text }),
      onToolUse: (tool) => addAnthropicToolUse(run, tool),
      onToolResult: (data) => completeAnthropicToolUse(run, data),
      onUsage: (usage) => {
        const mapped = mapAnthropicUsage(usage);
        if (mapped) run.usage = mapped;
      },
      onFinish: ({ stopReason }) => {
        run.finishReason = stopReason === 'max_tokens' ? 'length' : stopReason || '';
      },
    });
    run.apiFinal = {
      content: run.assistant.content,
      reasoning: run.assistant.reasoning,
    };
  } catch (err) {
    if (err?.name === 'AbortError') {
      aborted = true;
    } else {
      error = err;
    }
  } finally {
    await finishTurn(run, { aborted, error });
  }
}

/**
 * Keyword-triggered search. Unlike the normal model-driven tool loop this runs
 * before the first model request, so "最新/新闻/价格" questions still get
 * searched when the composer's web toggle is off.
 */
async function runAutoSearch(run, { query, count, oriQuestion }) {
  const entry = {
    id: uid('tool'),
    name: 'web_search',
    args: { query, count },
    status: 'running',
    count: 0,
    links: [],
    error: null,
    meta: null,
    provider: 'deepseek',
    auto: true,
  };
  run.toolEntries.push(entry);
  renderToolPanel(run.el, run.toolEntries, {
    open: false,
    live: true,
    sources: run.assistant.sources,
  });
  autoScroll(run);

  try {
    const out = await executeTool({
      baseUrl: state.settings.baseUrl,
      apiKey: state.settings.apiKey,
      name: 'web_search',
      args: { query, count },
      signal: run.controller.signal,
      defaultCount: state.settings.searchCount,
      oriQuestion,
      sourceOffset: 0,
      existingUrls: [],
      webFetchMode: state.settings.webFetchMode,
      fallbackDeepSeek: state.settings.fallbackDeepSeek,
      allowPrivateFetch: state.settings.allowPrivateFetch,
    });

    entry.status = 'ok';
    entry.count = out.meta?.count ?? out.sources?.length ?? 0;
    entry.meta = out.meta || null;
    entry.provider = out.meta?.provider || 'deepseek';
    entry.links = (out.sources || [])
      .filter((source) => source?.url)
      .slice(0, 6)
      .map((source) => ({ title: source.title || source.url, url: source.url }));

    addSources(run, out.sources);
    renderToolPanel(run.el, run.toolEntries, {
      open: false,
      live: true,
      sources: run.assistant.sources,
    });
    autoScroll(run);
    return out;
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    entry.status = 'error';
    entry.error = err?.message || String(err);
    renderToolPanel(run.el, run.toolEntries, {
      open: false,
      live: true,
      sources: run.assistant.sources,
    });
    autoScroll(run);
    toast('自动搜索失败，已跳过检索结果');
    return null;
  }
}

function reuseAutoSearch(run, userMsg) {
  const sources = Array.isArray(userMsg.searchSources) ? userMsg.searchSources : [];
  if (!sources.length || !userMsg.searchContext) return false;

  const entry = {
    id: uid('tool'),
    name: 'web_search',
    args: {
      query: userMsg.searchQuery || '',
      count: sources.length,
    },
    status: 'ok',
    count: sources.length,
    links: sources
      .filter((source) => source?.url)
      .slice(0, 6)
      .map((source) => ({ title: source.title || source.url, url: source.url })),
    error: null,
    meta: {
      query: userMsg.searchQuery || '',
      count: sources.length,
      provider: 'deepseek',
      reused: true,
    },
    provider: 'deepseek',
    auto: true,
    cached: true,
  };

  run.toolEntries.push(entry);
  addSources(run, sources);
  renderToolPanel(run.el, run.toolEntries, {
    open: false,
    live: true,
    sources: run.assistant.sources,
  });
  autoScroll(run);
  return true;
}

async function ensureAutoSearch(run, userMsg, originalQuestion) {
  if (!userMsg) return;

  const fresh =
    userMsg.searchContext &&
    Date.now() - (userMsg.searchContextAt || 0) < AUTO_SEARCH_TTL;
  if (fresh && reuseAutoSearch(run, userMsg)) return;

  const query = autoSearchQuery(originalQuestion, run.convo);
  if (!query) return;

  const out = await runAutoSearch(run, {
    query,
    count: state.settings.searchCount,
    oriQuestion: originalQuestion,
  });
  if (!out?.sources?.length || !out.text) return;

  userMsg.searchContext = out.text;
  userMsg.searchContextAt = Date.now();
  userMsg.searchSources = out.sources;
  userMsg.searchQuery = query;
}

async function runToolCall(run, call, originalQuestion) {
  const name = call.function?.name || 'unknown';
  let args = {};
  try {
    args = JSON.parse(call.function?.arguments || '{}');
  } catch (_) {
    args = {};
  }

  run.pendingTool = null;
  const entry = {
    id: uid('tool'),
    name,
    args,
    status: 'running',
    count: 0,
    links: [],
    error: null,
    meta: null,
    provider: '',
  };
  run.toolEntries.push(entry);
  renderToolPanel(run.el, run.toolEntries, {
    open: false,
    live: true,
    sources: run.assistant.sources,
  });
  autoScroll(run);

  try {
    const out = await executeTool({
      baseUrl: state.settings.baseUrl,
      apiKey: state.settings.apiKey,
      name,
      args,
      signal: run.controller.signal,
      defaultCount: state.settings.searchCount,
      oriQuestion: originalQuestion,
      sourceOffset: run.assistant.sources.length,
      existingUrls: run.assistant.sources.map((s) => s.url),
      webFetchMode: state.settings.webFetchMode,
      fallbackDeepSeek: state.settings.fallbackDeepSeek,
      allowPrivateFetch: state.settings.allowPrivateFetch,
    });
    entry.status = 'ok';
    entry.count = out.meta?.count ?? out.sources?.length ?? 0;
    entry.meta = out.meta || null;
    entry.provider = out.meta?.provider || '';
    entry.links = (out.sources || [])
      .filter((s) => s?.url)
      .slice(0, 6)
      .map((s) => ({ title: s.title || s.url, url: s.url }));
    addSources(run, out.sources);
    renderToolPanel(run.el, run.toolEntries, {
      open: false,
      live: true,
      sources: run.assistant.sources,
    });
    return out.text;
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    entry.status = 'error';
    entry.error = err?.message || String(err);
    renderToolPanel(run.el, run.toolEntries, {
      open: false,
      live: true,
      sources: run.assistant.sources,
    });
    return `工具执行失败：${entry.error}`;
  }
}

function getConversationSystemMessage(convo, settings) {
  const now = new Date();
  const dateKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  const promptSignature = settings.systemPrompt || '';
  const stale =
    !convo.systemMessage ||
    typeof convo.systemMessage !== 'string' ||
    convo.systemDateKey !== dateKey ||
    convo.systemPromptSignature !== promptSignature;

  if (stale) {
    // Changing the system message changes the whole prefix, so this is an
    // intentional (rare) cache miss.
    convo.systemMessage = buildSessionSystemMessage(settings).content;
    convo.systemDateKey = dateKey;
    convo.systemPromptSignature = promptSignature;
  }
  return convo.systemMessage;
}

async function runAssistantTurn({
  useTools: useToolsOverride = null,
  autoSearch = false,
} = {}) {
  const convo = state.convo;
  const settings = state.settings;
  const useThinking = state.thinkingOn;
  let useTools = useToolsOverride ?? state.webOn;
  convo.thinking = useThinking;
  // Persist only the manual composer toggle; context-based auto search is
  // decided again for every turn and must not stay on for the whole chat.
  convo.webSearch = state.webOn;

  const assistant = {
    id: uid('m'),
    role: 'assistant',
    content: '',
    reasoning: '',
    sources: [],
    toolRuns: [],
    createdAt: Date.now(),
    model: settings.model,
    usage: null,
    error: null,
    stopped: false,
    thinkingSecs: 0,
  };
  convo.messages.push(assistant);

  const assistantEl = renderAssistantMessage(assistant, { isLast: true });
  dom.messages.appendChild(assistantEl);
  dom.welcome.classList.add('hidden');

  const controller = new AbortController();
  const run = {
    convo,
    assistant,
    el: assistantEl,
    controller,
    thinkingStart: Date.now(),
    thinkingEnd: 0,
    thinkingTouched: false,
    thinkingTimer: null,
    thinkingRenderTimer: null,
    answerTimer: null,
    toolEntries: [],
    trace: [],
    apiFinal: null,
    current: { content: '', reasoning: '' },
    lastHadToolCalls: false,
    finishReason: '',
    pendingTool: null,
    usage: null,
    aborted: false,
  };
  state.streaming = run;
  setStreamingUI(true);
  startThinkingClock(run);
  assistantEl.querySelector('.pending-hint')?.classList.remove('hidden');
  requestAnimationFrame(() => scrollToBottom(true, true));

  const systemMessage = getConversationSystemMessage(convo, settings);

  // Messages mode: the whole turn goes to the DeepSeek Messages-compatible
  // endpoint, with native server-side web_search when the composer's web
  // toggle is on. Chat mode uses Chat Completions + DeepSeek Search.
  if (settings.searchBackend === 'anthropic') {
    await runAnthropicAssistantTurn(run, { systemMessage, useThinking, useTools });
    return;
  }

  let tools = useTools ? buildToolDefinitions(settings.allowFetch) : null;
  const lastUser = [...convo.messages].reverse().find((m) => m.role === 'user');
  const originalQuestion = lastUser?.content || '';

  let error = null;
  let aborted = false;
  let apiMessages = null;

  try {
    // Chat mode: keyword-triggered search happens before the first model call,
    // so it works even when the composer's web toggle is off. Messages mode
    // uses its server-side web_search tool instead.
    if (autoSearch) {
      await ensureAutoSearch(run, lastUser, originalQuestion);
    }

    apiMessages = buildApiMessages(
      convo.messages.slice(0, -1),
      settings,
      systemMessage
    );

    for (let loop = 0; loop <= TOOL_LOOP_LIMIT; loop += 1) {
      run.current = { content: '', reasoning: '' };
      run.lastHadToolCalls = false;
      const result = await streamChat({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        messages: apiMessages,
        thinking: useThinking,
        reasoningEffort: settings.thinkingEffort,
        maxTokens: settings.maxTokens,
        temperature: settings.temperature,
        tools,
        includeUsage: settings.includeUsage,
        signal: controller.signal,
        onDelta: (delta) => handleDelta(run, delta),
        onToolCall: ({ name }) => {
          if (state.streaming !== run) return;
          run.el.querySelector('.pending-hint')?.classList.add('hidden');
          run.pendingTool = name;
          renderToolPanel(run.el, run.toolEntries, {
            pending: name,
            open: false,
            live: true,
            sources: run.assistant.sources,
          });
        },
      });

      if (result.usage) run.usage = result.usage;
      run.finishReason = result.finishReason || '';

      // Some models fall back to a textual tool-call protocol (especially when
      // the request did not declare tools). Recover those calls, remove the raw
      // markers from the answer, and continue the normal tool loop.
      if (!result.toolCalls?.length && result.content) {
        const parsed = parseRawToolCalls(result.content);
        const changed = parsed.cleaned !== result.content;
        if (changed) {
          if (run.assistant.content.endsWith(result.content)) {
            run.assistant.content =
              run.assistant.content.slice(0, -result.content.length) + parsed.cleaned;
          } else {
            run.assistant.content = run.assistant.content.replace(
              result.content,
              parsed.cleaned
            );
          }
          if (run.current) run.current.content = parsed.cleaned;
          result.content = parsed.cleaned;
          const answerEl = run.el.querySelector('.answer');
          if (answerEl) {
            answerEl.innerHTML = renderMarkdown(run.assistant.content, {
              citations: run.assistant.sources,
              highlight: false,
              math: false,
            });
          }
        }

        if (parsed.calls.length) {
          if (
            !tools &&
            settings.autoSearch !== false &&
            messageWantsSearch(originalQuestion, convo)
          ) {
            useTools = true;
            tools = buildToolDefinitions(settings.allowFetch);
            toast('本轮按上下文启用联网（模型按需调用）');
          }

          if (!tools) {
            run.assistant.notice =
              '模型尝试调用联网搜索，但联网搜索当前已关闭，已忽略该调用。';
          } else {
            result.toolCalls = parsed.calls.map((call, index) => ({
              id: `call_raw_${Date.now().toString(36)}_${index}`,
              type: 'function',
              function: {
                name: call.name,
                arguments: JSON.stringify(call.args || {}),
              },
            }));
          }
        } else if (changed) {
          run.assistant.notice =
            '模型尝试调用联网工具，但调用格式无法解析，已忽略该调用。';
        }
      }

      run.lastHadToolCalls = !!result.toolCalls?.length;

      if (!result.toolCalls?.length) {
        run.apiFinal = {
          content: result.content || '',
          reasoning: result.reasoning || '',
        };
        break;
      }

      if (loop === TOOL_LOOP_LIMIT) {
        throw new Error('联网工具调用次数过多，已自动停止。');
      }

      const calls = result.toolCalls.map((call, index) => ({
        ...call,
        id: call.id || `call_${loop}_${index}`,
      }));

      const toolCallMessage = {
        role: 'assistant',
        content: result.content || '',
        tool_calls: calls,
      };
      if (result.reasoning) toolCallMessage.reasoning_content = result.reasoning;
      apiMessages.push(toolCallMessage);

      // Only commit a complete assistant-tool + tool-results exchange to the
      // persisted trace. If the user aborts mid-tool, we avoid persisting an
      // assistant tool_calls message without matching tool results.
      const exchange = [toolCallMessage];
      for (const call of calls) {
        const content = await runToolCall(run, call, originalQuestion);
        const toolMessage = {
          role: 'tool',
          tool_call_id: call.id,
          content,
        };
        apiMessages.push(toolMessage);
        exchange.push(toolMessage);
      }
      run.trace.push(...exchange);
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      aborted = true;
    } else {
      error = err;
    }
  } finally {
    await finishTurn(run, { aborted, error });
  }
}

async function finishTurn(run, { aborted = false, error = null } = {}) {
  clearInterval(run.thinkingTimer);
  clearTimeout(run.thinkingRenderTimer);
  clearTimeout(run.answerTimer);

  const assistant = run.assistant;
  const settings = state.settings;

  if (run.thinkingEnd) {
    assistant.thinkingSecs = Math.max(1, Math.round((run.thinkingEnd - run.thinkingStart) / 1000));
  } else if (assistant.reasoning) {
    assistant.thinkingSecs = Math.max(1, Math.round((Date.now() - run.thinkingStart) / 1000));
  }

  assistant.usage = run.usage || null;
  for (const entry of run.toolEntries) {
    if (entry.status === 'running') {
      entry.status = 'error';
      entry.error = aborted ? '已停止' : '工具未完成';
    }
  }
  assistant.toolRuns = run.toolEntries.map((entry) => ({
    name: entry.name,
    args: entry.args,
    status: entry.status,
    count: entry.count,
    links: entry.links,
    error: entry.error,
    meta: entry.meta,
    provider: entry.provider,
    auto: !!entry.auto,
    cached: !!entry.cached,
  }));

  // Keep the final sub-turn separate from the combined display text. The
  // hidden tool trace already contains earlier sub-turns' content/reasoning;
  // the final assistant message must not repeat them.
  const final = run.apiFinal || (!run.lastHadToolCalls ? run.current : null);
  if (final) {
    assistant.apiFinalContent = final.content || '';
    assistant.apiFinalReasoning = final.reasoning || '';
  }

  // Persist the hidden tool exchange so subsequent requests replay the exact
  // same prefix. Only keep it when the assistant produced a final message;
  // otherwise the trace would end with tool results and no assistant reply.
  if (
    run.trace.length &&
    final &&
    ((assistant.apiFinalContent || '').trim() ||
      (assistant.apiFinalReasoning || '').trim())
  ) {
    assistant.toolTrace = run.trace;
  }

  if (aborted) {
    assistant.stopped = true;
  } else if (error) {
    assistant.error = error.message || String(error);
  } else if (!assistant.content.trim() && !assistant.notice) {
    assistant.error = '模型没有返回内容，请重试。';
  }

  if (!assistant.error && !assistant.stopped && run.finishReason === 'length') {
    assistant.notice = '回答达到最大输出长度，可能被截断。可在设置中提高「最大输出 tokens」。';
  }

  const answer = run.el.querySelector('.answer');
  if (answer) {
    answer.innerHTML = renderMarkdown(assistant.content, {
      citations: assistant.sources,
      highlight: true,
    });
  }

  if (assistant.reasoning) {
    const thinking = run.el.querySelector('.thinking');
    thinking?.classList.remove('hidden', 'streaming');
    const body = run.el.querySelector('.thinking-body');
    if (body) body.innerHTML = renderMarkdown(assistant.reasoning, { highlight: false });
    const label = run.el.querySelector('.thinking-label');
    if (label) {
      label.textContent = assistant.thinkingSecs
        ? `已深度思考（用时 ${assistant.thinkingSecs} 秒）`
        : '已深度思考';
    }
    if (settings.foldThinking && !run.thinkingTouched) {
      thinking?.classList.remove('open');
      thinking?.querySelector('.thinking-toggle')?.setAttribute('aria-expanded', 'false');
    }
  }

  run.el.querySelector('.stream-cursor')?.classList.add('hidden');
  run.el.querySelector('.pending-hint')?.classList.add('hidden');
  run.el.querySelector('.thinking')?.classList.remove('streaming');

  if (assistant.toolRuns.length) {
    renderToolPanel(run.el, assistant.toolRuns, {
      open: run.toolEntries.some((e) => e.status === 'error'),
      live: false,
      sources: assistant.sources,
    });
  }

  if (assistant.sources.length) renderSources(run.el, assistant.sources);

  const usageEl = run.el.querySelector('.usage');
  if (assistant.usage && usageEl) {
    usageEl.textContent = formatUsage(assistant.usage);
    usageEl.title = usageTitle(assistant.usage);
  }

  if (assistant.error) showError(run.el, assistant.error, { retry: true });
  if (assistant.notice || assistant.stopped) {
    const note = run.el.querySelector('.stopped-note');
    if (note) {
      note.textContent = assistant.notice || '已停止生成';
      note.classList.remove('hidden');
    }
    if (!assistant.content && !assistant.error) {
      run.el.querySelector('.answer').textContent = '';
    }
  }

  // Ensure this assistant is the last one with a regenerate button.
  run.el.querySelector('[data-act="regen"]')?.remove();
  if (state.convo?.id === run.convo.id) {
    const last = run.convo.messages[run.convo.messages.length - 1];
    if (last?.id === assistant.id) {
      const actions = run.el.querySelector('.msg-actions');
      if (actions && !actions.querySelector('[data-act="regen"]')) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.act = 'regen';
        btn.title = '重新生成';
        btn.innerHTML = icon('refresh', 15);
        const usage = actions.querySelector('.usage');
        actions.insertBefore(btn, usage);
      }
    }
  }

  state.streaming = null;
  setStreamingUI(false);
  if (aborted) toast('已停止生成');

  await persistConversation(run.convo);
  autoScrollAfterFinish(run);
}

function autoScrollAfterFinish(run) {
  if (state.convo?.id !== run.convo.id) return;
  if (state.stick) {
    requestAnimationFrame(() => {
      dom.chatScroll.scrollTop = dom.chatScroll.scrollHeight;
      updateScrollState();
    });
  } else {
    updateScrollState();
  }
}

function stopStreaming() {
  if (!state.streaming) return;
  state.streaming.controller.abort();
}

async function regenerate(assistantId) {
  if (state.streaming) {
    toast('正在生成，请稍候');
    return;
  }
  if (!state.convo) return;
  const index = state.convo.messages.findIndex((m) => m.id === assistantId);
  if (index < 0) return;

  const previousUser = [...state.convo.messages.slice(0, index)].reverse().find((m) => m.role === 'user');
  if (!previousUser) return;

  state.convo.messages.splice(index);
  renderMessages();
  await persistConversation();
  const autoSearch =
    !state.webOn &&
    state.settings.autoSearch !== false &&
    messageWantsSearch(previousUser.content || '', state.convo);
  const useTools = state.webOn || autoSearch;
  await runAssistantTurn({ useTools, autoSearch });
}

async function editUserMessage(messageId) {
  if (!state.convo) return;
  if (state.streaming) stopStreaming();
  const index = state.convo.messages.findIndex((m) => m.id === messageId);
  if (index < 0) return;
  const msg = state.convo.messages[index];

  if (index < state.convo.messages.length - 1) {
    const ok = await confirmDialog({
      title: '编辑消息',
      message: '编辑这条消息会删除它之后的所有回复，确定继续吗？',
      okText: '继续',
      danger: false,
    });
    if (!ok) return;
  }

  state.attachments = [
    ...(msg.images || []).map((img) => ({
      id: img.id || uid('img'),
      type: 'image',
      name: img.name || '图片',
      dataUrl: img.dataUrl,
      width: img.width || 0,
      height: img.height || 0,
      size: 0,
    })),
    ...(msg.files || []).map((file) => ({
      id: file.id || uid('file'),
      type: 'text',
      name: file.name || '文件',
      text: file.text || '',
      size: file.size || 0,
    })),
  ];

  state.convo.messages.splice(index);
  dom.composer.value = msg.content || '';
  renderAttachments();
  autosize();
  renderMessages();
  await persistConversation();
  updateSendButton();
  dom.composer.focus();
  toast('已把消息放回输入框，修改后重新发送');
}

/* ------------------------------------------------------------------ */
/* Attachments                                                        */
/* ------------------------------------------------------------------ */

function attachKind(file) {
  if (/^image\/(jpeg|png|gif|webp)$/i.test(file.type)) return 'image';
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (file.type.startsWith('text/') || TEXT_EXTENSIONS.includes(ext)) return 'text';
  return 'unsupported';
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解析失败'));
    img.src = src;
  });
}

async function compressImage(file) {
  if (file.size > 24 * 1024 * 1024) {
    throw new Error('图片超过 24MB，请先压缩');
  }
  const original = await readAsDataURL(file);
  const img = await loadImage(original);
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(width, height));

  if (scale === 1 && file.size <= 700 * 1024 && file.type !== 'image/gif') {
    return { dataUrl: original, width, height, size: file.size };
  }

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  let dataUrl = canvas.toDataURL('image/webp', 0.86);
  if (!dataUrl.startsWith('data:image/webp')) {
    dataUrl = canvas.toDataURL('image/jpeg', 0.88);
  }
  return {
    dataUrl,
    width: canvas.width,
    height: canvas.height,
    size: Math.round((dataUrl.length * 3) / 4),
  };
}

async function addFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;

  for (const file of files) {
    if (state.attachments.length >= MAX_ATTACHMENTS) {
      toast(`最多添加 ${MAX_ATTACHMENTS} 个附件`);
      break;
    }
    const kind = attachKind(file);
    try {
      if (kind === 'image') {
        const compressed = await compressImage(file);
        state.attachments.push({
          id: uid('img'),
          type: 'image',
          name: file.name || '图片',
          dataUrl: compressed.dataUrl,
          width: compressed.width,
          height: compressed.height,
          size: compressed.size,
        });
      } else if (kind === 'text') {
        if (file.size > 2 * 1024 * 1024) {
          toast(`「${file.name}」超过 2MB，已跳过`);
          continue;
        }
        let text = await file.text();
        if (!text.trim()) {
          toast(`「${file.name}」是空文件，已跳过`);
          continue;
        }
        if (text.length > MAX_TEXT_CHARS) {
          text = `${text.slice(0, MAX_TEXT_CHARS)}\n…（文件过长，已截断）`;
        }
        state.attachments.push({
          id: uid('file'),
          type: 'text',
          name: file.name || '文本文件',
          text,
          size: file.size,
        });
      } else {
        toast(`暂不支持「${file.name}」。目前支持图片和常见文本文件。`);
      }
    } catch (err) {
      toast(`处理「${file.name}」失败：${err.message}`);
    }
  }

  renderAttachments();
  updateSendButton();
  dom.composer.focus();
}

function renderAttachments() {
  dom.attachments.innerHTML = '';
  if (!state.attachments.length) {
    dom.attachments.classList.add('hidden');
    updateSendButton();
    updateScrollBottomPosition();
    return;
  }
  dom.attachments.classList.remove('hidden');

  for (const item of state.attachments) {
    const el = document.createElement('div');
    el.className = `attachment ${item.type === 'text' ? 'file' : ''}`;
    el.dataset.id = item.id;

    if (item.type === 'image') {
      const img = document.createElement('img');
      img.src = item.dataUrl;
      img.alt = item.name;
      img.dataset.zoom = '1';
      img.title = `${item.name} · ${item.width}×${item.height}`;
      el.appendChild(img);
    } else {
      el.innerHTML = `${icon('file', 15)}<span class="att-name"></span>`;
      el.querySelector('.att-name').textContent = item.name;
      el.title = item.name;
    }

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.setAttribute('aria-label', '移除附件');
    remove.innerHTML = icon('x', 11);
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      state.attachments = state.attachments.filter((a) => a.id !== item.id);
      renderAttachments();
    });
    el.appendChild(remove);
    dom.attachments.appendChild(el);
  }
  updateSendButton();
  updateScrollBottomPosition();
}

/* ------------------------------------------------------------------ */
/* Composer / menus                                                   */
/* ------------------------------------------------------------------ */

function autosize() {
  dom.composer.style.height = 'auto';
  const height = Math.min(dom.composer.scrollHeight, 220);
  dom.composer.style.height = `${Math.max(54, height)}px`;
  updateScrollBottomPosition();
}

function updateScrollBottomPosition() {
  if (!dom.scrollBottom || !dom.composerArea) return;
  const offset = dom.composerArea.offsetHeight + 12;
  dom.scrollBottom.style.bottom = `${offset}px`;
}

function updateSendButton() {
  if (state.streaming) {
    dom.sendBtn.classList.add('streaming');
    dom.sendBtn.classList.remove('disabled');
    dom.sendBtn.disabled = false;
    dom.sendBtn.title = '停止生成';
    dom.sendBtn.setAttribute('aria-label', '停止生成');
    dom.sendBtn.innerHTML = icon('stopSmall', 18);
    return;
  }
  const hasContent = !!dom.composer.value.trim() || state.attachments.length > 0;
  dom.sendBtn.classList.remove('streaming');
  dom.sendBtn.classList.toggle('disabled', !hasContent);
  dom.sendBtn.disabled = !hasContent;
  dom.sendBtn.title = '发送';
  dom.sendBtn.setAttribute('aria-label', '发送');
  dom.sendBtn.innerHTML = icon('arrowUp', 18);
}

function setStreamingUI(streaming) {
  updateSendButton();
  dom.sendHint.textContent = streaming
    ? '生成中… 点击停止'
    : state.settings.sendOnEnter
      ? 'Enter 发送'
      : 'Ctrl/⌘ + Enter 发送';
}

function updateModelUI() {
  dom.modelName.textContent = state.settings.model || DEFAULT_SETTINGS.model;
  dom.modelName.title = state.settings.model || '';
  dom.accountSub.textContent = state.settings.apiKey ? '自带 API Key' : '未配置 API Key';
}

function updateApiNotice() {
  const needsKey = !state.settings.apiKey;
  dom.apiNotice.classList.toggle('hidden', !needsKey);
}

function updateToggles() {
  setToggle(dom.thinkingToggle, state.thinkingOn);
  setToggle(dom.searchToggle, state.webOn);
}

function updateScrollState() {
  const distance =
    dom.chatScroll.scrollHeight - dom.chatScroll.scrollTop - dom.chatScroll.clientHeight;
  state.stick = distance < 120;
  dom.scrollBottom.classList.toggle('hidden', distance < 240);
}

function scrollToBottom(force = false, instant = false) {
  if (force) state.stick = true;
  if (!force && !state.stick) return;
  if (instant) {
    dom.chatScroll.scrollTop = dom.chatScroll.scrollHeight;
    requestAnimationFrame(updateScrollState);
    return;
  }
  dom.chatScroll.scrollTo({ top: dom.chatScroll.scrollHeight, behavior: 'smooth' });
}

function openModelMenu() {
  closeModelMenu();
  const models = [
    { id: 'deepseek-flash', label: 'deepseek-flash', sub: '推荐 · 多模态' },
    { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro', sub: '更强推理' },
    { id: 'deepseek-chat', label: 'deepseek-chat', sub: '兼容旧名' },
    { id: 'deepseek-reasoner', label: 'deepseek-reasoner', sub: '兼容旧名' },
  ];
  for (const id of state.modelList) {
    if (!models.some((m) => m.id === id)) models.push({ id, label: id, sub: '来自 API' });
  }

  dom.modelMenu.innerHTML = '<div class="menu-title">选择模型</div>';
  for (const model of models) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.model = model.id;
    const labelEl = document.createElement('span');
    labelEl.textContent = model.label;
    btn.appendChild(labelEl);
    if (model.id === state.settings.model) {
      const check = document.createElement('span');
      check.className = 'check';
      check.innerHTML = icon('check', 14);
      btn.appendChild(check);
    } else {
      const sub = document.createElement('span');
      sub.className = 'menu-sub';
      sub.textContent = model.sub;
      btn.appendChild(sub);
    }
    btn.addEventListener('click', async () => {
      closeModelMenu();
      state.settings.model = model.id;
      state.settings = await saveSettings(state.settings);
      updateModelUI();
      toast(`已切换到 ${model.id}`);
    });
    dom.modelMenu.appendChild(btn);
  }

  const sep = document.createElement('div');
  sep.className = 'menu-sep';
  dom.modelMenu.appendChild(sep);

  const custom = document.createElement('button');
  custom.type = 'button';
  custom.innerHTML = `<span>自定义模型 / Base URL…</span>`;
  custom.addEventListener('click', () => {
    closeModelMenu();
    openSettings('api');
  });
  dom.modelMenu.appendChild(custom);

  dom.modelMenu.classList.remove('hidden');
  dom.modelBtn.setAttribute('aria-expanded', 'true');
}

function closeModelMenu() {
  dom.modelMenu.classList.add('hidden');
  dom.modelBtn.setAttribute('aria-expanded', 'false');
}

/* ------------------------------------------------------------------ */
/* Settings                                                           */
/* ------------------------------------------------------------------ */

function showSettingsTab(tab) {
  dom.settingsNav.querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.settings-panel').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== tab;
  });
  const content = dom.settingsDialog.querySelector('.settings-content');
  if (content) content.scrollTop = 0;
  if (tab === 'data') refreshStats();
}

function populateSettingsForm() {
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
  dom.setWebSearch.checked = !!s.webSearch;
  dom.setAllowFetch.checked = s.allowFetch !== false;
  dom.setFoldThinking.checked = s.foldThinking !== false;
  dom.setIncludeUsage.checked = s.includeUsage !== false;
  dom.setSendOnEnter.checked = s.sendOnEnter !== false;
  dom.setSearchCount.value = String(s.searchCount ?? 8);
  dom.setTemperature.value = String(s.temperature ?? 1);
  dom.setAnthropicSearch.checked = s.searchBackend !== 'builtin';
  dom.setAutoSearch.checked = s.autoSearch !== false;
  dom.setFetchMode.value = s.webFetchMode || 'local';
  dom.setFallbackDeepSeek.checked = s.fallbackDeepSeek !== false;
  dom.setAllowPrivateFetch.checked = !!s.allowPrivateFetch;
  dom.setTheme.value = s.theme || 'auto';
  dom.setFontSize.value = String(s.fontSize || 16);
  dom.testResult.textContent = '';
  dom.testResult.className = 'test-result';
}

function openSettings(tab = 'api') {
  closeModelMenu();
  populateSettingsForm();
  showSettingsTab(tab);
  dom.settingsDialog.showModal();
  if (tab === 'api') {
    setTimeout(() => dom.setApiKey.focus(), 40);
  }
}

async function saveSettingsFromForm() {
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
  next.webSearch = dom.setWebSearch.checked;
  next.allowFetch = dom.setAllowFetch.checked;
  next.foldThinking = dom.setFoldThinking.checked;
  next.includeUsage = dom.setIncludeUsage.checked;
  next.sendOnEnter = dom.setSendOnEnter.checked;
  next.searchCount = clampInt(dom.setSearchCount.value, 1, 20, 8);
  next.temperature = clampFloat(dom.setTemperature.value, 0, 2, 1);
  next.searchBackend = dom.setAnthropicSearch.checked ? 'anthropic' : 'builtin';
  next.autoSearch = dom.setAutoSearch.checked;
  next.webFetchMode = dom.setFetchMode.value === 'deepseek' ? 'deepseek' : 'local';
  next.fallbackDeepSeek = dom.setFallbackDeepSeek.checked;
  next.allowPrivateFetch = dom.setAllowPrivateFetch.checked;
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
    state.webOn = state.settings.webSearch;
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

async function testConnection() {
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

  dom.testConnection.disabled = true;
  dom.testResult.textContent = '正在连接…';
  dom.testResult.className = 'test-result';
  try {
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
    dom.testResult.textContent = models.length
      ? `连接成功，可用模型：${models.slice(0, 6).join('、')}${models.length > 6 ? '…' : ''}${hasChosen ? '' : '（当前模型不在列表中）'}`
      : '连接成功，但 /models 没有返回模型列表。';
    dom.testResult.className = 'test-result ok';
  } catch (err) {
    dom.testResult.textContent = err.message;
    dom.testResult.className = 'test-result err';
  } finally {
    dom.testConnection.disabled = false;
  }
}

async function testWebSearch() {
  const baseUrl = sanitizeBaseUrl(dom.setBaseUrl.value) || state.settings.baseUrl;
  const apiKey = dom.setApiKey.value.trim();
  const model = dom.setModel.value.trim() || state.settings.model;
  const query = 'DeepSeek 最新公告';

  dom.testSearch.disabled = true;
  dom.testSearchResult.textContent = '正在搜索…';
  dom.testSearchResult.className = 'test-result';

  try {
    const backend = dom.setAnthropicSearch.checked ? 'messages' : 'chat';
    if (backend === 'messages') {
      const out = await messagesSearch({
        baseUrl,
        apiKey,
        model,
        query,
        count: 3,
      });
      dom.testSearchResult.textContent = `${providerLabel(out.provider)} · ${
        out.sources.length
      } 个来源 · ${out.sources[0]?.title || '无结果'}`;
    } else {
      const out = await executeTool({
        baseUrl,
        apiKey,
        name: 'web_search',
        args: { query, count: 3 },
        fallbackDeepSeek: false,
      });
      dom.testSearchResult.textContent = `DeepSeek Search · ${out.meta.count} 条 · ${
        out.sources[0]?.title || '无结果'
      }`;
    }
    dom.testSearchResult.className = 'test-result ok';
  } catch (err) {
    dom.testSearchResult.textContent = err.message;
    dom.testSearchResult.className = 'test-result err';
  } finally {
    dom.testSearch.disabled = false;
  }
}

async function refreshStats() {
  try {
    const stats = await storageStats();
    dom.statConversations.textContent = String(stats.conversations);
    dom.statMessages.textContent = String(stats.messages);
  } catch (_) {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Dialogs                                                            */
/* ------------------------------------------------------------------ */

function confirmDialog({ title, message, okText = '确定', danger = true }) {
  dom.confirmTitle.textContent = title || '确认';
  dom.confirmMessage.textContent = message || '';
  dom.confirmOk.textContent = okText;
  dom.confirmOk.className = danger ? 'btn danger-solid' : 'btn primary';
  dom.confirmDialog.returnValue = '';
  dom.confirmDialog.showModal();
  return new Promise((resolve) => {
    dom.confirmDialog.addEventListener(
      'close',
      () => resolve(dom.confirmDialog.returnValue === 'ok'),
      { once: true }
    );
  });
}

/* ------------------------------------------------------------------ */
/* Export / import                                                    */
/* ------------------------------------------------------------------ */

function conversationToMarkdown(convo) {
  const lines = [];
  lines.push(`# ${convo.title || '未命名对话'}`);
  lines.push('');
  lines.push(`> 由 Sapgir 导出 · ${new Date(convo.updatedAt || Date.now()).toLocaleString('zh-CN')}`);
  lines.push('> 内容由 AI 生成，请注意甄别。');
  lines.push('');

  for (const msg of convo.messages || []) {
    if (msg.role === 'user') {
      lines.push('## 用户');
      lines.push('');
      if (msg.content) lines.push(msg.content);
      if (msg.images?.length) lines.push(`\n_[包含 ${msg.images.length} 张图片]_`);
      if (msg.files?.length) {
        lines.push(`\n_附件：${msg.files.map((f) => f.name).join('、')}_`);
      }
      lines.push('');
    } else if (msg.role === 'assistant') {
      lines.push('## 助手');
      lines.push('');
      if (msg.reasoning) {
        lines.push('<details>');
        lines.push('<summary>深度思考</summary>');
        lines.push('');
        lines.push(msg.reasoning);
        lines.push('');
        lines.push('</details>');
        lines.push('');
      }
      if (msg.content) lines.push(msg.content);
      if (msg.sources?.length) {
        lines.push('');
        lines.push('**参考来源**');
        lines.push('');
        msg.sources.forEach((source, i) => {
          if (source.url) lines.push(`${i + 1}. [${source.title || source.url}](${source.url})`);
        });
      }
      if (msg.error) lines.push(`\n> 错误：${msg.error}`);
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }

  return lines.join('\n');
}

async function exportConversation(id) {
  const convo = await loadConversation(id);
  if (!convo) {
    toast('对话不存在');
    return;
  }
  const safeName = (convo.title || 'deepseek-chat').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  download(`${safeName}.md`, conversationToMarkdown(convo));
  toast('已导出 Markdown');
}

async function exportEverything() {
  try {
    const data = await exportAll();
    const date = new Date().toISOString().slice(0, 10);
    download(`deepseek-chat-backup-${date}.json`, JSON.stringify(data, null, 2), 'application/json');
    toast('备份已导出');
  } catch (err) {
    toast(`导出失败：${err.message}`);
  }
}

async function importEverything(file) {
  if (state.streaming) {
    toast('正在生成回答，请先停止后再导入');
    dom.importFile.value = '';
    return;
  }
  try {
    const data = JSON.parse(await file.text());
    const ok = await confirmDialog({
      title: '导入备份',
      message: `将导入 ${data.conversations?.length || 0} 个对话。同 ID 的对话会被覆盖，是否继续？`,
      okText: '导入',
      danger: false,
    });
    if (!ok) return;

    await importAll(data);
    state.settings = await loadSettings();
    state.index = await loadIndex();
    state.thinkingOn = state.settings.thinking;
    state.webOn = state.settings.webSearch;
    applyTheme();
    applyFontSize();
    updateModelUI();
    updateApiNotice();
    updateToggles();
    renderSidebar();
    state.convo = null;
    updateDocumentTitle();
    dom.messages.innerHTML = '';
    dom.welcome.classList.remove('hidden');
    dom.scrollBottom.classList.add('hidden');
    state.stick = true;
    setActiveConversation(null);
    dom.settingsDialog.close();
    toast('导入完成');
  } catch (err) {
    toast(`导入失败：${err.message}`);
  } finally {
    dom.importFile.value = '';
  }
}

async function clearEverything() {
  if (state.streaming) {
    toast('正在生成回答，请先停止后再清空');
    return;
  }
  const ok = await confirmDialog({
    title: '清空全部数据',
    message: '将删除所有对话、设置和 API Key，且无法恢复。确定继续吗？',
    okText: '全部删除',
  });
  if (!ok) return;
  await clearAllData();
  state.settings = await loadSettings();
  state.index = [];
  state.ui = {};
  state.convo = null;
  state.thinkingOn = state.settings.thinking;
  state.webOn = state.settings.webSearch;
  dom.settingsDialog.close();
  newChat({ focus: false });
  applyTheme();
  applyFontSize();
  updateModelUI();
  updateApiNotice();
  updateToggles();
  renderSidebar();
  toast('已清空全部数据');
}

/* ------------------------------------------------------------------ */
/* Event wiring                                                       */
/* ------------------------------------------------------------------ */

function bindEvents() {
  dom.brandLink.addEventListener('click', (e) => {
    e.preventDefault();
    newChat();
  });

  dom.newChatBtn.addEventListener('click', () => newChat());
  dom.collapseBtn.addEventListener('click', () => setSidebarCollapsed(true));
  dom.sidebarToggle.addEventListener('click', toggleSidebar);
  dom.sidebarBackdrop.addEventListener('click', closeMobileSidebar);
  dom.accountBtn.addEventListener('click', () => openSettings('api'));
  dom.settingsBtn.addEventListener('click', () => openSettings('api'));
  dom.themeToggle.addEventListener('click', toggleTheme);

  dom.searchBtn.addEventListener('click', () => {
    if (window.innerWidth <= 900) {
      state.mobileOpen = true;
      applySidebarState();
    } else if (state.collapsed) {
      setSidebarCollapsed(false);
    }
    dom.searchBox.classList.toggle('hidden');
    if (!dom.searchBox.classList.contains('hidden')) {
      dom.conversationSearch.focus();
    } else {
      state.searchTerm = '';
      dom.conversationSearch.value = '';
      renderSidebar();
    }
  });

  dom.searchClose.addEventListener('click', () => {
    dom.searchBox.classList.add('hidden');
    state.searchTerm = '';
    dom.conversationSearch.value = '';
    renderSidebar();
  });

  dom.conversationSearch.addEventListener('input', () => {
    state.searchTerm = dom.conversationSearch.value;
    renderSidebar();
  });

  dom.conversationList.addEventListener('click', (e) => {
    const more = e.target.closest('.conv-more');
    const row = e.target.closest('.conv-item');
    if (!row) return;
    if (more) {
      e.stopPropagation();
      openConversationMenu(row.dataset.id, more);
      return;
    }
    openConversation(row.dataset.id);
  });

  dom.conversationList.addEventListener('keydown', (e) => {
    if (e.target.closest('.conv-more')) return;
    const row = e.target.closest('.conv-item');
    if (!row) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openConversation(row.dataset.id);
    }
  });

  dom.conversationList.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.conv-item');
    if (!row) return;
    e.preventDefault();
    openConversationMenu(row.dataset.id, row.querySelector('.conv-more'));
  });

  dom.modelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (dom.modelMenu.classList.contains('hidden')) openModelMenu();
    else closeModelMenu();
  });

  dom.composer.addEventListener('input', () => {
    autosize();
    updateSendButton();
  });

  dom.composer.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    const sendKey = state.settings.sendOnEnter
      ? e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
      : e.key === 'Enter' && (e.ctrlKey || e.metaKey);
    if (sendKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  dom.composer.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length && e.clipboardData?.items) {
      for (const item of e.clipboardData.items) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
    }
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });

  dom.sendBtn.addEventListener('click', sendMessage);

  dom.thinkingToggle.addEventListener('click', () => {
    state.thinkingOn = !state.thinkingOn;
    updateToggles();
    toast(state.thinkingOn ? '已开启深度思考' : '已关闭深度思考');
  });

  dom.searchToggle.addEventListener('click', () => {
    state.webOn = !state.webOn;
    updateToggles();
    toast(
      state.webOn
        ? '已开启联网搜索：将调用 DeepSeek 云端搜索 / 抓取（按次计费）'
        : '已关闭联网搜索'
    );
  });

  dom.fileInput.addEventListener('change', () => {
    addFiles(dom.fileInput.files);
    dom.fileInput.value = '';
  });

  dom.attachments.addEventListener('click', (e) => {
    const remove = e.target.closest('.remove');
    if (remove) {
      const id = remove.closest('.attachment')?.dataset.id;
      state.attachments = state.attachments.filter((a) => a.id !== id);
      renderAttachments();
      return;
    }
    const img = e.target.closest('img');
    if (img) openLightbox(img.src);
  });

  dom.suggestions.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-prompt]');
    if (!btn) return;
    dom.composer.value = btn.dataset.prompt;
    if (btn.dataset.search) {
      state.webOn = true;
      updateToggles();
    }
    if (btn.dataset.attach) {
      state.thinkingOn = state.settings.thinking;
      updateToggles();
      dom.fileInput.click();
    }
    autosize();
    updateSendButton();
    dom.composer.focus();
  });

  dom.noticeSettings.addEventListener('click', () => openSettings('api'));

  dom.messages.addEventListener('click', (e) => {
    const thinkingToggle = e.target.closest('.thinking-toggle');
    if (thinkingToggle) {
      const box = thinkingToggle.closest('.thinking');
      box.classList.toggle('open');
      const open = box.classList.contains('open');
      thinkingToggle.setAttribute('aria-expanded', String(open));
      if (state.streaming && state.streaming.el === box.closest('.msg')) {
        state.streaming.thinkingTouched = true;
      }
      return;
    }

    const sourcesHead = e.target.closest('.sources-head');
    if (sourcesHead) {
      const box = sourcesHead.closest('.sources');
      box.classList.toggle('open');
      sourcesHead.setAttribute('aria-expanded', String(box.classList.contains('open')));
      return;
    }

    const toolHead = e.target.closest('.tool-head');
    if (toolHead) {
      const panel = toolHead.closest('.tool-panel');
      panel.classList.toggle('open');
      toolHead.setAttribute('aria-expanded', String(panel.classList.contains('open')));
      return;
    }

    const retry = e.target.closest('.retry-btn');
    if (retry) {
      const msgEl = retry.closest('.msg');
      if (msgEl?.dataset.id) regenerate(msgEl.dataset.id);
      return;
    }

    const action = e.target.closest('.msg-actions button[data-act], .user-actions button[data-act]');
    if (action) {
      const msgEl = action.closest('.msg');
      const msg = state.convo?.messages.find((m) => m.id === msgEl?.dataset.id);
      const act = action.dataset.act;
      if (act === 'copy' && msg) copyMessage(msg);
      if (act === 'regen' && msg) regenerate(msg.id);
      if (act === 'edit' && msg) editUserMessage(msg.id);
      return;
    }
  });

  dom.messages.addEventListener('click', (e) => {
    const img = e.target.closest('img');
    if (!img) return;
    if (!img.closest('.md-body, .bubble-images')) return;
    openLightbox(img.src);
  });

  dom.chatScroll.addEventListener('scroll', updateScrollState);

  dom.scrollBottom.addEventListener('click', () => {
    state.stick = true;
    dom.chatScroll.scrollTo({ top: dom.chatScroll.scrollHeight, behavior: 'smooth' });
  });

  // Drag & drop
  document.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    state.dragDepth += 1;
    dom.dropOverlay.classList.remove('hidden');
  });
  document.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
  });
  document.addEventListener('dragleave', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (state.dragDepth === 0) dom.dropOverlay.classList.add('hidden');
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    state.dragDepth = 0;
    dom.dropOverlay.classList.add('hidden');
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });

  // Settings dialog
  dom.settingsClose.addEventListener('click', () => dom.settingsDialog.close());
  dom.settingsCancel.addEventListener('click', () => dom.settingsDialog.close());
  dom.settingsSave.addEventListener('click', saveSettingsFromForm);
  dom.settingsNav.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (btn) showSettingsTab(btn.dataset.tab);
  });
  dom.settingsDialog.addEventListener('click', (e) => {
    if (e.target === dom.settingsDialog) dom.settingsDialog.close();
  });
  dom.settingsDialog.addEventListener('close', () => {
    applyTheme();
    dom.testResult.textContent = '';
    dom.testResult.className = 'test-result';
    dom.testSearchResult.textContent = '';
    dom.testSearchResult.className = 'test-result';
  });

  dom.toggleKey.addEventListener('click', () => {
    state.keyVisible = !state.keyVisible;
    dom.setApiKey.type = state.keyVisible ? 'text' : 'password';
    dom.toggleKey.textContent = state.keyVisible ? '隐藏' : '显示';
  });

  dom.settingsDialog.addEventListener('click', (e) => {
    const baseBtn = e.target.closest('[data-base]');
    if (baseBtn) dom.setBaseUrl.value = baseBtn.dataset.base;
    const modelBtn = e.target.closest('[data-model]');
    if (modelBtn) dom.setModel.value = modelBtn.dataset.model;
  });

  dom.resetPrompt.addEventListener('click', () => {
    dom.setSystemPrompt.value = DEFAULT_SYSTEM_PROMPT;
  });

  dom.testConnection.addEventListener('click', testConnection);
  dom.testSearch.addEventListener('click', testWebSearch);

  dom.setTheme.addEventListener('change', () => {
    applyTheme(dom.setTheme.value);
  });

  // Data
  dom.exportData.addEventListener('click', exportEverything);
  dom.importData.addEventListener('click', () => dom.importFile.click());
  dom.importFile.addEventListener('change', () => {
    const file = dom.importFile.files?.[0];
    if (file) importEverything(file);
  });
  dom.clearData.addEventListener('click', clearEverything);

  // Rename dialog
  dom.renameCancel.addEventListener('click', () => {
    state.renameTarget = null;
    dom.renameDialog.close();
  });
  dom.renameSave.addEventListener('click', saveRename);
  dom.renameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveRename();
    }
  });

  // Confirm dialog
  dom.confirmCancel.addEventListener('click', () => {
    dom.confirmDialog.returnValue = 'cancel';
    dom.confirmDialog.close();
  });
  dom.confirmOk.addEventListener('click', () => {
    dom.confirmDialog.returnValue = 'ok';
    dom.confirmDialog.close();
  });
  dom.confirmDialog.addEventListener('click', (e) => {
    if (e.target === dom.confirmDialog) {
      dom.confirmDialog.returnValue = 'cancel';
      dom.confirmDialog.close();
    }
  });

  // Lightbox
  dom.lightboxClose.addEventListener('click', closeLightbox);
  dom.lightbox.addEventListener('click', (e) => {
    if (e.target === dom.lightbox) closeLightbox();
  });

  // Global keys / click-away
  document.addEventListener('click', (e) => {
    if (state.menuEl && !state.menuEl.contains(e.target)) closeConversationMenu();
    if (!dom.modelMenu.classList.contains('hidden')) {
      if (!dom.modelMenu.contains(e.target) && !dom.modelBtn.contains(e.target)) closeModelMenu();
    }
  });

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (window.innerWidth <= 900) {
        state.mobileOpen = true;
        applySidebarState();
      } else if (state.collapsed) {
        setSidebarCollapsed(false);
      }
      dom.searchBox.classList.remove('hidden');
      dom.conversationSearch.focus();
      return;
    }
    if ((mod && e.shiftKey && e.key.toLowerCase() === 'o') || (e.altKey && !mod && e.key.toLowerCase() === 'n')) {
      e.preventDefault();
      newChat();
      return;
    }
    if (e.key === 'Escape') {
      closeConversationMenu();
      closeModelMenu();
      closeLightbox();
      if (!dom.searchBox.classList.contains('hidden')) {
        dom.searchBox.classList.add('hidden');
        state.searchTerm = '';
        dom.conversationSearch.value = '';
        renderSidebar();
      }
      if (state.mobileOpen) closeMobileSidebar();
    }
  });

  window.addEventListener('resize', () => {
    applySidebarState();
    updateScrollBottomPosition();
    updateScrollState();
  });

  window
    .matchMedia?.('(prefers-color-scheme: dark)')
    ?.addEventListener?.('change', () => {
      if (state.settings?.theme === 'auto' && !dom.settingsDialog.open) applyTheme();
    });

  window.addEventListener('beforeunload', () => {
    if (state.streaming) {
      try {
        state.streaming.controller.abort();
      } catch (_) {
        /* ignore */
      }
    }
  });
}

async function copyMessage(msg) {
  const text = msg.content || '';
  if (!text) {
    toast('没有可复制的内容');
    return;
  }
  try {
    await copyText(text);
    toast('已复制');
  } catch (_) {
    toast('复制失败');
  }
}

function openLightbox(src) {
  dom.lightboxImg.src = src;
  dom.lightbox.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  dom.lightbox.classList.add('hidden');
  dom.lightboxImg.removeAttribute('src');
  document.body.style.overflow = '';
}

/* ------------------------------------------------------------------ */
/* Init                                                               */
/* ------------------------------------------------------------------ */

function applyPromptToComposer(text) {
  dom.composer.value = text;
  autosize();
  updateSendButton();
  dom.composer.focus();
  dom.composer.setSelectionRange(text.length, text.length);
}

async function init() {
  cacheDom();
  hydrateIcons();

  state.settings = await loadSettings();
  state.index = await loadIndex();
  const ui = await loadUiState();
  state.ui = ui && typeof ui === 'object' && !Array.isArray(ui) ? ui : {};
  state.thinkingOn = state.settings.thinking;
  state.webOn = state.settings.webSearch;
  state.collapsed = !!state.ui.sidebarCollapsed;

  applyTheme();
  applyFontSize();
  updateModelUI();
  updateToggles();
  updateApiNotice();
  setStreamingUI(false);
  renderAttachments();
  updateScrollBottomPosition();

  bindEvents();
  renderSidebar();
  applySidebarState();

  const params = new URLSearchParams(location.search);
  const openId = params.get('c') || state.ui.activeId;
  if (openId) {
    const convo = await loadConversation(openId);
    if (convo) {
      state.convo = convo;
      dom.welcome.classList.add('hidden');
      renderMessages();
      requestAnimationFrame(() => scrollToBottom(true, true));
    } else {
      state.ui.activeId = null;
      saveUiState(state.ui).catch(() => {});
      dom.welcome.classList.remove('hidden');
    }
  } else {
    dom.welcome.classList.remove('hidden');
  }
  updateDocumentTitle();
  renderSidebar();

  const pending = await getSessionItem('pendingPrompt');
  if (pending) {
    await removeSessionItem('pendingPrompt');
    applyPromptToComposer(String(pending));
  } else if (params.get('q')) {
    applyPromptToComposer(params.get('q'));
    params.delete('q');
    const nextUrl = `${location.pathname}${params.toString() ? `?${params}` : ''}`;
    history.replaceState(null, '', nextUrl);
  } else if (window.innerWidth > 900) {
    dom.composer.focus();
  }

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type !== 'deepseek:pending-prompt') return;
      (async () => {
        const text = await getSessionItem('pendingPrompt');
        if (!text) return;
        await removeSessionItem('pendingPrompt');
        applyPromptToComposer(String(text));
      })();
    });

    // Catch a prompt that arrived while init was still running.
    const latePrompt = await getSessionItem('pendingPrompt');
    if (latePrompt) {
      await removeSessionItem('pendingPrompt');
      applyPromptToComposer(String(latePrompt));
    }
  }

  if (!state.settings.apiKey && !state.ui.onboarded) {
    state.ui.onboarded = true;
    await saveUiState(state.ui);
    openSettings('api');
  }

  document.body.classList.add('ready');
}

function fatal(err) {
  console.error(err);
  document.body.innerHTML = `<pre style="padding:24px;color:#d93843;white-space:pre-wrap">初始化失败：${String(
    err?.stack || err
  )}</pre>`;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => init().catch(fatal), { once: true });
} else {
  // Module scripts are deferred, so the DOM is already parsed here.
  init().catch(fatal);
}
