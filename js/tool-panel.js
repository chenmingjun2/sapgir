/**
 * Search/source panel rendering. These helpers are pure DOM renderers: the
 * turn lifecycle lives in app.js.
 */

import { icon } from './icons.js';
import { hostOf } from './http.js';

function safeHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || '')) ? String(url) : '';
}

export function renderSources(el, sources) {
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
    const host = source.site || hostOf(source.url);
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
  return name === 'web_search' ? '联网搜索' : name || '工具';
}

export function renderToolPanel(el, entries, { open = false, sources = [] } = {}) {
  const panel = el.querySelector('.tool-panel');
  if (!panel) return;
  const wasOpen = panel.classList.contains('open');
  const list = (entries || []).filter(Boolean);
  if (!list.length) {
    panel.classList.add('hidden');
    panel.classList.remove('open');
    return;
  }
  panel.classList.remove('hidden');

  const searches = list.filter((e) => e.name === 'web_search');
  const running = list.some((e) => e.status === 'running');
  const pageCount = new Set((sources || []).map((s) => s.url).filter(Boolean)).size;

  let summary;
  if (running) {
    summary = '正在使用服务端搜索…';
  } else {
    const bits = [];
    if (searches.length) bits.push(`${searches.length} 次搜索`);
    if (pageCount) bits.push(`${pageCount} 个来源`);
    summary = bits.length ? bits.join(' · ') : '联网工具';
  }

  const head = `
    <button class="tool-head" type="button" aria-expanded="${open ? 'true' : 'false'}">
      ${running ? '<span class="spinner"></span>' : `<span class="tool-icon">${icon('globe', 14)}</span>`}
      <span class="tool-summary"></span>
      <span class="tool-chev">${icon('chevronDown', 14)}</span>
    </button>
    <div class="tool-body"></div>`;

  panel.innerHTML = head;
  panel.querySelector('.tool-summary').textContent = summary;

  const body = panel.querySelector('.tool-body');

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
      label.textContent = `搜索：${entry.args?.query || ''}`;
    } else {
      label.textContent = toolNameLabel(entry.name);
    }
    headLine.appendChild(label);

    if (entry.provider) {
      const provider = document.createElement('span');
      provider.className = 'badge provider-badge';
      provider.textContent = entry.provider === 'messages' ? '服务端搜索' : entry.provider;
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
