import { describe, expect, it } from "vitest";
import type { Thread } from "../types";
import {
  CHAT_IMAGE_LIMITS,
  ChatImageQuotaError,
  getGlobalThreadImageBytes,
  getImageDataUrlBytes,
  validateChatImageQuotas,
} from "./chat-images";

function image(id: string, bytes: number) {
  return {
    id,
    name: `${id}.jpg`,
    mimeType: "image/jpeg" as const,
    dataUrl: `data:image/jpeg;base64,${"a".repeat(Math.max(0, bytes - 23))}`,
    size: bytes,
  };
}

function thread(id: string, images: ReturnType<typeof image>[]): Thread {
  return {
    id,
    title: id,
    messages: images.length
      ? [
          {
            id: `message-${id}`,
            threadId: id,
            role: "user",
            content: "",
            parts: images.map((item) => ({
              id: item.id,
              type: "image" as const,
              image: item,
              status: "completed" as const,
              createdAt: 1,
            })),
            createdAt: 1,
          },
        ]
      : [],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("chat image quotas", () => {
  it("counts persisted image data across all threads", () => {
    const item = image("a", 20);
    expect(getGlobalThreadImageBytes([thread("one", [item])])).toBe(
      getImageDataUrlBytes(item.dataUrl),
    );
  });

  it("rejects more than two images and oversized images", () => {
    const images = [image("a", 10), image("b", 10), image("c", 10)];
    expect(() =>
      validateChatImageQuotas({ threadId: "one", content: "", images, threads: [] }),
    ).toThrowError(ChatImageQuotaError);
    expect(() =>
      validateChatImageQuotas({
        threadId: "one",
        content: "",
        images: [image("large", CHAT_IMAGE_LIMITS.maxImageBytes + 1)],
        threads: [],
      }),
    ).toThrow(/700 KB/);
  });

  it("enforces thread and global limits", () => {
    const existing = thread("one", [image("existing", CHAT_IMAGE_LIMITS.maxThreadBytes - 20)]);
    expect(() =>
      validateChatImageQuotas({
        threadId: "one",
        content: "",
        images: [image("incoming", 30)],
        threads: [existing],
      }),
    ).toThrow(/10 MB/);
  });
});
