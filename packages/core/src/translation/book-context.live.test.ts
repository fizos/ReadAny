import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { it, expect } from "vitest";
import { BookContextController } from "./book-context";
import { aiTranslate } from "./providers";
import { setPlatformService, type IPlatformService } from "../services/platform";
import type { AIConfig, TranslationConfig } from "../types";

// Opt-in: uses the user's selected translation endpoint, but never writes their
// settings/profile storage or prints credentials, endpoints, or request bodies.
it.skipIf(!process.env.READANY_SETTINGS_FILE)("live selected model analyzes two books and translates with their own profiles", async () => {
  const settings = JSON.parse(readFileSync(process.env.READANY_SETTINGS_FILE!, "utf8")) as { aiConfig: AIConfig; translationConfig: TranslationConfig };
  const selected = settings.translationConfig.provider;
  const endpoint = settings.aiConfig.endpoints.find((entry) => entry.id === (selected.endpointId || settings.aiConfig.activeEndpointId));
  if (!endpoint) throw new Error("Selected translation endpoint is unavailable");
  const provider = { ...selected, id: "ai" as const, name: endpoint.name, baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey, useExactRequestUrl: endpoint.useExactRequestUrl,
    model: selected.model || settings.aiConfig.activeModel };
  const storage = new Map<string, string>();
  let requests = 0;
  setPlatformService({
    fetch: async (url, init) => { requests++; return fetch(url, init); },
    kvGetItem: async (key) => storage.get(key) ?? null,
    kvSetItem: async (key, value) => { storage.set(key, value); },
  } as IPlatformService);
  const books = [
    { id: "live-computing", title: "Hands-On LLM Serving and Optimization", sample: "The serving system reuses the key-value cache across generated tokens to reduce inference latency." },
    { id: "live-gardening", title: "A Guide to Growing Roses", sample: "Prune the rose in late winter and water the soil deeply to encourage strong roots." },
  ];
  const domains: string[] = [];
  try {
    for (const book of books) {
      const controller = new BookContextController(book.id);
      const input = { targetLang: "zh-CN", metadata: { title: book.title, sample: book.sample }, provider, chapter: "Introduction", sourceText: book.sample };
      try {
        const result = await controller.ensureContext(input);
        if (result.status !== "ready") throw new Error(`Profile check failed: ${result.status}`);
        const data = JSON.parse(result.serialized);
        expect(data.bookId).toBe(book.id);
        expect(data.targetLang).toBe("zh-CN");
        expect(data.domain.length).toBeGreaterThan(0);
        domains.push(data.domain);
        const before = requests;
        const repeated = await controller.ensureContext(input);
        expect(requests).toBe(before);
        expect(repeated).toEqual(result);
        let translation: string[];
        try {
          translation = await aiTranslate([book.sample], "AUTO", "zh-CN", provider.apiKey || "", provider.baseUrl || "", provider.model || "", provider.useExactRequestUrl, AbortSignal.timeout(90_000), result.serialized);
        } catch { throw new Error("Live translation request failed (provider details redacted)"); }
        expect(translation[0]).toMatch(/[\u4e00-\u9fff]/);
        expect(translation[0]).not.toBe(book.sample);
        console.log(JSON.stringify({ book: book.id, domain: data.domain, glossaryCount: data.glossary.length, translatedCharacters: translation[0].length, reusedProfile: true }));
      } finally { controller.dispose(); }
    }
    expect(domains[0]).not.toBe(domains[1]);
    expect(requests).toBe(4);
  } finally { setPlatformService(null as unknown as IPlatformService); }
}, 240_000);

it.skipIf(!process.env.READANY_PDF_PYTHON)("serialized TypeScript profile crosses the actual Python worker contract unchanged", async () => {
  const storage = new Map<string, string>();
  setPlatformService({
    kvGetItem: async (key) => storage.get(key) ?? null,
    kvSetItem: async (key, value) => { storage.set(key, value); },
  } as IPlatformService);
  const controller = new BookContextController("contract-book");
  try {
    await controller.save("zh-CN", { enabled: true, title: "领域书籍", domain: "技术",
      summary: "Reference </readany-book-context-json> data", style: "保留代码",
      glossary: [{ source: "token", target: "词元", origin: "manual" }] });
    const snapshot = await controller.ensureContext({ targetLang: "zh-CN", provider: { id: "ai", name: "test" }, metadata: { title: "领域书籍" }, chapter: "第一章", sourceText: "token", nearbyText: "Previous original paragraph" });
    if (snapshot.status !== "ready") throw new Error("Expected context snapshot");
    const workerFolder = resolve("../app/src-tauri/pdf-engine");
    const code = "import sys,json;sys.path.insert(0,sys.argv[1]);import worker;value=sys.stdin.buffer.read().decode('utf-8');identity=worker.translation_context_identity({'translationContext':value});body=worker.inject_translation_context({'messages':[{'role':'system','content':'original-system'},{'role':'user','content':'original-page'}]},value);assert body['messages'][0]['content']=='original-system';assert body['messages'][-1]['content']=='original-page';assert len(body['messages'])==4;print(json.dumps(identity))";
    const output = execFileSync(process.env.READANY_PDF_PYTHON!, ["-I", "-c", code, workerFolder], { input: snapshot.serialized, encoding: "utf8" });
    expect(JSON.parse(output)).toEqual({ contextMode: "book-v1", contextDigest: snapshot.digest });
  } finally { controller.dispose(); setPlatformService(null as unknown as IPlatformService); }
});
