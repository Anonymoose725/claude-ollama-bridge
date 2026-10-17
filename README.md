# Claude Code to Ollama Translation Bridge

A lightweight, zero-dependency Node.js proxy that lets the Claude Code CLI run against a local model served by Ollama. It translates the Anthropic Messages API that Claude Code speaks into Ollama's native `/api/chat` API, and translates the responses back, including tool calls, so Claude Code can actually read, write and edit files instead of just chatting.

## Features
- **Zero dependencies:** built entirely on native Node.js modules.
- **Full agentic translation:** converts the system prompt, message history, tool definitions, tool calls and tool results in both directions.
- **Streaming support:** rewrites Ollama's NDJSON stream into Anthropic SSE events (`text_delta`, `tool_use` with `input_json_delta`, correct `stop_reason`), and sends keepalive pings during long prompt processing.
- **Tuned for small local models:** exposes a trimmed tool set, sets the context window per request, and disables thinking by default so responses start quickly.
- **As-needed automation:** spins up when you launch the CLI wrapper and shuts down when you exit, to preserve local memory.

## How it works

| Claude Code sends | Bridge sends to Ollama |
|---|---|
| `system` (string or content blocks) | a `system` message (billing header line removed) |
| `tools[]` with `input_schema` | `tools[]` in function format (filtered by `ALLOWED_TOOLS`) |
| assistant `tool_use` blocks | assistant message with `tool_calls` |
| user `tool_result` blocks | `role: "tool"` messages |
| `max_tokens`, `temperature` | `options.num_predict`, `options.temperature` |
| n/a | `options.num_ctx` and `think` from the bridge's settings |

Requests to `/v1/messages/count_tokens` get a rough local estimate. Any other path returns a 404.

---

## Requirements
- [Node.js](https://nodejs.org) 18 or newer
- [Ollama](https://ollama.com) running locally with your model pulled:
  ```bash
  ollama pull qwen3.5:9b
  ```
- The Claude Code CLI (`claude`) installed

---

## Installation & Setup

### 1. The Bridge Script
Place `claude-bridge.js` in your home folder (the shell snippets below assume `~/claude-bridge.js`).

### 2. Configuration
The bridge is configured with environment variables, so you don't need to edit the file:

| Variable | Default | Purpose |
|---|---|---|
| `LOCAL_MODEL` | `qwen3.5:9b` | Ollama model name to use for every request |
| `NUM_CTX` | `16384` | Context window sent to Ollama. Claude Code's prompt is large; too small a value silently truncates it. Lower to `8192` if memory is tight |
| `ALLOWED_TOOLS` | `Read,Write,Edit,Bash,Glob,Grep` | Claude Code tools exposed to the model, or `all` for every tool. Fewer tools means a smaller prompt and better tool choice from small models |
| `THINK` | off | Set to `1` to let the model reason before answering (much slower) |
| `DEBUG` | off | Set to `1` to log requests, tool counts and tool calls |

### 3. macOS Deployment (Zsh setup)
Add the environment overrides and background runner function to the bottom of `~/.zshrc`:

```bash
# Claude Code local setup via Node Proxy
export ANTHROPIC_BASE_URL="http://127.0.0.1:8000"
export ANTHROPIC_AUTH_TOKEN="ollama"
export CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT="1"

_run_claude_local() {
  echo "!! Starting native Node translation bridge..."
  unset ANTHROPIC_API_KEY
  # Optional overrides, e.g. NUM_CTX=8192 ALLOWED_TOOLS=all DEBUG=1
  NUM_CTX=16384 node ~/claude-bridge.js > /dev/null 2>&1 &
  local proxy_pid=$!
  sleep 1
  claude --model claude-3-5-sonnet-latest
  echo "!! Shutting down Node translation bridge..."
  kill $proxy_pid 2>/dev/null
}
alias claude-local='_run_claude_local'
```
*Apply changes immediately with `source ~/.zshrc`.*

> The `--model` value only satisfies the CLI. The bridge replaces it with `LOCAL_MODEL` on every request.

### 4. Windows Deployment (PowerShell Setup)
Ensure Node.js and Ollama are installed.

1. Copy `claude-bridge.js` to your Windows user profile folder (e.g., `C:\Users\YourUsername\claude-bridge.js`).
2. Open a PowerShell terminal and open your profile script by running:
   ```powershell
   notepad $PROFILE
   ```
3. Append this function to the bottom of the profile:
   ```powershell
   function claude-local {
       Write-Host "!! Starting native Node translation bridge..." -ForegroundColor Cyan
       $env:ANTHROPIC_BASE_URL="http://127.0.0.1:8000"
       $env:ANTHROPIC_AUTH_TOKEN="ollama"
       $env:CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT="1"
       Remove-Item Env:\ANTHROPIC_API_KEY -ErrorAction SilentlyContinue

       # Optional bridge settings (inherited by the node process)
       $env:NUM_CTX="16384"
       # $env:ALLOWED_TOOLS="all"
       # $env:DEBUG="1"

       # Spin up the bridge in the background
       $proxy = Start-Process node -ArgumentList "$HOME\claude-bridge.js" -NoNewWindow -PassThru

       Start-Sleep -Seconds 1
       claude --model claude-3-5-sonnet-latest

       Write-Host "!! Shutting down Node translation bridge..." -ForegroundColor Yellow
       Stop-Process -Id $proxy.Id -Force -ErrorAction SilentlyContinue
   }
   ```
4. Restart your PowerShell prompt.

---

## Usage
Invoke the wrapper anywhere in your workspace:
```bash
claude-local
```

To run the bridge manually with logging, in a separate terminal:
```bash
DEBUG=1 node ~/claude-bridge.js
```
Then, in another terminal, with the environment variables from the setup section exported:
```bash
claude --model claude-3-5-sonnet-latest
```

---

## Troubleshooting

- **Model answers but never edits files:** run with `DEBUG=1` and look for `TOOL CALL:` lines. If the bridge logs `tools=0` on the main request, the tools aren't reaching it. If it logs tool counts but never any calls, the model isn't choosing to use them. Try `ALLOWED_TOOLS` with fewer tools, or a stronger model.
- **First response takes a long time:** Ollama must process Claude Code's large prompt before generating anything. Later turns are faster once it's cached.
- **Slow, or the machine starts swapping:** check `ollama ps` for the loaded context size and CPU offload. Lower `NUM_CTX`.
- **Connection errors:** make sure Ollama is running on port `11434` and nothing else is using port `8000`.
- **Port already in use after a crash:** a leftover bridge process may still be running. Find and stop it with `lsof -i :8000` and `kill <pid>`.

## Limitations
- Images are replaced with an `[image omitted]` placeholder.
- Thinking blocks from earlier turns are dropped.
- Tool-call reliability depends on the model. Small models can emit malformed or unnecessary tool calls with a prompt this large.
- Token counts are approximate.