import type { AttachedImage, Message, Thread } from "../types";
import type { ImagePart, Part } from "../types/message";

export const CHAT_IMAGE_LIMITS = {
  maxImagesPerMessage: 2,
  maxRawBytes: 10 * 1024 * 1024,
  maxImageBytes: 700 * 1024,
  maxMessageBytes: 1.5 * 1024 * 1024,
  maxThreadBytes: 10 * 1024 * 1024,
  maxGlobalBytes: 50 * 1024 * 1024,
} as const;

/** Approximate the persisted UTF-8 size of a data URL without decoding its pixels. */
export function getImageDataUrlBytes(dataUrl: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(dataUrl).byteLength;
  }
  return dataUrl.length;
}

export function getImagePartBytes(part: ImagePart): number {
  return getImageDataUrlBytes(part.image.dataUrl);
}

export function getMessageImageBytes(message: Message): number {
  const parts = message.parts ?? [];
  return parts.reduce(
    (sum, part) => sum + (part.type === "image" ? getImagePartBytes(part) : 0),
    0,
  );
}

export function getThreadImageBytes(thread: Thread): number {
  return thread.messages.reduce((sum, message) => sum + getMessageImageBytes(message), 0);
}

export function getGlobalThreadImageBytes(threads: Thread[]): number {
  return threads.reduce((sum, thread) => sum + getThreadImageBytes(thread), 0);
}

export type ChatImageQuotaCode =
  | "too-many-images"
  | "image-too-large"
  | "message-too-large"
  | "thread-too-large"
  | "global-too-large";

export class ChatImageQuotaError extends Error {
  readonly code: ChatImageQuotaCode;

  constructor(code: ChatImageQuotaCode, message: string) {
    super(message);
    this.name = "ChatImageQuotaError";
    this.code = code;
  }
}

/** Validate image quotas against the complete, freshly loaded thread collection. */
export function validateChatImageQuotas(args: {
  threadId: string;
  content: string;
  images: AttachedImage[];
  threads: Thread[];
}): void {
  const { threadId, content, images, threads } = args;
  if (images.length > CHAT_IMAGE_LIMITS.maxImagesPerMessage) {
    throw new ChatImageQuotaError(
      "too-many-images",
      `A message can include at most ${CHAT_IMAGE_LIMITS.maxImagesPerMessage} images.`,
    );
  }

  const incomingBytes = images.reduce((sum, image) => sum + getImageDataUrlBytes(image.dataUrl), 0);
  for (const image of images) {
    if (getImageDataUrlBytes(image.dataUrl) > CHAT_IMAGE_LIMITS.maxImageBytes) {
      throw new ChatImageQuotaError(
        "image-too-large",
        `Image "${image.name}" is larger than 700 KB after compression.`,
      );
    }
  }

  const serializedMessage = JSON.stringify({
    content,
    images: images.map((image) => ({
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      dataUrl: image.dataUrl,
    })),
  });
  const messageBytes = getImageDataUrlBytes(serializedMessage);
  if (messageBytes > CHAT_IMAGE_LIMITS.maxMessageBytes) {
    throw new ChatImageQuotaError(
      "message-too-large",
      "This message is larger than 1.5 MB. Remove an image or choose smaller images.",
    );
  }

  const thread = threads.find((item) => item.id === threadId);
  const threadBytes = (thread ? getThreadImageBytes(thread) : 0) + incomingBytes;
  if (threadBytes > CHAT_IMAGE_LIMITS.maxThreadBytes) {
    throw new ChatImageQuotaError(
      "thread-too-large",
      "This conversation has reached its 10 MB image limit. Start a new conversation or remove images.",
    );
  }

  const globalBytes = getGlobalThreadImageBytes(threads) + incomingBytes;
  if (globalBytes > CHAT_IMAGE_LIMITS.maxGlobalBytes) {
    throw new ChatImageQuotaError(
      "global-too-large",
      "Saved chat images have reached the 50 MB limit. Delete an old conversation before adding more.",
    );
  }
}

/** Read image parts from either the persisted V2 parts array or legacy order entries. */
export function getImageParts(parts: Part[] | undefined): ImagePart[] {
  return (parts ?? []).filter((part): part is ImagePart => part.type === "image");
}
