import { describe, test, expect, vi } from "vitest";
import { extFromMime } from "../src/bot/file-download.js";
import { makeDocumentHandler, type DocumentContext } from "../src/bot/handlers/document.js";
import { makeVoiceHandler, type VoiceContext } from "../src/bot/handlers/voice.js";
import { makePhotoHandler, type PhotoContext } from "../src/bot/handlers/photo.js";

describe("extFromMime", () => {
  test.each([
    ["image/png", ".png"],
    ["image/jpeg", ".jpg"],
    ["image/webp", ".webp"],
    ["image/gif", ".gif"],
    ["audio/ogg", ".ogg"],
    ["audio/mp3", ".mp3"],
    ["audio/mpeg", ".mp3"],
    ["audio/wav", ".wav"],
    ["application/pdf", ".bin"],
    ["", ".bin"],
    [undefined, ".bin"],
  ])("extFromMime(%j) = %j", (mime, expected) => {
    expect(extFromMime(mime as string | undefined)).toBe(expected);
  });
});

describe("makeDocumentHandler", () => {
  function makeCtx(mime: string, file_name = "x.dat"): {
    ctx: DocumentContext;
    replies: string[];
  } {
    const replies: string[] = [];
    const ctx: DocumentContext = {
      message: {
        document: { file_id: "fid", file_name, mime_type: mime },
      },
      replyWithChatAction: async () => undefined,
      reply: async (text) => {
        replies.push(text);
        return { message_id: 1 };
      },
    };
    return { ctx, replies };
  }

  test("non-image MIME results in a polite acknowledgment (no processAsText call)", async () => {
    const { ctx, replies } = makeCtx("application/pdf", "report.pdf");
    const processAsText = vi.fn();
    const handler = makeDocumentHandler(
      { token: "t", processAsText },
      { api: { getFile: vi.fn() } },
    );
    await handler(ctx);
    expect(processAsText).not.toHaveBeenCalled();
    expect(replies[0]).toMatch(/I got a file/);
    expect(replies[0]).toMatch(/report\.pdf/);
    expect(replies[0]).toMatch(/application\/pdf/);
  });

  test("missing document → no-op (silently returns)", async () => {
    const replies: string[] = [];
    const ctx: DocumentContext = {
      message: {},
      replyWithChatAction: async () => undefined,
      reply: async (t) => {
        replies.push(t);
        return { message_id: 1 };
      },
    };
    const processAsText = vi.fn();
    const handler = makeDocumentHandler(
      { token: "t", processAsText },
      { api: { getFile: vi.fn() } },
    );
    await handler(ctx);
    expect(replies).toEqual([]);
    expect(processAsText).not.toHaveBeenCalled();
  });
});

describe("makeVoiceHandler", () => {
  test("no voice in message → silent no-op", async () => {
    const replies: string[] = [];
    const ctx: VoiceContext = {
      message: {},
      replyWithChatAction: async () => undefined,
      reply: async (t) => {
        replies.push(t);
        return { message_id: 1 };
      },
    };
    const processAsText = vi.fn();
    const handler = makeVoiceHandler(
      {
        token: "t",
        projectRoot: "/tmp",
        processAsText,
      },
      { api: { getFile: vi.fn() } },
    );
    await handler(ctx);
    expect(replies).toEqual([]);
    expect(processAsText).not.toHaveBeenCalled();
  });

  test("transcribe script failure surfaces a helpful error to the user", async () => {
    // Skip actual file download by failing fast at the transcribe step.
    // Inject a stub bot.api.getFile that throws, simulating download failure.
    const replies: string[] = [];
    const ctx: VoiceContext = {
      message: { voice: { file_id: "fid", duration: 2 } },
      replyWithChatAction: async () => undefined,
      reply: async (t) => {
        replies.push(t);
        return { message_id: 1 };
      },
    };
    const processAsText = vi.fn();
    const handler = makeVoiceHandler(
      {
        token: "t",
        projectRoot: "/tmp",
        processAsText,
      },
      {
        api: {
          getFile: async () => {
            throw new Error("network down");
          },
        },
      },
    );
    await handler(ctx);
    expect(processAsText).not.toHaveBeenCalled();
    expect(replies[0]).toMatch(/Had trouble with that voice note/);
  });
});

describe("makePhotoHandler", () => {
  test("no photo in message → silent no-op", async () => {
    const replies: string[] = [];
    const ctx: PhotoContext = {
      message: {},
      replyWithChatAction: async () => undefined,
      reply: async (t) => {
        replies.push(t);
        return { message_id: 1 };
      },
    };
    const processAsText = vi.fn();
    const handler = makePhotoHandler(
      { token: "t", processAsText },
      { api: { getFile: vi.fn() } },
    );
    await handler(ctx);
    expect(replies).toEqual([]);
    expect(processAsText).not.toHaveBeenCalled();
  });

  test("download failure surfaces a helpful error", async () => {
    const replies: string[] = [];
    const ctx: PhotoContext = {
      message: {
        photo: [
          { file_id: "small", width: 90, height: 90 },
          { file_id: "large", width: 1280, height: 720 },
        ],
        caption: "look at this",
      },
      replyWithChatAction: async () => undefined,
      reply: async (t) => {
        replies.push(t);
        return { message_id: 1 };
      },
    };
    const processAsText = vi.fn();
    const handler = makePhotoHandler(
      { token: "t", processAsText },
      {
        api: {
          getFile: async () => {
            throw new Error("api down");
          },
        },
      },
    );
    await handler(ctx);
    expect(processAsText).not.toHaveBeenCalled();
    expect(replies[0]).toMatch(/Had trouble with that image/);
  });
});
