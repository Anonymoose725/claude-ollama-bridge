const http = require('http');

const PORT = 8000;
const LOCAL_MODEL = 'qwen3.5:9b';

const server = http.createServer((req, res) => {
  let targetPath = req.url.split('?')[0];
  if (targetPath === '/v1/messages') {
    targetPath = '/v1/chat/completions';
  }

  const options = {
    hostname: '127.0.0.1',
    port: 11434,
    path: targetPath,
    method: req.method,
    headers: { ...req.headers, host: '127.0.0.1:11434' }
  };

  delete options.headers['anthropic-beta'];

  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        let json = JSON.parse(body);
        json.model = LOCAL_MODEL;
        
        // Force streaming configurations to align natively
        const isStreaming = json.stream !== false;
        
        const modifiedBody = JSON.stringify(json);
        options.headers['content-length'] = Buffer.byteLength(modifiedBody);

        const proxyReq = http.request(options, (proxyRes) => {
          // If Claude Code expects an Anthropic stream, intercept and rewrite the format
          if (isStreaming) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive'
            });

            // Send initial Anthropic message start metadata packet
            res.write(`event: message_start\ndata: {"type":"message_start","message":{"id":"msg_local","type":"message","role":"assistant","content":[],"model":"${LOCAL_MODEL}","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}\n\n`);
            res.write(`event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`);

            let buffer = '';
            proxyRes.on('data', chunk => {
              buffer += chunk.toString();
              const lines = buffer.split('\n');
              buffer = lines.pop(); // Keep incomplete lines in buffer

              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const dataStr = line.slice(6).trim();
                  if (dataStr === '[DONE]') continue;
                  try {
                    const openAiJson = JSON.parse(dataStr);
                    const textDelta = openAiJson.choices?.[0]?.delta?.content;
                    if (textDelta) {
                      // Format text pieces exactly how Claude Code expects them
                      res.write(`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(textDelta)}}}\n\n`);
                    }
                  } catch (e) {}
                }
              }
            });

            proxyRes.on('end', () => {
              res.write(`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`);
              res.write(`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":0}}\n\n`);
              res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
              res.end();
            });

          } else {
            // Handle non-streaming fallback responses cleanly
            let responseBody = '';
            proxyRes.on('data', c => { responseBody += c; });
            proxyRes.on('end', () => {
              try {
                const openAiJson = JSON.parse(responseBody);
                const textContent = openAiJson.choices?.[0]?.message?.content || '';
                const anthropicJson = {
                  id: "msg_local",
                  type: "message",
                  role: "assistant",
                  content: [{ type: "text", text: textContent }],
                  model: LOCAL_MODEL,
                  stop_reason: "end_turn",
                  stop_sequence: null,
                  usage: { input_tokens: 0, output_tokens: 0 }
                };
                const outputStr = JSON.stringify(anthropicJson);
                res.writeHead(200, {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(outputStr)
                });
                res.end(outputStr);
              } catch (e) {
                res.writeHead(proxyRes.statusCode, proxyRes.headers);
                res.end(responseBody);
              }
            });
          }
        });

        proxyReq.on('error', (err) => {
          res.writeHead(500);
          res.end('Bridge stream connection failure: ' + err.message);
        });

        proxyReq.write(modifiedBody);
        proxyReq.end();
      } catch (e) {
        // Fallback catch-all routing pass
        const proxyReq = http.request(options, (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
        });
        proxyReq.write(body);
        proxyReq.end();
      }
    });
  } else {
    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    req.pipe(proxyReq);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`!! Bidirectional Claude-Ollama Translator active on port ${PORT}`);
});
