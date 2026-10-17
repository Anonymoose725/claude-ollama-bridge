// Claude Code (Anthropic Messages API) -> Ollama (native /api/chat) bridge.
// Translates system prompt, messages, tool definitions, tool calls and tool results in both directions.
//
// Env vars:
//   LOCAL_MODEL   model name in Ollama            (default qwen3.5:9b)
//   NUM_CTX       context window sent to Ollama   (default 16384)
//   ALLOWED_TOOLS comma list of Claude Code tools to expose, or "all"
//                                                 (default Read,Write,Edit,Bash,Glob,Grep)
//   THINK         "1" to let the model think      (default off: much faster)
//   DEBUG         "1" to log requests/responses

const http = require('http');
const crypto = require('crypto');

const PORT = 8000;
const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;
const LOCAL_MODEL = process.env.LOCAL_MODEL || 'qwen3.5:9b';
const NUM_CTX = parseInt(process.env.NUM_CTX || '16384', 10);
const THINK = process.env.THINK === '1';
const DEBUG = process.env.DEBUG === '1';
const ALLOWED_RAW = process.env.ALLOWED_TOOLS || 'Read,Write,Edit,Bash,Glob,Grep';
const ALLOWED_TOOLS = ALLOWED_RAW === 'all' ? null : new Set(ALLOWED_RAW.split(',').map(s => s.trim()));
const MAX_TOOL_DESC = 1500;

const log = (...a) => DEBUG && console.log(...a);
const newId = (p) => p + crypto.randomBytes(12).toString('hex');

function textOf(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(b => (b.type === 'text' ? b.text : b.type === 'image' ? '[image omitted]' : '')).join('\n');
    }
    return '';
}

function convertSystem(system) {
    if (typeof system === 'string') return system;
    if (Array.isArray(system)) {
        return system
            .map(b => b.text || '')
            .filter(t => t && !t.startsWith('x-anthropic-billing-header'))
            .join('\n\n');
    }
    return '';
}

function convertMessages(system, messages) {
    const out = [];
    const sys = convertSystem(system);
    if (sys) out.push({ role: 'system', content: sys });

    const idToName = {};
    for (const m of messages) {
        if (typeof m.content === 'string') {
            out.push({ role: m.role, content: m.content });
            continue;
        }
        if (m.role === 'assistant') {
            let text = '';
            const tool_calls = [];
            for (const b of m.content) {
                if (b.type === 'text') text += b.text;
                else if (b.type === 'tool_use') {
                    idToName[b.id] = b.name;
                    tool_calls.push({ function: { name: b.name, arguments: b.input || {} } });
                }
                // thinking / redacted_thinking blocks are dropped
            }
            const msg = { role: 'assistant', content: text };
            if (tool_calls.length) msg.tool_calls = tool_calls;
            out.push(msg);
        } else {
            let text = '';
            for (const b of m.content) {
                if (b.type === 'tool_result') {
                    const body = textOf(b.content);
                    out.push({
                        role: 'tool',
                        tool_name: idToName[b.tool_use_id] || 'tool',
                        content: b.is_error ? 'Error: ' + body : body
                    });
                } else if (b.type === 'text') {
                    text += (text ? '\n' : '') + b.text;
                } else if (b.type === 'image') {
                    text += (text ? '\n' : '') + '[image omitted]';
                }
            }
            if (text) out.push({ role: 'user', content: text });
        }
    }
    return out;
}

function convertTools(tools) {
    if (!Array.isArray(tools) || !tools.length) return undefined;
    const filtered = tools.filter(t => !ALLOWED_TOOLS || ALLOWED_TOOLS.has(t.name));
    if (!filtered.length) return undefined;
    return filtered.map(t => ({
        type: 'function',
        function: {
            name: t.name,
            description: (t.description || '').slice(0, MAX_TOOL_DESC),
            parameters: t.input_schema || { type: 'object', properties: {} }
        }
    }));
}

function buildOllamaBody(json, stream) {
    const body = {
        model: LOCAL_MODEL,
        messages: convertMessages(json.system, json.messages || []),
        stream,
        think: THINK,
        options: { num_ctx: NUM_CTX }
    };
    const tools = convertTools(json.tools);
    if (tools) body.tools = tools;
    if (typeof json.temperature === 'number') body.options.temperature = json.temperature;
    if (json.max_tokens) body.options.num_predict = json.max_tokens;
    return body;
}

function readBody(req) {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', c => { data += c; });
        req.on('end', () => resolve(data));
    });
}

function sendJson(res, status, obj) {
    const s = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
    res.end(s);
}

function argsToString(args) {
    if (typeof args === 'string') return args;
    return JSON.stringify(args || {});
}

