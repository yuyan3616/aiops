import assert from "node:assert/strict";
import test from "node:test";

import { ConversationViewBuilder, extractImages, extractText, resultText } from "./helper";

test("extracts text and images in source order", () => {
  const content = [
    { type: "text", text: "first" },
    { type: "image", data: "data", mimeType: "image/png" },
    { type: "text", text: "second" },
  ] as Parameters<typeof extractText>[0];

  assert.equal(extractText(content), "firstsecond");
  assert.deepEqual(extractImages(content), [
    { type: "image", data: "data", mimeType: "image/png" },
  ]);
  assert.equal(
    resultText({
      content: [
        { type: "text", text: "" },
        { type: "text", text: "next" },
      ],
    }),
    "\nnext",
  );
});


test("conversation history exposes assistant provider failures instead of an empty reply", () => {
  type Entry = ConstructorParameters<typeof ConversationViewBuilder>[0][number];
  const entry = {
    type: "message",
    id: "assistant-error",
    timestamp: 1000,
    message: {
      role: "assistant",
      content: [],
      errorMessage: "API key has been disabled",
    },
  } as unknown as Entry;

  const items = new ConversationViewBuilder([entry]).build();

  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, "message");
  if (items[0]?.kind !== "message") return;
  assert.equal(items[0].message.text, "");
  assert.equal(
    items[0].message.error,
    "模型服务认证失败，当前 API Key 可能已失效或被禁用，请检查模型配置后重新发送。",
  );
});
