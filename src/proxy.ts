import type { KeyStore, KeyStoreConfig, SessionState } from "./types.js";
import { getNextKey, saveStore } from "./store.js";
import {
  STREAM_IDLE_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  PORT_RETRY_ATTEMPTS,
} from "./constants.js";
import { logDebug } from "./logger.js";

export interface ProxyOptions {
  port: number;
  store: KeyStore;
  config?: KeyStoreConfig;
  sessions: Map<string, SessionState>;
  targetUrl?: string;
}

export interface ProxyServer {
  readonly port: number;
  stop(): void;
}

const DEFAULT_TARGET_URL = "https://integrate.api.nvidia.com/v1";

/** Starts the local proxy server. Retries up to PORT_RETRY_ATTEMPTS on EADDRINUSE. */
export function startProxy(options: ProxyOptions): ProxyServer | null {
  const { store, sessions, config } = options;
  const targetBaseUrl = options.targetUrl ?? DEFAULT_TARGET_URL;
  let boundPort = 0;
  let server: ReturnType<typeof Bun.serve> | null = null;

  // Try binding on the configured port, then port+1..+5
  for (let attempt = 0; attempt <= PORT_RETRY_ATTEMPTS; attempt++) {
    const tryPort = options.port + attempt;
    try {
      server = Bun.serve({
        port: tryPort,
        hostname: "127.0.0.1",
        idleTimeout: 0,
        async fetch(req) {
          const url = new URL(req.url);
          const sessionID = req.headers.get("x-nim-rotator-session-id");

          try {
            let bodyText: string | undefined;
            let targetModel: string | undefined;

            if (req.body) {
              bodyText = await req.text();
              try {
                const parsed = JSON.parse(bodyText) as Record<string, unknown>;
                targetModel =
                  typeof parsed.model === "string" ? parsed.model : undefined;

                // Rewrite model from session state if available
                if (sessionID) {
                  const session = sessions.get(sessionID);
                  if (
                    session?.currentModelId &&
                    session.currentModelId !== targetModel
                  ) {
                    parsed.model = session.currentModelId;
                    targetModel = session.currentModelId;
                    bodyText = JSON.stringify(parsed);
                  }
                }
              } catch {
                // Non-JSON body — forward as-is
              }
            }

            // Strip /v1 prefix to avoid duplication (target already includes /v1)
            let upstreamPath = url.pathname;
            if (upstreamPath === "/v1") upstreamPath = "";
            else if (upstreamPath.startsWith("/v1/"))
              upstreamPath = upstreamPath.slice(3);

            const upstream = `${targetBaseUrl}${upstreamPath}${url.search}`;

            const headers = new Headers(req.headers);
            headers.delete("x-nim-rotator-session-id");
            headers.delete("host");

            // Key rotation
            const next = getNextKey(store, config, targetModel);
            if (!next) {
              return new Response(
                JSON.stringify({
                  error: { message: "All API keys exhausted" },
                }),
                {
                  status: 503,
                  headers: { "Content-Type": "application/json" },
                },
              );
            }
            headers.set("Authorization", `Bearer ${next.key.key}`);

            // Forward with connect timeout
            const controller = new AbortController();
            const connectTimer = setTimeout(
              () => controller.abort(),
              CONNECT_TIMEOUT_MS,
            );

            let response: Response;
            try {
              response = await fetch(upstream, {
                method: req.method,
                headers,
                body: bodyText,
                signal: controller.signal,
              });
            } finally {
              clearTimeout(connectTimer);
            }

            // Handle 401/403: disable key immediately
            if (response.status === 401 || response.status === 403) {
              next.key.enabled = false;
              try {
                saveStore(store, config);
              } catch {
                logDebug("failed to save store after key disable");
              }
              return response;
            }

            // 429: pass through unmodified — no counting, no callbacks
            if (response.status === 429) {
              return response;
            }

            // Streaming stall detection for SSE responses
            const contentType = response.headers.get("content-type") ?? "";
            if (contentType.includes("text/event-stream") && response.body) {
              return handleStreamingResponse(response);
            }

            return response;
          } catch (error) {
            return new Response(
              JSON.stringify({
                error: {
                  message:
                    error instanceof Error ? error.message : String(error),
                },
              }),
              { status: 502, headers: { "Content-Type": "application/json" } },
            );
          }
        },
      });
      boundPort = server.port ?? tryPort;
      break;
    } catch (_err) {
      if (attempt === PORT_RETRY_ATTEMPTS) {
        logDebug(
          `proxy failed to bind after ${PORT_RETRY_ATTEMPTS + 1} attempts`,
        );
        return null;
      }
      // Try next port
    }
  }

  if (!server) return null;

  return {
    get port() {
      return boundPort;
    },
    stop() {
      server?.stop(true);
    },
  };
}

/** Wraps a streaming response with idle timeout detection. */
function handleStreamingResponse(response: Response): Response {
  const reader = response.body!.getReader();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let aborted = false;

  const stream = new ReadableStream({
    async pull(controller) {
      const resetTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          aborted = true;
          reader.cancel("streaming stall timeout");
          controller.close();
        }, STREAM_IDLE_TIMEOUT_MS);
      };

      resetTimer();
      try {
        const { done, value } = await reader.read();
        if (idleTimer) clearTimeout(idleTimer);
        if (done || aborted) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch {
        if (idleTimer) clearTimeout(idleTimer);
        controller.close();
      }
    },
    cancel() {
      if (idleTimer) clearTimeout(idleTimer);
      reader.cancel();
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
