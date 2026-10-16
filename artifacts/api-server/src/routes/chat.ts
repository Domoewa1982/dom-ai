import { Router, type IRouter } from "express";
import {
  SendChatMessageBody,
  SendChatMessageResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();
const requestTimes = new Map<string, number[]>();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;
const MAX_CONTEXT_CHARACTERS = 12_000;
const GROQ_RESPONSES_URL = "https://api.groq.com/openai/v1/responses";
const LIVE_FACT_PATTERN =
  /\b(?:weather|forecast|temperature|gold|silver|platinum|oil prices?|gas prices?|prices?|pricing|costs?|news|headlines?|breaking|stocks?|shares?|crypto(?:currency)?|bitcoin|ethereum|exchange rates?|interest rates?|mortgage rates?|markets?|elections?|polls?|scores?|who won|schedule|opening hours|availability|latest|current(?:ly)?|today|tonight|tomorrow|right now|just now|live|real[- ]time|recent(?:ly)?|this week|this month|this year|last night|last week|last month)\b/i;

type JsonRecord = Record<string, unknown>;
type ChatSource = { title: string; url: string };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function needsLiveSearch(message: string): boolean {
  return LIVE_FACT_PATTERN.test(message);
}

function getResponseText(payload: JsonRecord): string {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  if (!Array.isArray(payload.output)) return "";
  const textParts: string[] = [];
  for (const item of payload.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (
        isRecord(content) &&
        (content.type === "output_text" || content.type === "text") &&
        typeof content.text === "string"
      ) {
        textParts.push(content.text);
      }
    }
  }
  return textParts.join("\n").trim();
}

function getSearchSources(output: unknown): ChatSource[] {
  const found = new Map<string, ChatSource>();

  const addSource = (rawUrl: string, rawTitle?: unknown): void => {
    if (rawUrl.length > 2048) return;
    try {
      const parsedUrl = new URL(rawUrl);
      if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") return;
      if (/\/search\/?$/i.test(parsedUrl.pathname)) return;
      const finalPathSegment = parsedUrl.pathname.split("/").filter(Boolean).pop() ?? "";
      let decodedPathSegment = finalPathSegment;
      try {
        decodedPathSegment = decodeURIComponent(finalPathSegment);
      } catch {
        // Keep the undecoded path segment for the visible title.
      }
      const pathLabel = decodedPathSegment.replace(/[-_]/g, " ");
      const title =
        typeof rawTitle === "string" && rawTitle.trim()
          ? rawTitle.trim().slice(0, 180)
          : pathLabel && pathLabel.toLowerCase() !== "search"
            ? pathLabel.slice(0, 180)
            : `${parsedUrl.hostname} search`;
      found.set(parsedUrl.href, { title, url: parsedUrl.href });
    } catch {
      // Ignore malformed citation URLs.
    }
  };

  const visit = (value: unknown, depth = 0, parseSearchText = false): void => {
    if (depth > 10) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value === "string") {
      if (!parseSearchText || value.length > 30_000) return;
      try {
        visit(JSON.parse(value), depth + 1);
      } catch {
        const markdownLinks = /\[([^\]]{1,180})\]\((https?:\/\/[^)\s]+)\)/gi;
        for (const match of value.matchAll(markdownLinks)) {
          addSource(match[2].replace(/[).,;:!?]+$/, ""), match[1]);
        }
        const urls = value.match(/https?:\/\/[^\s<>"'\\\])}]+/gi) ?? [];
        for (const match of urls) {
          addSource(match.replace(/[).,;:!?]+$/, ""));
        }
      }
      return;
    }
    if (!isRecord(value)) return;

    const rawUrl = value.url ?? value.uri ?? value.href;
    if (typeof rawUrl === "string") addSource(rawUrl, value.title ?? value.name);

    for (const [key, child] of Object.entries(value)) {
      visit(child, depth + 1, value.type === "mcp_call" && key === "output");
    }
  };

  visit(output);
  return [...found.values()].slice(0, 8);
}

function hasSearchEvidence(output: unknown, depth = 0): boolean {
  if (depth > 10) return false;
  if (Array.isArray(output)) {
    return output.some((item) => hasSearchEvidence(item, depth + 1));
  }
  if (!isRecord(output)) return false;

  const identifiers = [
    output.type,
    output.name,
    output.tool,
    output.tool_name,
    output.server_label,
  ];
  if (
    identifiers.some(
      (value) =>
        typeof value === "string" &&
        /(?:browser_search|web_search)/i.test(value),
    )
  ) {
    return true;
  }
  if (output.type === "mcp_call") return true;

  return [
    "action",
    "content",
    "executed_tools",
    "output",
    "results",
    "search_results",
    "sources",
  ].some((key) => key in output && hasSearchEvidence(output[key], depth + 1));
}

function isRateLimited(ip: string, now: number): boolean {
  const recent = (requestTimes.get(ip) ?? []).filter(
    (timestamp) => now - timestamp < RATE_WINDOW_MS,
  );

  if (recent.length >= RATE_LIMIT) {
    requestTimes.set(ip, recent);
    return true;
  }

  recent.push(now);
  requestTimes.set(ip, recent);

  if (requestTimes.size > 1_000) {
    for (const [key, timestamps] of requestTimes) {
      if (timestamps.every((timestamp) => now - timestamp >= RATE_WINDOW_MS)) {
        requestTimes.delete(key);
      }
    }
  }

  return false;
}

