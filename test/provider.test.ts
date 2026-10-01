import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Provider } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { accountProvider } from "../src/provider.ts";
import { NATIVE, providerFor } from "../src/accounts.ts";

const message = (provider: string): AssistantMessage => ({
  role: "assistant", provider, model: "gpt-test", api: "openai-codex-responses", content: [], stopReason: "stop", timestamp: 1,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

test("delegates streams, preserves options and tools, and keeps account ownership distinct", async () => {
  const native = openaiCodexProvider();
  const id = providerFor(2);
  const system = { role: "system" as const, content: "Keep these tools", timestamp: 0 };
  const own = message(id);
  const foreign = message(NATIVE);
  const context = normalizeContext({ messages: [system, own, foreign] });
  const options = { apiKey: "test-key", signal: new AbortController().signal };
  let calls = 0;
  const stream: Provider<"openai-codex-responses">["streamSimple"] = (model, passedContext, passedOptions) => {
    calls++;
    assert.equal(model.provider, NATIVE);
    assert.equal(passedOptions, options);
    assert.equal(passedContext.messages[0], system);
    assert.equal((passedContext.messages[1] as AssistantMessage).provider, NATIVE);
    assert.notEqual((passedContext.messages[2] as AssistantMessage).provider, NATIVE);
    const result = createAssistantMessageEventStream();
    result.push({ type: "start", partial: message(NATIVE) });
    result.push({ type: "done", reason: "stop", message: message(NATIVE) });
    result.end();
    return result;
  };
  const alias = accountProvider({ ...native, streamSimple: stream }, id, "Second account");
  const model = alias.getModels()[0];
  assert.equal(model.provider, id);
  assert.equal(alias.auth, native.auth);
  const events = [];
  for await (const event of alias.streamSimple(model, context, options)) events.push(event);
  assert.equal(calls, 1);
  assert.equal(events[0].type, "start");
  assert.equal(events.at(-1)?.type, "done");
  assert.equal((events.at(-1) as { message: AssistantMessage }).message.provider, id);
  assert.equal(own.provider, id);
  assert.equal(foreign.provider, NATIVE);
});

test("passes terminal errors through under the selected account", async () => {
  const native = openaiCodexProvider();
  const alias = accountProvider({ ...native, streamSimple: () => {
    const result = createAssistantMessageEventStream();
    result.push({ type: "error", reason: "aborted", error: { ...message(NATIVE), stopReason: "aborted", errorMessage: "cancelled" } });
    result.end();
    return result;
  } }, providerFor(2), "Second");
  const result = await alias.streamSimple(alias.getModels()[0], normalizeContext({ messages: [] })).result();
  assert.equal(result.provider, providerFor(2));
  assert.equal(result.stopReason, "aborted");
  assert.equal(result.errorMessage, "cancelled");
});

test("native request conversion preserves tool-call pairs through an account alias", async () => {
  const alias = accountProvider(openaiCodexProvider(), providerFor(2), "Second");
  const model = alias.getModels().find(model => model.id === "gpt-5.5")!;
  const toolCall = { type: "toolCall" as const, id: "call_test|fc_test", name: "read", arguments: { path: "file.txt" } };
  const context = normalizeContext({ messages: [
    { role: "user", content: "Read file.txt", timestamp: 0 },
    { ...message(alias.id), model: model.id, content: [toolCall], stopReason: "toolUse" },
    { role: "toolResult", toolCallId: toolCall.id, toolName: "read", content: [{ type: "text", text: "file contents" }], isError: false, timestamp: 2 },
  ] });
  let payload: any;
  const apiKey = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64url")}.x`;
  const result = await alias.streamSimple(model, context, {
    apiKey, transport: "sse",
    onPayload: body => { payload = body; throw new Error("test: stop before network"); },
  }).result();
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage!, /stop before network/);
  const call = payload.input.find((item: any) => item.type === "function_call");
  const output = payload.input.find((item: any) => item.type === "function_call_output");
  assert.equal(call.call_id, "call_test");
  assert.equal(output.call_id, call.call_id);
  assert.equal(output.output, "file contents");
});
