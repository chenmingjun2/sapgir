/**
 * A deliberately CORS-less mock, used to verify that extension pages can call
 * cross-origin APIs via host permissions.
 */
import http from 'node:http';

const PORT = 8767;

const server = http.createServer(async (req, res) => {
  if (req.url === '/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'deepseek-flash' }] }));
    return;
  }

  if (req.url === '/chat/completions') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const text = '跨域请求成功：扩展页面没有受到 CORS 限制，可以直接流式调用 DeepSeek API。';
    for (const piece of text.match(/[\s\S]{1,4}/g)) {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece } }] })}\n\n`);
      await new Promise((r) => setTimeout(r, 15));
    }
    res.write(
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`
    );
    res.write(
      `data: ${JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      })}\n\n`
    );
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`No-CORS mock on http://127.0.0.1:${PORT}`);
});
