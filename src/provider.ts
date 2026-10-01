import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Model, type Provider, type TranscriptContext } from "@earendil-works/pi-ai";
import { NATIVE } from "./accounts.ts";

type CodexProvider = Provider<"openai-codex-responses">;
type CodexModel = Model<"openai-codex-responses">;

function ownedBy(message: AssistantMessage, provider: string): AssistantMessage {
  return { ...message, provider, ...(message.deferred ? { deferred: { ...message.deferred, provider } } : {}) };
}

function streamAs(source: AssistantMessageEventStream, model: CodexModel): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  void (async () => {
    try {
      for await (const event of source) {
        output.push(event.type === "done" ? { ...event, message: ownedBy(event.message, model.provider) }
          : event.type === "error" ? { ...event, error: ownedBy(event.error, model.provider) }
          : { ...event, partial: ownedBy(event.partial, model.provider) });
      }
    } catch (error) {
      output.push({ type: "error", reason: "error", error: {
        role: "assistant", provider: model.provider, api: model.api, model: model.id,
        content: [], stopReason: "error", timestamp: Date.now(),
        errorMessage: error instanceof Error ? error.message : String(error),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } });
    } finally {
      output.end();
    }
  })();
  return output;
}

export function accountProvider(native: CodexProvider, id: string, name: string): CodexProvider {
  const nativeModel = (model: CodexModel): CodexModel => ({ ...model, provider: NATIVE });
  const contextFor = (context: TranscriptContext): TranscriptContext => ({
    ...context,
    messages: context.messages.map(message => {
      if (message.role !== "assistant") return message;
      // Only this account's messages are native here. Other accounts must stay foreign
      // so Pi does not replay account-bound reasoning as if it belonged to this account.
      if (message.provider === id) return ownedBy(message, NATIVE);
      if (message.provider === NATIVE) return ownedBy(message, id);
      return message;
    }),
  });
  return {
    id, name, auth: native.auth, baseUrl: native.baseUrl, headers: native.headers,
    getModels: () => native.getModels().map(model => ({ ...model, provider: id })),
    stream: (model, context, options) => streamAs(native.stream(nativeModel(model), contextFor(context), options), model),
    streamSimple: (model, context, options) => streamAs(native.streamSimple(nativeModel(model), contextFor(context), options), model),
    ...(native.filterModels ? { filterModels: (models, credential) => native.filterModels!(models.map(nativeModel), credential).map(model => ({ ...model, provider: id })) } : {}),
    ...(native.fetchDeferred ? { fetchDeferred: (model, handle, options) => streamAs(native.fetchDeferred!(nativeModel(model), { ...handle, provider: NATIVE }, options), model) } : {}),
    ...(native.cancelDeferred ? { cancelDeferred: (model, handle, options) => native.cancelDeferred!(nativeModel(model), { ...handle, provider: NATIVE }, options) } : {}),
  };
}
