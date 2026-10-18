/**
 * Local mock of the DeepSeek API for UI development. Not part of the extension.
 * Start: node test/mock-server.mjs
 */
import http from 'node:http';

const PORT = Number(process.env.PORT || 8766);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function json(res, status, data) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function sse(res) {
  cors(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

function chunk(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function sendText(res, text, { delay = 18 } = {}) {
  const pieces = String(text).match(/[\s\S]{1,3}/g) || [];
  for (const piece of pieces) {
    chunk(res, { choices: [{ index: 0, delta: { content: piece } }] });
    await sleep(delay);
  }
}

async function sendReasoning(res, text) {
  const pieces = String(text).match(/[\s\S]{1,5}/g) || [];
  for (const piece of pieces) {
    chunk(res, { choices: [{ index: 0, delta: { reasoning_content: piece } }] });
    await sleep(12);
  }
}

const SEARCH_RESULTS = [
  {
    rerank_score: 2.8,
    title: 'DeepSeek 发布 V4.1 Flash：原生多模态与更强推理',
    url: 'https://api-docs.deepseek.com/news/news260910/',
    snippet: 'DeepSeek-V4.1-Flash 发布，支持原生视觉理解，API 模型名为 deepseek-flash。',
    summary:
      'DeepSeek 发布 V4.1-Flash，这是新架构家族中最小的一款模型，原生支持视觉理解，并已在 DeepSeek API 上线。模型名称为 deepseek-flash，旧的 deepseek-v4-flash 与 deepseek-v4-flash-vision-exp 暂时兼容路由。上下文窗口达到 1M tokens。',
    site_name: 'DeepSeek API Docs',
    site_icon: '',
    date: '2026-09-10T00:00:00+00:00',
    authority: 4,
  },
  {
    rerank_score: 2.1,
    title: 'DeepSeek V4.1 Flash 模型卡',
    url: 'https://build.nvidia.com/deepseek-ai/deepseek-v4.1-flash/modelcard',
    snippet: 'DeepSeek-V4.1-Flash is a multimodal MoE model accepting text and images.',
    summary:
      'DeepSeek-V4.1-Flash 是 DeepSeek-AI 的多模态 MoE 模型，接受文本和图像输入，支持最高一百万 token 的组合上下文，并支持连续可调的 reasoning effort。',
    site_name: 'NVIDIA Build',
    site_icon: '',
    date: '2026-09-18T00:00:00+00:00',
    authority: 3,
  },
  {
    rerank_score: 1.8,
    title: 'DeepSeek 开放平台价格',
    url: 'https://api-docs.deepseek.com/quick_start/pricing',
    snippet: 'deepseek-flash 每百万输入 token $0.15 起。',
    summary:
      'DeepSeek 官方定价页列出了 deepseek-flash 的输入、缓存与输出价格，并说明了高峰与非高峰时段的差异。',
    site_name: 'DeepSeek API Docs',
    site_icon: '',
    date: '2026-10-01T00:00:00+00:00',
    authority: 4,
  },
];

function finalAnswer(question) {
  return `你问的是「${question}」。我刚刚通过 DeepSeek 云端搜索查到了最新资料，可以给你一个简要总结。

## 关键结论

1. **deepseek-flash 已支持原生多模态**：可以直接理解 JPEG、PNG、GIF 和 WebP 图片[1]。
2. **上下文窗口达到 1M tokens**：适合长文档、代码库和多轮对话[2]。
3. **价格仍然很有竞争力**：非高峰时段输入约 $0.15 / 百万 tokens[3]。

## 一个代码示例

\`\`\`python
from openai import OpenAI

client = OpenAI(
    api_key="sk-...",
    base_url="https://api.deepseek.com",
)

response = client.chat.completions.create(
    model="deepseek-flash",
    messages=[{"role": "user", "content": "你好！"}],
)
print(response.choices[0].message.content)
\`\`\`

## 模型对比

| 模型 | 多模态 | 上下文 | 适用场景 |
| --- | :---: | ---: | --- |
| deepseek-flash | ✅ | 1M | 日常对话、代码、视觉 |
| deepseek-v4-pro | — | 1M | 更复杂的推理 |

> 提示：开启「联网搜索」后，回答会先调用云端搜索，再基于搜索结果生成。

## 公式渲染测试

质能方程：$$E = mc^2$$

行内公式：\\(a^2 + b^2 = c^2\\)，价格仍然是 $0.15 / 百万 tokens。

如果想深入了解，可以继续问我。`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === '/models' && req.method === 'GET') {
    json(res, 200, {
      object: 'list',
      data: [
        { id: 'deepseek-flash', object: 'model', owned_by: 'deepseek' },
        { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' },
      ],
    });
    return;
  }

  if (url.pathname === '/v1/tools/search' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    await sleep(500);
    json(res, 200, { results: SEARCH_RESULTS });
    return;
  }

  if (url.pathname === '/v1/tools/fetch' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    await sleep(400);
    json(res, 200, {
      title: 'DeepSeek V4.1 Flash 发布公告',
      content: `# DeepSeek V4.1 Flash\n\n来源：${body.url}\n\nDeepSeek-V4.1-Flash 原生支持图像理解，模型 API 名称是 deepseek-flash。上下文长度 1,048,576 tokens，最大输出 393,216 tokens。`,
    });
    return;
  }

  if (url.pathname === '/chat/completions' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const messages = body.messages || [];
    const last = messages[messages.length - 1] || {};
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const question = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
    const questionText =
      typeof question === 'string'
        ? question
        : question.find?.((part) => part.type === 'text')?.text || '这张图片';

    sse(res);

    // Simulate hitting the max_tokens limit.
    if (last.role === 'user' && questionText.includes('LENGTHTEST')) {
      await sendText(res, '这是一段因为达到最大输出长度而被截断的回答。', { delay: 2 });
      chunk(res, { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] });
      chunk(res, {
        choices: [],
        usage: {
          prompt_tokens: 300,
          completion_tokens: 64,
          total_tokens: 364,
          prompt_cache_hit_tokens: 128,
          prompt_cache_miss_tokens: 172,
        },
      });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Simulate a model that emits a textual tool call instead of structured
    // tool_calls. Used to exercise the app's raw-call recovery.
    if (last.role === 'user' && questionText.includes('RAWTOOL')) {
      await sendText(
        res,
        '正在为你查找资料。\n<tool_call>{"name":"web_search","arguments":{"query":"硬膜外血肿","count":3}}</tool_call>',
        { delay: 2 }
      );
      chunk(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      chunk(res, {
        choices: [],
        usage: {
          prompt_tokens: 320,
          completion_tokens: 24,
          total_tokens: 344,
          prompt_cache_hit_tokens: 128,
          prompt_cache_miss_tokens: 192,
        },
      });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (hasTools && last.role === 'user' && !questionText.includes('不要搜索')) {
      chunk(res, {
        choices: [
          { index: 0, delta: { role: 'assistant', reasoning_content: '' } },
        ],
      });
      await sendReasoning(
        res,
        '用户想要了解最新的 DeepSeek 模型信息，这属于可能随时间变化的内容。我应该先调用联网搜索，获取官方文档和最新公告，然后再整理答案。'
      );

      const args = JSON.stringify({ query: 'DeepSeek deepseek-flash 最新发布', count: 8 });
      chunk(res, {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_mock_1',
                  type: 'function',
                  function: { name: 'web_search', arguments: '' },
                },
              ],
            },
          },
        ],
      });
      for (const part of args.match(/[\s\S]{1,8}/g) || []) {
        chunk(res, {
          choices: [
            { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: part } }] } },
          ],
        });
        await sleep(20);
      }
      chunk(res, {
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      });
      chunk(res, {
        choices: [],
        usage: {
          prompt_tokens: 1280,
          completion_tokens: 96,
          total_tokens: 1376,
          prompt_cache_hit_tokens: 0,
          prompt_cache_miss_tokens: 1280,
        },
      });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Final response (after tool result, or no tools)
    await sendReasoning(
      res,
      '搜索结果已经返回，包含官方发布公告、模型卡和价格页。我需要用简洁的结构总结，并在引用处标上序号。'
    );
    await sendText(res, finalAnswer(typeof questionText === 'string' ? questionText.slice(0, 40) : '这张图片'), {
      delay: 8,
    });
    chunk(res, {
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    });
    chunk(res, {
      choices: [],
      usage: {
        prompt_tokens: 2860,
        completion_tokens: 420,
        total_tokens: 3280,
        prompt_cache_hit_tokens: 2200,
        prompt_cache_miss_tokens: 660,
      },
    });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  json(res, 404, { error: { message: `Mock route not found: ${req.method} ${url.pathname}` } });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mock DeepSeek API listening on http://127.0.0.1:${PORT}`);
});
