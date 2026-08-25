import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import LocalRuntimeControls from "../src/components/provider-workspace/LocalRuntimeControls";
import { LanguageProvider } from "../src/i18n/provider";

const originalFetch = globalThis.fetch;
const globalNames = [
  "document",
  "window",
  "navigator",
  "localStorage",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

let previousGlobals: Record<(typeof globalNames)[number], unknown>;
let testWindow: Window;

const runningStatus = {
  state: "running",
  revision: 7,
  requested: { profileId: "qwen38-27b-q6kl", nCtx: 184320 },
  effective: {
    profileId: "qwen38-27b-q6kl",
    nCtx: 184320,
    model: "huihui-qwen3.8-27b-abliterated-q6-k-l",
    verifiedAt: "2026-07-27T12:00:00.000Z",
  },
  lastKnownGood: { profileId: "qwen38-27b-q6kl", nCtx: 184320 },
  failure: null,
  pid: 4242,
  operationPending: false,
  controlEnabled: true,
  contextConstraints: { min: 16384, max: 184320, step: 1024 },
  contextCheckpoints: [131072, 184320],
};

beforeEach(() => {
  previousGlobals = Object.fromEntries(
    globalNames.map(key => [key, Reflect.get(globalThis, key)]),
  ) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#providers/workspace" });
  Object.defineProperty(testWindow.navigator, "language", {
    configurable: true,
    value: "en-US",
  });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  testWindow.close();
  for (const key of globalNames) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: previousGlobals[key],
    });
  }
});

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
  await Promise.resolve();
}

async function mount(): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <LocalRuntimeControls apiBase="http://localhost" />
      </LanguageProvider>,
    );
  });
  await act(async () => {
    await flush();
  });
  return { root, container };
}

test("shows requested, effective, last-known-good, and owned process state", async () => {
  globalThis.fetch = (async () => Response.json(runningStatus)) as typeof fetch;

  const { root, container } = await mount();
  try {
    expect(container.textContent).toContain("Running and verified");
    expect(container.textContent).toContain("Requested nCtx");
    expect(container.textContent).toContain("Effective nCtx");
    expect(container.textContent).toContain("Last-known-good nCtx");
    expect(container.textContent).toContain("4242");
    const context = container.querySelector<HTMLSelectElement>("#local-runtime-context");
    expect(context?.value).toBe("184320");
    expect([...context!.options].map(option => option.value)).toEqual([
      "131072", "184320",
    ]);
  } finally {
    await act(async () => root.unmount());
  }
});

test("applies only the fixed profile, fixed nCtx choice, and observed revision", async () => {
  let applyBody: unknown;
  let gets = 0;
  let applySeen = false;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/local-runtime/apply")) {
      applySeen = true;
      applyBody = JSON.parse(String(init?.body));
      return Response.json({
        status: {
          ...runningStatus,
          state: "restarting",
          revision: 8,
          requested: { profileId: "qwen38-27b-q6kl", nCtx: 131072 },
          operationPending: true,
        },
      });
    }
    gets += 1;
    return Response.json(applySeen && gets > 1
      ? {
          ...runningStatus,
          revision: 8,
          requested: { profileId: "qwen38-27b-q6kl", nCtx: 131072 },
          effective: { ...runningStatus.effective, nCtx: 131072 },
          lastKnownGood: { profileId: "qwen38-27b-q6kl", nCtx: 131072 },
        }
      : runningStatus);
  }) as typeof fetch;

  const { root, container } = await mount();
  try {
    const context = container.querySelector<HTMLSelectElement>("#local-runtime-context")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(testWindow.HTMLSelectElement.prototype, "value")!
        .set!.call(context, "131072");
      context.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
    });

    const apply = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.includes("Apply & restart"));
    expect(apply?.disabled).toBe(false);

    await act(async () => {
      apply!.click();
      await flush();
    });

    expect(applyBody).toEqual({
      profileId: "qwen38-27b-q6kl",
      nCtx: 131072,
      // Sent explicitly rather than left to the server default, so the applied
      // thinking depth is whatever the form was showing.
      reasoningEffort: "xhigh",
      expectedRevision: 7,
    });
  } finally {
    await act(async () => root.unmount());
  }
});

test("does not expose arbitrary or obsolete Qwen context values", async () => {
  globalThis.fetch = (async () => Response.json(runningStatus)) as typeof fetch;

  const { root, container } = await mount();
  try {
    const context = container.querySelector<HTMLSelectElement>("#local-runtime-context")!;
    const values = [...context.options].map(option => Number(option.value));
    expect(values).not.toContain(8192);
    expect(values).not.toContain(49152);
    expect(values).not.toContain(98304);
    expect(values).toEqual([131072, 184320]);
  } finally {
    await act(async () => root.unmount());
  }
});

test("clears a transient status error after a successful manual refresh", async () => {
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("transient");
    return Response.json(runningStatus);
  }) as typeof fetch;

  const { root, container } = await mount();
  try {
    expect(container.textContent).toContain(
      "Could not load the local runtime status.",
    );
    const refresh = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.includes("Refresh status"))!;
    await act(async () => {
      refresh.click();
      await flush();
    });
    expect(container.textContent).toContain("Running and verified");
    expect(container.textContent).not.toContain(
      "Could not load the local runtime status.",
    );
  } finally {
    await act(async () => root.unmount());
  }
});
