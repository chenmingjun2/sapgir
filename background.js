/**
 * Service worker: opens/focuses the chat tab and provides quick actions
 * from the context menu.
 */
const APP_URL = chrome.runtime.getURL('app.html');

async function openApp({ query = '', prompt = '' } = {}) {
  if (prompt) {
    await chrome.storage.session.set({ 'dsv2.pendingPrompt': prompt });
  }

  const { appTabId } = await chrome.storage.session.get('appTabId');
  if (appTabId != null) {
    try {
      const tab = await chrome.tabs.get(appTabId);
      if (tab.url && !tab.url.startsWith(APP_URL)) {
        throw new Error('The remembered tab is no longer the app');
      }
      // Only navigate when an explicit query is provided; otherwise just focus
      // the existing tab so an in-progress conversation is not reloaded.
      await chrome.tabs.update(tab.id, query ? { active: true, url: APP_URL + query } : { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      if (prompt) {
        try {
          // Extension pages receive runtime messages, not tabs.sendMessage
          // (which targets content scripts).
          await chrome.runtime.sendMessage({ type: 'deepseek:pending-prompt' });
        } catch (_) {
          // The page may still be loading; it will pick the prompt up on init.
        }
      }
      return;
    } catch (_) {
      // Tab is gone; fall through and create a new one.
    }
  }

  const tab = await chrome.tabs.create({ url: APP_URL + query });
  await chrome.storage.session.set({ appTabId: tab.id });
}

chrome.action.onClicked.addListener(() => {
  openApp();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'open-app',
      title: '打开 Sapgir',
      contexts: ['page', 'action'],
    });
    chrome.contextMenus.create({
      id: 'ask-selection',
      title: '用 AI 解释“%s”',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: 'summarize-page',
      title: '用 AI 总结此页面',
      contexts: ['page'],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'ask-selection' && info.selectionText) {
    const text = info.selectionText.trim().slice(0, 12000);
    await openApp({ prompt: `请解释下面的内容：\n\n> ${text.replace(/\n/g, '\n> ')}` });
    return;
  }

  if (info.menuItemId === 'summarize-page' && tab?.id != null) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const clone = document.body?.cloneNode(true);
          if (!clone) return '';
          clone.querySelectorAll('script, style, noscript, svg').forEach((el) => el.remove());
          return (clone.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 24000);
        },
      });
      const pageText = (result || '').slice(0, 24000);
      await openApp({
        prompt: `请总结这个网页的主要内容，并列出关键要点：\n\n来源：${tab.url || ''}\n\n${pageText}`,
      });
    } catch (err) {
      await openApp({ prompt: `请帮我总结这个网页：${tab.url || ''}` });
    }
    return;
  }

  await openApp();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { appTabId } = await chrome.storage.session.get('appTabId');
  if (tabId === appTabId) {
    await chrome.storage.session.remove('appTabId');
  }
});
