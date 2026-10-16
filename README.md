# Claude Code to Ollama Translation Bridge

A lightweight, zero-dependency Node.js reverse proxy that translates Claude Code CLI API calls into standard OpenAI compatibility paths required by local Ollama engines. This bypasses the structural format and streaming errors (`StreamNoEventsError`) caused by local API mismatches.

## Features
- **Zero Dependencies:** Built entirely using native Node.js network routing layers.
- **On-The-Fly Automation:** Spins up transparently when launching the CLI tool and self-terminates upon exit to preserve local system memory.
- **Bidirectional Stream Rewriting:** Automatically intercepts and shapes event streams on both sides of the host loop.

---

## Installation & Setup

### 1. The Bridge Script
Ensure `claude-bridge.js` remains in the root execution folder. You can modify the default target model string near the top of the file if needed:
```javascript
const LOCAL_MODEL = 'qwen3.5:9b';
```

### 2. macOS Deployment (Zsh setup)
Add the environment overrides and background runner function to the bottom of your configuration profile (`~/.zshrc`):

```bash
# Claude Code local setup via Node Proxy
export ANTHROPIC_BASE_URL="http://127.0.0.1:8000"
export ANTHROPIC_AUTH_TOKEN="ollama"
export CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT="1"

_run_claude_local() {
  echo "!! Starting native Node translation bridge..."
  unset ANTHROPIC_API_KEY
  node ~/claude-bridge.js > /dev/null 2>&1 &
  local proxy_pid=$!
  sleep 1 
  claude --model claude-3-5-sonnet-latest
  echo "!! Shutting down Node translation bridge..."
  kill $proxy_pid 2>/dev/null
}
alias claude-local='_run_claude_local'
```
*Apply changes immediately with `source ~/.zshrc`.*

### 3. Windows Desktop Deployment (PowerShell Setup)
On your Windows device, ensure [Node.js](https://nodejs.org) and [Ollama](https://ollama.com) are installed. 

1. Copy `claude-bridge.js` to your Windows user profile folder (e.g., `C:\Users\YourUsername\claude-bridge.js`).
2. Open a PowerShell terminal and access your system profile script configuration by running:
   ```powershell
   notepad \$PROFILE
   ```
3. Append this automation execution layout to the bottom of the script profile:
   ```powershell
   function claude-local {
       Write-Host "!! Starting native Node translation bridge..." -ForegroundColor Cyan
       \$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8000"
       \$env:ANTHROPIC_AUTH_TOKEN="ollama"
       \$env:CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT="1"
       Remove-Item Env:\ANTHROPIC_API_KEY -ErrorAction SilentlyContinue

       # Spin up the bridge in the background silently
       \$proxy = Start-Process node -ArgumentList "\$HOME\claude-bridge.js" -NoNewWindow -PassThru

       Start-Sleep -Seconds 1
       claude --model claude-3-5-sonnet-latest

       Write-Host "!! Shutting down Node translation bridge..." -ForegroundColor Yellow
       Stop-Process -Id \$proxy.Id -Force -ErrorAction SilentlyContinue
   }
   ```
4. Restart your PowerShell prompt.

---

## Usage
Simply invoke the alias wrapper anywhere in your workspace:
```bash
claude-local
```
