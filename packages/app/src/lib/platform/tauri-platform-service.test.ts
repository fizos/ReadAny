import { afterEach, describe, expect, it, vi } from "vitest";
import { TauriPlatformService } from "./tauri-platform-service";

describe("TauriPlatformService web capability", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("detects a Tauri runtime that becomes available after service construction", () => {
    vi.stubGlobal("window", {});
    const service = new TauriPlatformService();

    expect(service.capabilities.safeWebFetch).toBe(false);

    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });

    expect(service.capabilities.safeWebFetch).toBe(true);
  });

  it("does not advertise web tools in a browser runtime", () => {
    vi.stubGlobal("window", {});

    expect(new TauriPlatformService().capabilities.safeWebFetch).toBe(false);
  });
});
