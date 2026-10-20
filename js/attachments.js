/**
 * Attachment intake and preview. The module keeps a single app context so the
 * call sites stay as simple as before the extraction.
 */

import { icon } from './icons.js';

const MAX_ATTACHMENTS = 6;
const MAX_IMAGE_DIM = 1600;
const MAX_TEXT_CHARS = 150000;
const TEXT_EXTENSIONS = [
  'txt', 'md', 'markdown', 'csv', 'json', 'log', 'yaml', 'yml', 'xml', 'html',
  'css', 'js', 'ts', 'jsx', 'tsx', 'py', 'go', 'java', 'c', 'cpp', 'h', 'rs',
  'sql', 'sh', 'toml', 'ini', 'env', 'gitignore',
];

let ctx = null;

export function initAttachments(context) {
  ctx = context;
}

function app() {
  if (!ctx) throw new Error('attachments module is not initialized');
  return ctx;
}

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
  const canvasCtx = canvas.getContext('2d');
  canvasCtx.fillStyle = '#ffffff';
  canvasCtx.fillRect(0, 0, canvas.width, canvas.height);
  canvasCtx.drawImage(img, 0, 0, canvas.width, canvas.height);
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

export async function addFiles(fileList) {
  const { state, dom, toast, uid } = app();
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
  app().updateSendButton();
  dom.composer.focus();
}

export function renderAttachments() {
  const { state, dom, updateSendButton, updateScrollBottomPosition } = app();
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
