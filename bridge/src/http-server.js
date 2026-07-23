import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultAccountHome, parseBrowserCookie } from "./account.js";
import { AccountPoolError, MAX_ACCOUNTS, MAX_REASONING_EFFORT } from "./account-pool.js";
import { createAgentOrchestrator } from "./agent-orchestrator.js";
import { itemFingerprints } from "./conversation-segments.js";
import { extractImageInputs } from "./notion-images.js";
import {
  correlationId,
  getRecentDiagnostics,
  withDiagnosticContext,
  writeDiagnostic,
} from "./diagnostics.js";
import { ErrorCode, NotionAgentError } from "./errors.js";
import { initializeAllWorkspaces, parseInitCredential } from "./init.js";
import {
  CHAT_SSE_DONE,
  MODEL_ID,
  ProtocolError,
  SUPPORTED_MODELS,
  anthropicPlannerPrompt,
  anthropicSseChunks,
  buildChatCompletion,
  buildChatPrompt,
  buildAnthropicMessage,
  buildResponsesPayload,
  compactResponsesPayload,
  estimateAnthropicTokens,
  extractAnthropicToolCall,
  extractChatToolCall,
  extractResponseToolCall,
  extractUnavailableResponseTool,
  flattenResponseTools,
  looksLikeAgentRefusal,
  modelList,
  protocolErrorBody,
  requestsWebSearch,
  responsesCompactionPrompt,
  responsesIncrementalBody,
  responsesIncrementalPrompt,
  resolveBridgeModel,
  responsesPlannerPrompt,
  responsesSseChunks,
  chatSseData,
  chatSseChunks,
  withCodexMetadata,
} from "./server-protocol.js";
import {
  deriveRequestIdentity,
  requestFingerprint,
  responseInputCount,
} from "./turn-affinity.js";
import { createImpitTransport } from "./transport.js";

export const BRIDGE_HOST = "127.0.0.1";
export const BRIDGE_PORT = 8765;

const EMPTY_POOL_STATUS = Object.freeze({
  configured: 0,
  busy: 0,
  available: 0,
  discovered: 0,
  invalid: 0,
  duplicates: 0,
  maximum: MAX_ACCOUNTS,
});

function sendJson(response, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(payload.length),
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    ...headers,
  });
  response.end(payload);
}

function sendResponsesSse(response, payload, item) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of responsesSseChunks(payload, item)) response.write(chunk);
  response.end();
}

function sendAnthropicSse(response, message) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of anthropicSseChunks(message)) response.write(chunk);
  response.end();
}

function sendChatSse(response, text, model, tools) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of chatSseChunks(text, model, tools)) response.write(chunk);
  response.end();
}

function beginChatSse(response) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.flushHeaders?.();
}

function clientDisconnectedError(cause = null) {
  const error = new Error("The streaming client disconnected", cause ? { cause } : undefined);
  error.name = "AbortError";
  error.code = "CLIENT_DISCONNECTED";
  error.noFailover = true;
  return error;
}

async function writeSseChunk(response, chunk) {
  if (response.destroyed || response.writableEnded) throw clientDisconnectedError();
  await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onDrain = () => finish(resolve);
    const onClose = () => finish(reject, clientDisconnectedError());
    const onError = (error) => finish(reject, clientDisconnectedError(error));
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
    try {
      if (response.write(chunk)) finish(resolve);
    } catch (error) {
      finish(reject, clientDisconnectedError(error));
    }
  });
}

function sendAnthropicError(response, error) {
  if (error instanceof SyntaxError) {
    sendJson(response, 422, protocolErrorBody(
      new ProtocolError(422, "Invalid JSON body", { code: "invalid_request_error" }),
      "anthropic",
    ));
    return;
  }
  if (error instanceof AccountPoolError) {
    const temporary = new Set([
      "pool_cooldown",
      "circuit_open",
      "pool_exhausted",
      "no_accounts",
    ]).has(error.code);
    const headers = error.retryAfter == null
      ? {}
      : { "retry-after": String(error.retryAfter) };
    sendJson(response, temporary ? 503 : 502, protocolErrorBody({
      message: error.message,
      code: temporary ? "temporarily_unavailable" : "api_error",
    }, "anthropic"), headers);
    return;
  }
  const status = error instanceof ProtocolError ? error.status : 502;
  const shaped = error instanceof ProtocolError
    ? error
    : new ProtocolError(status, error?.message || "Inference request failed", {
      code: "api_error",
      cause: error,
    });
  sendJson(response, status, protocolErrorBody(shaped, "anthropic"));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text || "{}");
}