router.post("/chat", async (req, res): Promise<void> => {
  if (isRateLimited(req.ip || "unknown", Date.now())) {
    res.status(429).json({ error: "Too many messages. Please try again shortly." });
    return;
  }

  const parsed = SendChatMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Please provide a valid message." });
    return;
  }

  const history = parsed.data.history ?? [];
  const totalCharacters =
    parsed.data.message.length +
    history.reduce((total, turn) => total + turn.content.length, 0);
  if (totalCharacters > MAX_CONTEXT_CHARACTERS) {
    res.status(400).json({ error: "This conversation is too long. Start a new chat or shorten your message." });
    return;
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    req.log.error("GROQ_API_KEY is not configured");
    res.status(503).json({ error: "Dom AI is waiting for a Groq API key." });
    return;
  }

  try {
    const shouldSearch = needsLiveSearch(parsed.data.message);
    const requestBody = {
      model: "openai/gpt-oss-20b",
      instructions:
        "You are Dom, a thoughtful, warm, and practical AI assistant. Give clear, useful answers and keep a conversational tone. For current, recent, or time-sensitive facts, complete browser search before composing the answer and base claims only on the returned results. If results do not verify an answer, say so instead of guessing. Never invent live prices, weather, news, or source links. When search results are used, cite them and only refer to URLs supplied by those results.",
      input: [
        ...history.map((turn) => ({
          role: turn.role,
          content: turn.content,
        })),
        { role: "user", content: parsed.data.message },
      ],
      max_output_tokens: 900,
      ...(shouldSearch
        ? {
            tools: [{ type: "browser_search" }],
            tool_choice: "required",
            reasoning: { effort: "low" },
          }
        : {}),
    };

    const providerResponse = await fetch(GROQ_RESPONSES_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(60_000),
    });
    const responseBody = await providerResponse.text();
    let decodedBody: unknown = null;
    try {
      decodedBody = JSON.parse(responseBody);
    } catch {
      // The error below reports malformed provider responses without echoing the body.
    }

    if (!providerResponse.ok) {
      const providerError =
        isRecord(decodedBody) && isRecord(decodedBody.error)
          ? decodedBody.error
          : {};
      const providerMessage =
        typeof providerError.message === "string"
          ? providerError.message
          : `Groq Responses API returned HTTP ${providerResponse.status}`;
      const error = Object.assign(new Error(providerMessage), {
        status: providerResponse.status,
        code: providerError.code,
        request_id:
          providerResponse.headers.get("x-request-id") ??
          providerResponse.headers.get("request-id"),
      });
      throw error;
    }

    if (!isRecord(decodedBody)) {
      throw new Error("Groq Responses API returned an invalid response.");
    }

    const reply = getResponseText(decodedBody);
    const sources = getSearchSources(decodedBody);
    const searchEvidence =
      sources.length > 0 || hasSearchEvidence(decodedBody.output);
    const outputTypes = Array.isArray(decodedBody.output)
      ? decodedBody.output
          .filter(isRecord)
          .map((item) => item.type)
          .filter((type): type is string => typeof type === "string")
      : [];

    if (!reply) {
      req.log.warn("Groq Responses API returned an empty chat response");
      res.status(503).json({ error: "Dom AI could not create a response. Please try again." });
      return;
    }

    if (shouldSearch && (!searchEvidence || sources.length === 0)) {
      req.log.warn(
        { outputTypes, sourceCount: sources.length },
        "Groq did not return verifiable live-search sources",
      );
      res.status(503).json({
        error: "I couldn’t find a verifiable source in live search, so I won’t guess. Please try again shortly.",
      });
      return;
    }

    if (shouldSearch) {
      req.log.info(
        { sourceCount: sources.length, outputTypes },
        "Groq live search completed",
      );
    }

    res.json(SendChatMessageResponse.parse({ reply, sources }));
  } catch (error) {
    const diagnostic = error as Error & {
      status?: number;
      code?: string;
      request_id?: string;
      cause?: { code?: string; message?: string };
    };
    const sensitiveValues = [
      apiKey,
      parsed.data.message,
      ...history.map((turn) => turn.content),
    ].filter(Boolean);
    let safeMessage =
      typeof diagnostic.message === "string" ? diagnostic.message : "";
    for (const value of sensitiveValues) {
      safeMessage = safeMessage.replaceAll(value, "[redacted]");
    }
    req.log.error(
      {
        errorName: diagnostic.name || "UnknownError",
        status: diagnostic.status,
        code: diagnostic.code,
        requestId: diagnostic.request_id,
        causeCode: diagnostic.cause?.code,
        causeName:
          error instanceof Error && error.cause instanceof Error
            ? error.cause.name
            : undefined,
        message: safeMessage.slice(0, 400),
      },
      "Groq Responses API request failed",
    );

    if (diagnostic.status === 429) {
      res.status(429).json({
        error: "The Groq free-tier limit has been reached. Please wait and try again later.",
      });
      return;
    }

    if (diagnostic.status === 401 || diagnostic.status === 403) {
      res.status(503).json({
        error: "Dom AI could not authenticate with Groq. Check the GROQ_API_KEY project secret.",
      });
      return;
    }

    res.status(503).json({ error: "Dom AI is temporarily unavailable. Please try again." });
  }
});

export default router;