function callOllama(body, onResponse, onError) {
    const payload = JSON.stringify(body);
    const req = http.request({
        hostname: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: '/api/chat',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, onResponse);
    req.on('error', onError);
    req.write(payload);
    req.end();
    return req;
}

function handleStreaming(json, res) {
    const body = buildOllamaBody(json, true);
    log('OLLAMA REQUEST: messages=%d tools=%d', body.messages.length, body.tools ? body.tools.length : 0);

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    send('message_start', {
        type: 'message_start',
        message: {
            id: newId('msg_'), type: 'message', role: 'assistant', content: [],
            model: LOCAL_MODEL, stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
        }
    });

    // Keep the client from timing out during long prompt processing
    const ping = setInterval(() => send('ping', { type: 'ping' }), 5000);

    let index = -1;
    let textOpen = false;
    let sawTool = false;
    let finished = false;

    const closeText = () => {
        if (textOpen) {
            send('content_block_stop', { type: 'content_block_stop', index });
            textOpen = false;
        }
    };

    const finish = (j) => {
        if (finished) return;
        finished = true;
        clearInterval(ping);
        closeText();
        const stop = sawTool ? 'tool_use' : (j && j.done_reason === 'length' ? 'max_tokens' : 'end_turn');
        send('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: stop, stop_sequence: null },
            usage: { input_tokens: (j && j.prompt_eval_count) || 0, output_tokens: (j && j.eval_count) || 0 }
        });
        send('message_stop', { type: 'message_stop' });
        res.end();
    };

    const fail = (msg) => {
        if (finished) return;
        finished = true;
        clearInterval(ping);
        send('error', { type: 'error', error: { type: 'api_error', message: msg } });
        res.end();
    };

    const proxyReq = callOllama(body, (proxyRes) => {
        if (proxyRes.statusCode !== 200) {
            let errBody = '';
            proxyRes.on('data', c => { errBody += c; });
            proxyRes.on('end', () => fail(`Ollama returned ${proxyRes.statusCode}: ${errBody}`));
            return;
        }

        let buffer = '';
        proxyRes.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                if (!line.trim()) continue;
                let j;
                try { j = JSON.parse(line); } catch (e) { continue; }
                const msg = j.message || {};

                if (msg.content) {
                    if (!textOpen) {
                        index++;
                        textOpen = true;
                        send('content_block_start', {
                            type: 'content_block_start', index,
                            content_block: { type: 'text', text: '' }
                        });
                    }
                    send('content_block_delta', {
                        type: 'content_block_delta', index,
                        delta: { type: 'text_delta', text: msg.content }
                    });
                }

                if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
                    closeText();
                    for (const tc of msg.tool_calls) {
                        sawTool = true;
                        index++;
                        const id = newId('toolu_');
                        const args = argsToString(tc.function && tc.function.arguments);
                        log('TOOL CALL:', tc.function && tc.function.name, args.slice(0, 200));
                        send('content_block_start', {
                            type: 'content_block_start', index,
                            content_block: { type: 'tool_use', id, name: tc.function.name, input: {} }
                        });
                        send('content_block_delta', {
                            type: 'content_block_delta', index,
                            delta: { type: 'input_json_delta', partial_json: args }
                        });
                        send('content_block_stop', { type: 'content_block_stop', index });
                    }
                }

                if (j.done) finish(j);
            }
        });
        proxyRes.on('end', () => finish(null));
    }, (err) => fail('Bridge connection failure: ' + err.message));

    res.on('close', () => {
        clearInterval(ping);
        proxyReq.destroy();
    });
}

function handleNonStreaming(json, res) {
    const body = buildOllamaBody(json, false);
    callOllama(body, (proxyRes) => {
        let data = '';
        proxyRes.on('data', c => { data += c; });
        proxyRes.on('end', () => {
            if (proxyRes.statusCode !== 200) {
                return sendJson(res, 500, {
                    type: 'error',
                    error: { type: 'api_error', message: `Ollama returned ${proxyRes.statusCode}: ${data}` }
                });
            }
            try {
                const j = JSON.parse(data);
                const msg = j.message || {};
                const content = [];
                if (msg.content) content.push({ type: 'text', text: msg.content });
                let sawTool = false;
                for (const tc of msg.tool_calls || []) {
                    sawTool = true;
                    let input = tc.function.arguments;
                    if (typeof input === 'string') { try { input = JSON.parse(input); } catch (e) { input = {}; } }
                    content.push({ type: 'tool_use', id: newId('toolu_'), name: tc.function.name, input: input || {} });
                }
                sendJson(res, 200, {
                    id: newId('msg_'), type: 'message', role: 'assistant', content,
                    model: LOCAL_MODEL,
                    stop_reason: sawTool ? 'tool_use' : (j.done_reason === 'length' ? 'max_tokens' : 'end_turn'),
                    stop_sequence: null,
                    usage: { input_tokens: j.prompt_eval_count || 0, output_tokens: j.eval_count || 0 }
                });
            } catch (e) {
                sendJson(res, 500, { type: 'error', error: { type: 'api_error', message: 'Bad response from Ollama: ' + e.message } });
            }
        });
    }, (err) => sendJson(res, 500, {
        type: 'error', error: { type: 'api_error', message: 'Bridge connection failure: ' + err.message }
    }));
}

const server = http.createServer(async (req, res) => {
    const path = req.url.split('?')[0];

    if (req.method === 'POST' && path === '/v1/messages') {
        const raw = await readBody(req);
        let json;
        try { json = JSON.parse(raw); } catch (e) {
            return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON' } });
        }
        log('INCOMING: stream=%s messages=%d tools=%d', json.stream, (json.messages || []).length, (json.tools || []).length);
        return json.stream ? handleStreaming(json, res) : handleNonStreaming(json, res);
    }

    if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
        const raw = await readBody(req);
        return sendJson(res, 200, { input_tokens: Math.ceil(raw.length / 4) });
    }

    sendJson(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'Not handled by bridge: ' + path } });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`Claude Code -> Ollama bridge on :${PORT} | model=${LOCAL_MODEL} ctx=${NUM_CTX} think=${THINK} tools=${ALLOWED_RAW}`);
});