function routeKey(request) {
  const url = new URL(request.url || "/", `http://${BRIDGE_HOST}`);
  return `${request.method || "GET"} ${url.pathname}`;
}

function responseImageParts(body) {
  const images = [];
  for (const item of Array.isArray(body?.input) ? body.input : []) {
    if (!item || typeof item !== "object") continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (["input_image", "image_url", "image"].includes(part?.type)) images.push(part);
    }
  }
  extractImageInputs(images);
  return images;
}

function stableIdFactory(fingerprint) {
  let index = 0;
  return (prefix) => `${prefix}${String(fingerprint).slice(0, 24)}${index++}`;
}

function responsePayload(text, model, inputTokens, outputTokens, tools, fingerprint, now) {
  return buildResponsesPayload(text, model, inputTokens, outputTokens, tools, {
    idFactory: stableIdFactory(fingerprint),
    now: () => Math.floor(now() / 1000),
  });
}
export function createBridgeRequestHandler({
  accountPool = null,
  accountHome = defaultAccountHome(),
  initializeWorkspaces = initializeAllWorkspaces,
  accountTransport = createImpitTransport(),
  turnAffinities,
  conversationSegments,
  workflowId = "",
  runtimeTools = null,
  now = () => Date.now(),
  diagnostic = (event, fields) => writeDiagnostic(event, fields),
} = {}) {
  if (!turnAffinities || typeof turnAffinities.status !== "function") {
    throw new TypeError("turnAffinities must expose status().");
  }
  if (!conversationSegments || typeof conversationSegments.status !== "function") {
    throw new TypeError("conversationSegments must expose status().");
  }
  const agentOrchestrator = createAgentOrchestrator({
    accountPool,
    runtimeTools,
    workflowId,
    codeRoot: runtimeTools?.root ?? process.cwd(),
  });
  let requestSequence = 0;
  let serverPaused = false;

  async function prepareChatCompletions(body) {
    if (serverPaused) {
      throw new ProtocolError(503, "Bridge server is currently paused from dashboard", {
        code: "service_unavailable",
      });
    }
    const model = resolveBridgeModel(body?.model);
    const requestedModel = String(body?.model || model).toLowerCase();
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const tools = Array.isArray(body?.tools) ? body.tools : [];
    const { system, prompt } = buildChatPrompt(messages, tools, { workflowId });
    if (!prompt) {
      throw new ProtocolError(400, "messages must contain text", {
        code: "invalid_request_error",
      });
    }
    const poolStatus = accountPool
      ? await Promise.resolve(accountPool.status())
      : EMPTY_POOL_STATUS;
    if (!accountPool || poolStatus.configured <= 0) {
      throw new ProtocolError(503, "No valid Notion accounts are configured", {
        code: "api_error",
      });
    }
    return {
      model,
      requestedModel,
      prompt,
      system,
      tools,
      plannerMode: tools.length > 0 && !workflowId,
      stream: body?.stream === true,
    };
  }

  async function completeChatCompletions(prepared, { onTextDeltaAsync = null } = {}) {
    const completion = await agentOrchestrator.complete({
      prompt: prepared.prompt,
      system: prepared.system,
      plannerMode: prepared.plannerMode,
      model: prepared.model,
      onTextDeltaAsync,
    });
    return {
      ...prepared,
      completion,
    };
  }

  async function executeChatCompletions(body) {
    return completeChatCompletions(await prepareChatCompletions(body));
  }

  async function streamDirectChatCompletion(response, prepared) {
    beginChatSse(response);
    let streamedText = "";
    let toolCall = null;
    try {
      const result = await completeChatCompletions(prepared, {
        onTextDeltaAsync: async (delta) => {
          const text = String(delta ?? "");
          if (!text) return;
          streamedText += text;
          await writeSseChunk(response, chatSseData(text, prepared.requestedModel));
        },
      });
      const finalText = String(result.completion.text ?? "");
      if (finalText.startsWith(streamedText) && finalText.length > streamedText.length) {
        const remaining = finalText.slice(streamedText.length);
        streamedText = finalText;
        await writeSseChunk(response, chatSseData(remaining, prepared.requestedModel));
      } else if (!streamedText && finalText) {
        streamedText = finalText;
        await writeSseChunk(response, chatSseData(finalText, prepared.requestedModel));
      }
      toolCall = extractChatToolCall(finalText, prepared.tools);
      if (toolCall) {
        await writeSseChunk(response, chatSseData("", prepared.requestedModel, { toolCall }));
      }
    } catch (error) {
      if (!response.destroyed && !response.writableEnded) {
        const message = `\n[Notion Fable error: ${error?.message || String(error)}]\n`;
        try {
          await writeSseChunk(response, chatSseData(message, prepared.requestedModel));
        } catch {
          // The client disconnected while the stream error was being written.
        }
      }
    } finally {
      if (!response.destroyed && !response.writableEnded) {
        try {
          await writeSseChunk(response, chatSseData("", prepared.requestedModel, {
            finishReason: toolCall ? "tool_calls" : "stop",
          }));
          await writeSseChunk(response, CHAT_SSE_DONE);
          response.end();
        } catch {
          if (!response.destroyed && !response.writableEnded) response.end();
        }
      }
    }
  }

  async function executeAnthropicMessages(body) {
    if (serverPaused) {
      throw new ProtocolError(503, "Bridge server is currently paused from dashboard", {
        code: "service_unavailable",
      });
    }
    const model = resolveBridgeModel(body?.model);
    const requestedModel = String(body?.model || model).toLowerCase();
    const poolStatus = accountPool
      ? await Promise.resolve(accountPool.status())
      : EMPTY_POOL_STATUS;
    if (!accountPool || poolStatus.configured <= 0) {
      throw new ProtocolError(503, "No valid Notion accounts are configured", {
        code: "api_error",
      });
    }

    const tools = Array.isArray(body?.tools) ? body.tools : [];
    const prompt = anthropicPlannerPrompt(body);
    const correctionPrompt = "Your previous answer was not a valid planner recommendation. "
      + "The local operator and the listed tools are available outside the model. "
      + "You are not being asked to execute anything yourself. Recommend exactly "
      + "one next action for the user's request as ONLY this JSON object: "
      + '{"tool":"<exact tool name>","arguments":{...}}. '
      + "Choose a tool from the catalog already provided and do not discuss capabilities.";

    const complete = async (provider, lease) => {
      let completion = await provider.complete({
        prompt,
        model,
        webSearch: false,
        workspaceSearch: false,
        askMode: true,
      });
      if (
        tools.length > 0
        && extractAnthropicToolCall(completion.text, tools) === null
        && looksLikeAgentRefusal(completion.text)
      ) {
        completion = await provider.complete({
          prompt: correctionPrompt,
          model,
          webSearch: false,
          workspaceSearch: false,
          askMode: true,
          threadId: completion.thread_id,
        });
      }
      return { completion, lease };
    };

    let result;
    try {
      result = await accountPool.execute(complete, { recoveryOperation: complete });
    } catch (error) {
      if (error instanceof AccountPoolError || error instanceof ProtocolError) throw error;
      throw new ProtocolError(502, error?.message || "Inference request failed", {
        code: "api_error",
        cause: error,
      });
    }
    const { completion } = result;
    const message = buildAnthropicMessage(
      completion.text,
      requestedModel,
      completion.usage?.input_tokens,
      completion.usage?.output_tokens,
      tools,
    );
    return { message, stream: body?.stream === true };
  }

  async function executeResponses(rawBody, headers, { compaction = false } = {}) {
    if (serverPaused) {
      throw new ProtocolError(503, "Bridge server is currently paused from dashboard", {
        code: "service_unavailable",
      });
    }
    const metadataBody = withCodexMetadata(rawBody, headers);
    const body = compaction
      ? { ...metadataBody, request_kind: "compaction" }
      : metadataBody;
    const identity = deriveRequestIdentity(body, headers);

    return conversationSegments.withConversationLock(identity.conversationKey, () =>
      turnAffinities.withTurnLock(identity.turnKey, async () => {
        const model = resolveBridgeModel(body.model);
        const requestedModel = String(body.model || model).toLowerCase();
        const poolStatus = accountPool
          ? await Promise.resolve(accountPool.status())
          : EMPTY_POOL_STATUS;
        if (!accountPool || poolStatus.configured <= 0) {
          throw new ProtocolError(503, "No valid Notion accounts are configured", {
            code: "api_error",
          });
        }

        const tools = compaction ? [] : flattenResponseTools(body.tools);
        const fingerprint = requestFingerprint(body);
        const affinity = identity.turnKey ? turnAffinities.get(identity.turnKey) : null;
        if (
          affinity
          && affinity.input_fingerprint === fingerprint
          && typeof affinity.completion_text === "string"
        ) {
          if (compaction) {
            return {
              compact: compactResponsesPayload(affinity.completion_text, identity.turnId),
              stream: false,
            };
          }
          const built = responsePayload(
            affinity.completion_text,
            requestedModel,
            Number(affinity.input_tokens) || 0,
            Number(affinity.output_tokens) || 0,
            tools,
            fingerprint,
            now,
          );
          return { ...built, stream: body.stream === true };
        }

        const inspection = identity.conversationKey
          ? conversationSegments.inspect(identity.conversationKey, body.input)
          : { segment: null, fingerprints: itemFingerprints(body.input), prefixLength: 0 };
        const segment = inspection.segment;
        let rolloverReason = null;
        if (!compaction && segment?.awaiting_compacted_history) {
          rolloverReason = "post_compaction";
        } else if (segment && inspection.prefixLength === null) {
          rolloverReason = "history_rewritten";
        }

        let anchor = null;
        let previousInputCount = null;
        if (compaction) {
          if (segment && inspection.prefixLength !== null) {
            anchor = segment;
            previousInputCount = inspection.prefixLength;
          }
        } else if (!rolloverReason) {
          if (affinity) {
            anchor = affinity;
            previousInputCount = affinity.input_count;
          } else if (segment && inspection.prefixLength !== null) {
            anchor = segment;
            previousInputCount = inspection.prefixLength;
          }
        }

        const incrementalBody = previousInputCount === null
          ? null
          : responsesIncrementalBody(body, previousInputCount);
        const fullPrompt = compaction
          ? responsesCompactionPrompt(body, { continuing: false })
          : responsesPlannerPrompt(body);
        let incrementalPrompt = null;
        if (anchor) {
          if (compaction) {
            incrementalPrompt = responsesCompactionPrompt(
              incrementalBody ?? { input: [] },
              { continuing: true },
            );
          } else if (incrementalBody) {
            incrementalPrompt = responsesIncrementalPrompt(incrementalBody);
          }
        }

        let fullImages;
        let incrementalImages = [];
        try {
          if (incrementalPrompt) incrementalImages = responseImageParts(incrementalBody);
          else fullImages = responseImageParts(body);
        } catch (error) {
          throw new ProtocolError(400, error.message, {
            code: "invalid_request_error",
            cause: error,
          });
        }

        const complete = async (provider, lease, { continuation = false } = {}) => {
          const useContinuation = continuation
            && anchor
            && incrementalPrompt
            && lease.accountId === anchor.account_id;
          const images = useContinuation
            ? incrementalImages
            : (fullImages ?? responseImageParts(body));
          let completion = await provider.complete({
            prompt: useContinuation ? incrementalPrompt : fullPrompt,
            model,
            webSearch: compaction ? false : requestsWebSearch(body.tools),
            workspaceSearch: false,
            askMode: true,
            ...(useContinuation ? { threadId: anchor.notion_thread_id } : {}),
            ...(images.length ? { images } : {}),
          });

          const validCall = extractResponseToolCall(completion.text, tools);
          const unavailableTool = extractUnavailableResponseTool(completion.text, tools);
          if (
            !compaction
            && tools.length > 0
            && validCall === null
            && (looksLikeAgentRefusal(completion.text) || unavailableTool !== null)
          ) {
            const correction = unavailableTool
              ? `The tool "${unavailableTool}" is not available to the local operator. `
              : "Your previous answer was not a valid planner recommendation. ";
            completion = await provider.complete({
              prompt: correction
                + "Use only an exact tool from the catalog already provided when another local action is necessary. If the requested information is already visible in the conversation, answer the user normally instead of emitting JSON.",
              model,
              webSearch: requestsWebSearch(body.tools),
              workspaceSearch: false,
              askMode: true,
              threadId: completion.thread_id,
            });
          }
          return { completion, lease };
        };

        let result;
        try {
          result = await accountPool.execute(
            (provider, lease) => complete(provider, lease, { continuation: true }),
            {
              preferredAccountId: anchor?.account_id ?? null,
              recoveryOperation: (provider, lease) => complete(provider, lease),
            },
          );
        } catch (error) {
          if (error instanceof AccountPoolError || error instanceof ProtocolError) throw error;
          throw new ProtocolError(502, error?.message || "Inference request failed", {
            code: "api_error",
            cause: error,
          });
        }
        const { completion, lease } = result;
        const inputTokens = Number(completion.usage?.input_tokens) || 0;
        const outputTokens = Number(completion.usage?.output_tokens) || 0;

        if (identity.turnKey) {
          turnAffinities.set(identity.turnKey, {
            account_id: lease.accountId,
            notion_thread_id: completion.thread_id,
            input_count: responseInputCount(body),
            input_fingerprint: fingerprint,
            completion_text: completion.text,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
          });
          await turnAffinities.save();
        }

        if (identity.conversationKey) {
          conversationSegments.set(identity.conversationKey, {
            segment_index: segment
              ? segment.segment_index + (rolloverReason ? 1 : 0)
              : 0,
            account_id: lease.accountId,
            notion_thread_id: completion.thread_id,
            item_fingerprints: inspection.fingerprints,
            awaiting_compacted_history: compaction,
            turns: (segment?.turns ?? 0) + 1,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
          });
          await conversationSegments.save();
        }

        if (compaction) {
          return {
            compact: compactResponsesPayload(completion.text, identity.turnId),
            stream: false,
          };
        }
        const built = responsePayload(
          completion.text,
          requestedModel,
          inputTokens,
          outputTokens,
          tools,
          fingerprint,
          now,
        );
        return { ...built, stream: body.stream === true };
      }),
    );
  }

  return async function bridgeRequestHandler(request, response) {
    const key = routeKey(request);
    const separator = key.indexOf(" ");
    const method = key.slice(0, separator);
    const requestPath = key.slice(separator + 1);
    const startedAt = now();
    const requestId = correlationId(
      `${startedAt}:${requestSequence += 1}:${method}:${requestPath}`,
    );

    const isQuietPoll = requestPath === "/healthz" || requestPath === "/v1/logs";
    return withDiagnosticContext({ request_id: requestId }, async () => {
      if (!isQuietPoll) {
        diagnostic("request_started", {
          request_id: requestId,
          method,
          path: requestPath,
        });
      }
      try {
        switch (key) {
        case "GET /healthz": {
          const poolStatus = accountPool
            ? await Promise.resolve(accountPool.status())
            : { ...EMPTY_POOL_STATUS };
          sendJson(response, 200, {
            ok: !serverPaused && poolStatus.configured > 0,
            server_active: !serverPaused,
            model: MODEL_ID,
            models: [...SUPPORTED_MODELS],
            reasoning_effort: MAX_REASONING_EFFORT,
            account_pool: serverPaused ? { ...poolStatus, available: 0 } : poolStatus,
            turn_affinity: await Promise.resolve(turnAffinities.status()),
            conversation_segments: await Promise.resolve(conversationSegments.status()),
            custom_agent: Boolean(workflowId),
            external_agent_loop: !workflowId,
          }, {
            "cache-control": "no-cache, no-store, must-revalidate",
            pragma: "no-cache",
            expires: "0",
          });
          return;
        }
        case "GET /v1/models":
          sendJson(response, 200, modelList(Math.floor(now() / 1000)));
          return;
        case "GET /v1/logs":
          sendJson(response, 200, { logs: getRecentDiagnostics() });
          return;
        case "POST /v1/server/stop":
          serverPaused = true;
          diagnostic("server_stopped", { paused: true });
          sendJson(response, 200, { ok: true, server_active: false, message: "Bridge server paused" });
          return;
        case "POST /v1/server/start":
          serverPaused = false;
          if (typeof accountPool?.refresh === "function") {
            await accountPool.refresh();
          }
          diagnostic("server_started", { paused: false });
          sendJson(response, 200, { ok: true, server_active: true, message: "Bridge server resumed" });
          return;
        case "POST /v1/server/kill":
          diagnostic("server_killed", { exiting: true });
          sendJson(response, 200, { ok: true, message: "Server process exiting..." });
          setTimeout(() => {
            process.exit(0);
          }, 300);
          return;
        case "GET /v1/settings/token-profile": {
          const runtimeStateDir = path.join(process.cwd(), ".runtime");
          const profilePath = path.join(runtimeStateDir, "token-profile");
          let profile = "extreme";
          try {
            if (fs.existsSync(profilePath)) {
              profile = fs.readFileSync(profilePath, "utf8").trim().toLowerCase() || "extreme";
            }
          } catch { /* ignore */ }
          sendJson(response, 200, { profile });
          return;
        }
        case "POST /v1/settings/token-profile": {
          const body = await readJson(request);
          const profile = String(body?.profile ?? "").toLowerCase();
          if (profile !== "safe" && profile !== "extreme") {
            sendJson(response, 400, { error: "profile must be 'safe' or 'extreme'" });
            return;
          }
          const scriptDir = path.join(
            path.dirname(fileURLToPath(import.meta.url)),
            "..",
            "..",
            "scripts",
          );
          const runtimeStateDir = path.join(process.cwd(), ".runtime");
          const codexHome = path.join(process.env.HOME ?? "~", ".codex");
          const codexConfig = path.join(codexHome, "config.toml");
          const catalogTemplate = path.join(process.cwd(), "config", "codex-models.json");
          const openCodeConfig = path.join(runtimeStateDir, "opencode", "opencode.jsonc");
          const scriptPath = path.join(scriptDir, "apply-token-profile.mjs");
          await new Promise((resolve, reject) => {
            const child = spawn(
              process.execPath,
              [scriptPath, runtimeStateDir, codexConfig, catalogTemplate, openCodeConfig, profile],
              { stdio: ["ignore", "pipe", "pipe"] },
            );
            let out = "";
            let err = "";
            child.stdout.on("data", (d) => { out += d; });
            child.stderr.on("data", (d) => { err += d; });
            child.on("close", (code) => {
              if (code === 0) resolve(out.trim());
              else reject(new Error(err.trim() || `apply-token-profile exited with code ${code}`));
            });
            child.on("error", reject);
          });
          sendJson(response, 200, { ok: true, profile });
          return;
        }
        case "POST /v1/messages/count_tokens": {
          const body = await readJson(request);
          sendJson(response, 200, { input_tokens: estimateAnthropicTokens(body) });
          return;
        }
        case "POST /v1/accounts": {
          const body = await readJson(request);
          const credentialInput = String(body?.token ?? "").trim();
          if (!credentialInput) {
            sendJson(response, 400, { error: "token is required" });
            return;
          }
          try {
            const credential = parseBrowserCookie(credentialInput).has("token_v2")
              ? parseInitCredential({ cookie: credentialInput })
              : parseInitCredential({ tokenV2: credentialInput });
            const result = await initializeWorkspaces({
              accountHome,
              credential,
              transport: accountTransport,
            });
            if (result.created.length > 0 && typeof accountPool?.refresh === "function") {
              await accountPool.refresh();
            }
            const createdWorkspaces = result.created.map(({ summary }) => ({
              workspace_id: summary.workspace_id,
              workspace_name: summary.workspace_name,
              workspace_domain: summary.workspace_domain,
              user_id: summary.user_id,
              user_name: summary.user_name,
              user_email: summary.user_email,
            }));
            const skippedWorkspaces = result.skipped.map((summary) => ({
              workspace_id: summary.workspace_id,
              workspace_name: summary.workspace_name,
            }));
            diagnostic("account_initialization_completed", {
              discovered_workspaces: result.discovered_workspaces,
              created_count: createdWorkspaces.length,
              skipped_count: skippedWorkspaces.length,
            });
            sendJson(response, 200, {
              ok: true,
              discovered_workspaces: result.discovered_workspaces,
              created_count: createdWorkspaces.length,
              skipped_count: skippedWorkspaces.length,
              created_workspaces: createdWorkspaces,
              skipped_workspaces: skippedWorkspaces,
            });
          } catch (error) {
            const code = error instanceof NotionAgentError ? error.code : "account_initialization_failed";
            const authenticationFailed = code === ErrorCode.AUTH_INVALID;
            diagnostic("account_initialization_failed", { error_code: code });
            sendJson(response, authenticationFailed ? 401 : 400, {
              error: authenticationFailed
                ? "Notion authentication failed."
                : "Failed to initialize Notion workspaces.",
            });
          }
          return;
        }
        case "POST /v1/messages": {
          try {
            const body = await readJson(request);
            const result = await executeAnthropicMessages(body);
            if (result.stream) sendAnthropicSse(response, result.message);
            else sendJson(response, 200, result.message);
          } catch (error) {
            sendAnthropicError(response, error);
          }
          return;
        }
        case "POST /v1/chat/completions": {
          const body = await readJson(request);
          const prepared = await prepareChatCompletions(body);
          if (prepared.stream && !prepared.plannerMode && !workflowId) {
            await streamDirectChatCompletion(response, prepared);
          } else {
            const result = await completeChatCompletions(prepared);
            if (result.stream) {
              sendChatSse(response, result.completion.text, result.requestedModel, result.tools);
              return;
            }
            sendJson(response, 200, buildChatCompletion(
              result.completion.text,
              result.requestedModel,
              result.completion.usage?.input_tokens,
              result.completion.usage?.output_tokens,
              result.tools,
              { now: () => Math.floor(now() / 1000) },
            ));
          }
          return;
        }
        case "POST /v1/responses": {
          const body = await readJson(request);
          const result = await executeResponses(body, request.headers);
          if (result.stream) sendResponsesSse(response, result.response, result.item);
          else sendJson(response, 200, result.response);
          return;
        }
        case "POST /v1/responses/compact": {
          const body = await readJson(request);
          const result = await executeResponses(body, request.headers, { compaction: true });
          sendJson(response, 200, result.compact);
          return;
        }
        default: {
          // OPTIONS preflight handler for CORS
          if (request.method === "OPTIONS") {
            response.writeHead(204, {
              "access-control-allow-origin": "*",
              "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
              "access-control-allow-headers": "content-type, authorization",
            });
            response.end();
            return;
          }
          // DELETE /v1/accounts/:id — remove account file and reload pool
          if (request.method === "DELETE" && requestPath.startsWith("/v1/accounts/")) {
            const target = decodeURIComponent(requestPath.slice("/v1/accounts/".length)).trim();
            if (!target) {
              sendJson(response, 400, { error: "account id is required" });
              return;
            }
            const poolAccounts = accountPool?.status().accounts || [];
            const slot = poolAccounts.find((a) =>
              a.id === target ||
              a.workspace_id === target ||
              a.accountPath === target ||
              path.basename(a.accountPath) === target ||
              String(a.slot) === target,
            );

            let filePathToRemove = slot?.accountPath;
            if (!filePathToRemove) {
              const candidate = path.join(accountHome, "accounts", target.endsWith(".json") ? target : `${target}.json`);
              if (fs.existsSync(candidate)) filePathToRemove = candidate;
            }

            if (filePathToRemove && fs.existsSync(filePathToRemove)) {
              fs.rmSync(filePathToRemove, { force: true });
              diagnostic("account_removed", { account_id: target, path: filePathToRemove });
            } else if (!slot) {
              sendJson(response, 404, { error: "Account not found" });
              return;
            }

            let updatedPool = null;
            if (typeof accountPool?.refresh === "function") {
              updatedPool = await accountPool.refresh();
            } else if (accountPool) {
              updatedPool = accountPool.status();
            }
            sendJson(response, 200, { ok: true, removed: target, account_pool: updatedPool });
            return;
          }
          if (request.method === "GET" && (requestPath === "/dashboard" || requestPath.startsWith("/dashboard/") || requestPath.startsWith("/assets/"))) {
            const dashboardDist = path.join(process.cwd(), "dashboard", "dist");
            let relativePath = requestPath.startsWith("/assets/")
              ? requestPath.slice(1)
              : (requestPath.replace(/^\/dashboard\/?/, "") || "index.html");
            let filePath = path.join(dashboardDist, relativePath);
            if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
              filePath = path.join(dashboardDist, "index.html");
            }
            if (fs.existsSync(filePath)) {
              const ext = path.extname(filePath);
              const mimeTypes = {
                ".html": "text/html; charset=utf-8",
                ".js": "application/javascript; charset=utf-8",
                ".css": "text/css; charset=utf-8",
                ".json": "application/json",
                ".svg": "image/svg+xml",
                ".png": "image/png",
              };
              const contentType = mimeTypes[ext] || "application/octet-stream";
              const fileContent = fs.readFileSync(filePath);
              const cacheHeaders = ext === ".html"
                ? {
                    "cache-control": "no-cache, no-store, must-revalidate",
                    pragma: "no-cache",
                    expires: "0",
                  }
                : {
                    "cache-control": "no-cache",
                  };
              response.writeHead(200, {
                "content-type": contentType,
                "content-length": String(fileContent.length),
                ...cacheHeaders,
              });
              response.end(fileContent);
              return;
            }
          }
          sendJson(response, 404, { detail: "Not Found" });
        }
        }
      } catch (error) {
        if (error instanceof SyntaxError) {
          sendJson(response, 422, { detail: "Invalid JSON body" });
          return;
        }
        if (error instanceof AccountPoolError) {
          const temporary = new Set([
            "pool_cooldown",
            "circuit_open",
            "pool_exhausted",
            "no_accounts",
          ]).has(error.code);
          const headers = error.retryAfter == null
            ? {}
            : { "retry-after": String(error.retryAfter) };
          sendJson(response, temporary ? 503 : 502, {
            error: {
              message: error.message,
              type: temporary ? "temporarily_unavailable" : "api_error",
            },
          }, headers);
          return;
        }
        sendJson(response, error?.status || 500, protocolErrorBody(error));
      } finally {
        const status = response.statusCode || 500;
        if (!isQuietPoll || status >= 400) {
          diagnostic(status >= 400 ? "request_failed" : "request_completed", {
            request_id: requestId,
            method,
            path: requestPath,
            status,
            duration_ms: Math.max(0, now() - startedAt),
          });
        }
      }
    });
  };
}

export function createBridgeServer(options) {
  return http.createServer(createBridgeRequestHandler(options));
}

export async function listenBridgeServer(server, { port = BRIDGE_PORT } = {}) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, BRIDGE_HOST);
  });
  return server.address();
}

export async function closeBridgeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
