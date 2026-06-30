import type { ParsedResponse } from "./proxy.types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function collectResponsesText(output: unknown): string[] {
  if (!Array.isArray(output)) return [];

  const contentParts: string[] = [];

  for (const item of output) {
    if (!isRecord(item)) continue;

    const itemType = typeof item.type === "string" ? item.type : "";
    if (itemType === "message") {
      const content = item.content;
      if (!Array.isArray(content)) continue;

      for (const part of content) {
        if (!isRecord(part)) continue;
        const partType = typeof part.type === "string" ? part.type : "";
        const text = part.text;
        if (
          typeof text === "string" &&
          (partType === "output_text" ||
            partType === "text" ||
            partType === "message_text")
        ) {
          contentParts.push(text);
        }
      }
      continue;
    }

    if (itemType === "output_text" && typeof item.text === "string") {
      contentParts.push(item.text);
      continue;
    }

    if (typeof item.text === "string" && itemType.startsWith("output_")) {
      contentParts.push(item.text);
    }
  }

  return contentParts;
}

function parseOpenAIResponsesObject(data: unknown): ParsedResponse {
  if (!isRecord(data)) {
    return { model: null, content: null, usage: null, raw: null };
  }

  const model = typeof data.model === "string" ? data.model : null;
  const usage = isRecord(data.usage) ? data.usage : null;

  let content: string | null = null;
  if (typeof data.output_text === "string") {
    content = data.output_text;
  } else {
    const contentParts = collectResponsesText(data.output);
    content = contentParts.length > 0 ? contentParts.join("") : null;
  }

  return {
    model,
    content,
    usage,
    raw: data,
  };
}

function extractLegacyChatContent(
  data: Record<string, unknown>,
): string | null {
  const choices = data.choices;
  if (!Array.isArray(choices)) return null;

  const firstChoice = choices[0];
  if (!isRecord(firstChoice)) return null;

  const message = firstChoice.message;
  if (isRecord(message) && typeof message.content === "string") {
    return message.content;
  }

  return null;
}

export async function consumeStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes <= maxBytes) {
        chunks.push(decoder.decode(value, { stream: true }));
      }
      // Keep reading even if truncated — must drain the tee'd stream
    }
  } finally {
    reader.releaseLock();
  }
  return { text: chunks.join(""), truncated: totalBytes > maxBytes };
}

export function parseSSEResponse(raw: string): ParsedResponse {
  const lines = raw.split("\n");
  let model: string | null = null;
  let usage: ParsedResponse["usage"] = null;
  const contentParts: string[] = [];
  let currentEvent = "";

  for (const line of lines) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7).trim();
      continue;
    }

    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;

    try {
      const chunk = JSON.parse(line.slice(6)) as Record<string, unknown>;
      const eventType =
        currentEvent || (typeof chunk.type === "string" ? chunk.type : "");

      if (!model && typeof chunk.model === "string") model = chunk.model;
      if (isRecord(chunk.usage)) usage = chunk.usage;

      const delta =
        typeof chunk.delta === "string"
          ? chunk.delta
          : isRecord(chunk.delta) && typeof chunk.delta.text === "string"
            ? chunk.delta.text
            : null;

      if (eventType === "response.output_text.delta" && delta) {
        contentParts.push(delta);
        continue;
      }

      if (eventType === "response.completed") {
        const completed = isRecord(chunk.response) ? chunk.response : chunk;
        const parsed = parseOpenAIResponsesObject(completed);

        if (!model && parsed.model) model = parsed.model;
        if (contentParts.length === 0 && parsed.content) {
          contentParts.push(parsed.content);
        }
        if (parsed.usage) usage = parsed.usage;
        continue;
      }

      const legacyChoices = Array.isArray(chunk.choices) ? chunk.choices : null;
      const legacyDelta = legacyChoices
        ? (legacyChoices[0] as { delta?: { content?: string } } | undefined)
            ?.delta?.content
        : null;

      if (legacyDelta) {
        contentParts.push(legacyDelta);
      }
    } catch {
      /* skip malformed */
    }
  }

  return {
    model,
    content: contentParts.length > 0 ? contentParts.join("") : null,
    usage,
    raw: null,
  };
}

export function parseJSONResponse(raw: string): ParsedResponse {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;

    if (data.object === "response" || Array.isArray(data.output)) {
      return parseOpenAIResponsesObject(data);
    }

    return {
      model: typeof data.model === "string" ? data.model : null,
      content:
        typeof data.text === "string"
          ? data.text
          : typeof data.output_text === "string"
            ? data.output_text
            : extractLegacyChatContent(data),
      usage: isRecord(data.usage) ? data.usage : null,
      raw: data,
    };
  } catch {
    return { model: null, content: null, usage: null, raw: null };
  }
}
