# opencode-nim-rotator

An [OpenCode](https://opencode.ai) plugin that rotates multiple [NVIDIA NIM](https://build.nvidia.com) API keys, falls back across models on failure, benchmarks latency, and ships a TUI for managing it all.

## Features

- **API Key Rotation**: round-robin or least-failures strategy across multiple NVIDIA NIM keys
- **Model Fallback Chain**: retries with alternative models on streaming timeout, rate limit (429), or server errors (408, 500, 502, 503, 504)
- **Benchmarking**: measure TTFB and TPS for models in your fallback chain
- **TUI Manager**: terminal UI for keys, fallback chain, and settings
- **Themes**: syncs with your OpenCode theme or overrides it

## How It Works

The plugin runs a local HTTP proxy that intercepts NVIDIA NIM traffic. Hooks coordinate model selection and error tracking:

- **Local proxy**: forwards requests to `https://integrate.api.nvidia.com/v1`, injecting a rotated `Authorization: Bearer <key>` header. On 401/403 the proxy disables the key and tries the next one. On 429 the key's `rateLimitCount` increments and a per-model cooldown applies.
- **`chat.message`**: rewrites the model to the highest-priority available entry in your fallback chain.
- **`shell.env`**: rotates `NVIDIA_API_KEY` for shell commands.
- **Streaming timeout**: if no data arrives for 60 seconds, the proxy aborts the stream and triggers fallback. Retryable server errors (408, 429, 500, 502, 503, 504) also trigger fallback. A toast notification shows the model switch.
- **`event` handler**: tracks `session.error`, `session.status`, and `session.next.step.failed` to drive rate-limit counting and session cleanup. Session-level counters reset when the turn completes.

## Install

```bash
npm install -g opencode-nim-rotator
```

The postinstall script adds the plugin to your `~/.config/opencode/opencode.json`.

## Setup

### 1. Add API keys

Run the TUI manager:

```bash
opencode-nim-rotator
```

Or if you prefer:

```bash
npx opencode-nim-rotator
```

Or add a key through OpenCode's auth system:

```bash
opencode /connect nvidia
```

Select "Enter NVIDIA NIM API Key" and paste your key.

### 2. Add more keys, build a fallback chain

The TUI handles all management from one terminal:

- **API Key Rotation**: add, rename, delete, toggle keys; reset failures; switch strategy (round-robin / least-failures); export to JSON; import from JSON.
- **Model Fallback Chain**: build an ordered list of NVIDIA NIM models. On failure the plugin picks the earliest available model in the chain. You can benchmark any model to record TTFB and TPS, and tune the rate-limit threshold (consecutive 429s before fallback).
- **Themes**: pick a color theme, or sync with `opencode.json`.

### 3. Restart OpenCode

After adding keys, restart OpenCode. The plugin rotates keys on every NVIDIA API request and retries failed requests against your fallback chain.

## Model Fallback Chain

The plugin also retries failed requests against a chain of alternative NVIDIA NIM models. When the primary model times out, returns a retryable server error, or hits the rate-limit threshold, the plugin retries the same prompt with the earliest available model in your chain (skipping the one that failed).

### Benchmarking Models

Benchmark any model in the chain to measure latency and throughput on your network. The benchmark sends a streaming programming prompt (`max_tokens: 256`) and records:

- **TTFB**: milliseconds until the HTTP response arrives
- **TPS**: tokens per second during streaming, estimated from character count (`4 chars/token`)

The plugin saves results with the model in the key store.

## Configuration

### Environment Variables

| Variable                 | Description                                          | Default                                    |
| ------------------------ | ---------------------------------------------------- | ------------------------------------------ |
| `NIM_ROTATOR_STORE_PATH` | Path to key store JSON file                          | `~/.config/opencode/nim-rotator-keys.json` |
| `NVIDIA_API_KEY`         | Fallback API key (auto-seeded if no keys configured) | —                                          |

### opencode.json Options

```json
{
  "plugin": [
    [
      "opencode-nim-rotator",
      {
        "rotationStrategy": "round-robin",
        "storePath": "/custom/path/to/keys.json",
        "proxyPort": 0,
        "disableProxy": false
      }
    ]
  ]
}
```

| Option             | Description                                      | Default       |
| ------------------ | ------------------------------------------------ | ------------- |
| `rotationStrategy` | `"round-robin"` or `"least-failures"`            | `round-robin` |
| `storePath`        | Custom path to the key store JSON file           | (default)     |
| `proxyPort`        | TCP port for the local proxy (`0` = OS-assigned) | `0`           |
| `disableProxy`     | Skip starting the intercepting proxy             | `false`       |

### Rotation Strategies

- **`round-robin`** (default): cycles through keys in order
- **`least-failures`**: picks the key with the fewest `rateLimitCount`

## Key Store Format

Keys, fallback chain, and theme are stored in `~/.config/opencode/nim-rotator-keys.json` with file mode `0600`:

```json
{
  "keys": [
    {
      "id": "uuid",
      "name": "work-key",
      "key": "nvapi-...",
      "createdAt": 1700000000000,
      "lastUsedAt": 1700000100000,
      "rateLimitCount": 0,
      "enabled": true
    }
  ],
  "rotationStrategy": "round-robin",
  "updatedAt": 1700000000000,
  "lastUsedKeyId": "uuid",
  "fallbackChain": [
    {
      "id": "nvidia/llama-3.1-70b-instruct",
      "name": "Llama 3.1 70B",
      "benchmarkTtfb": 320,
      "benchmarkTps": 85.4,
      "benchmarkStatus": "done"
    }
  ],
  "maxRateLimitFailures": 3,
  "theme": ""
}
```

`rateLimitCount` tracks 429 errors per key; `maxRateLimitFailures` (default `3`) controls how many consecutive 429s trigger a cross-model fallback. The proxy disables keys on 401/403 without a threshold. Set `theme` to a theme ID to override the TUI theme, or leave it empty to sync with `opencode.json`.

## Themes

The TUI supports multiple color themes matching OpenCode's built-ins. The rotator **syncs with your `opencode.json` theme setting** by default.

| ID           | Name               |
| ------------ | ------------------ |
| `opencode`   | OpenCode (default) |
| `catppuccin` | Catppuccin Mocha   |
| `dracula`    | Dracula            |
| `gruvbox`    | Gruvbox            |
| `kanagawa`   | Kanagawa           |
| `nord`       | Nord               |
| `one-dark`   | One Dark           |
| `rosepine`   | Rose Pine          |
| `solarized`  | Solarized          |
| `tokyonight` | Tokyonight         |

To override via `opencode.json`:

```json
{
  "theme": "dracula"
}
```

To override per-plugin, set the key store's `theme` field to a theme ID. Set it to `""` to revert to syncing with `opencode.json`.

## Development

```bash
# Install dependencies
bun install          # or: npm install

# Run TUI locally (requires bun for .ts execution)
bun run tui

# Build TypeScript
npm run build        # or: bun run build
```

## Uninstall

To remove the plugin:

```bash
npm uninstall -g opencode-nim-rotator
```

The uninstaller will:

1. Remove `opencode-nim-rotator` from your `~/.config/opencode/opencode.json` plugin list
2. Ask whether to delete your key store at `~/.config/opencode/nim-rotator-keys.json` (defaults to No)
3. Delete `~/.config/opencode/nim-rotator-theme.json`

If you confirm key store deletion, all stored API keys are gone. Back them up first if needed. Restart OpenCode after uninstalling.

## License

MIT
