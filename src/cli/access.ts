import {
  CliUsageError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  takeFlag,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";

const USAGE = `Usage:
  ocx access key [list] [--json]
  ocx access key create [name] [--json]
  ocx access key remove <id> --yes [--json]
  ocx access endpoints [--json]
  ocx access models [--json]
  ocx access test <model> [--protocol <chat|responses|messages>] [--json]`;

const RESPONSES_TERMINALS = new Set([
  "response.completed",
  "response.failed",
  "response.incomplete",
  "error",
]);

function requireCompletedResponsesTerminal(result: unknown): void {
  if (typeof result !== "string") {
    throw new Error("Responses access test ended without a terminal event.");
  }

  const terminals: string[] = [];
  for (const frame of result.split(/\r?\n\r?\n/)) {
    const lines = frame.split(/\r?\n/);
    const eventName = lines
      .find(line => line.startsWith("event:"))
      ?.slice("event:".length)
      .trim();
    const dataText = lines
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice("data:".length).trimStart())
      .join("\n")
      .trim();
    if (!dataText || dataText === "[DONE]") continue;

    let data: unknown;
    try {
      data = JSON.parse(dataText) as unknown;
    } catch {
      throw new Error("Responses access test returned malformed SSE.");
    }
    const type = data && typeof data === "object" && typeof (data as Record<string, unknown>).type === "string"
      ? (data as Record<string, unknown>).type as string
      : undefined;
    if (eventName && type && eventName !== type) {
      throw new Error("Responses access test returned inconsistent SSE event types.");
    }
    if (type && RESPONSES_TERMINALS.has(type)) terminals.push(type);
  }

  if (terminals.length !== 1) {
    throw new Error(terminals.length === 0
      ? "Responses access test ended without a terminal event."
      : "Responses access test returned multiple terminal events.");
  }
  if (terminals[0] !== "response.completed") {
    throw new Error(`Responses access test ended with ${terminals[0]}.`);
  }
}

async function key(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const action = (args.shift() ?? "list").toLowerCase();
  const wantsJson = takeFlag(args, "--json");
  if (action === "list") {
    rejectArgs(args, USAGE);
    const result = await runtimeRequest<Record<string, unknown>>("/api/keys", {}, deps);
    const keys = Array.isArray(result.keys) ? result.keys as Array<Record<string, unknown>> : [];
    printData(result, wantsJson, keys.length
      ? keys.map(entry => `${String(entry.id)}  ${String(entry.name)}  ${String(entry.prefix ?? "")}`)
      : ["No API access keys configured."]);
    return;
  }
  if (action === "create") {
    const name = args.shift() ?? "default";
    rejectArgs(args, USAGE);
    const result = await runtimeRequest<Record<string, unknown>>("/api/keys", {
      method: "POST",
      body: JSON.stringify({ name }),
    }, deps);
    // The plaintext key is returned once. Keep text output explicit so callers know to store it.
    printData(result, wantsJson, [
      `Created API key ${String(result.name ?? name)} (${String(result.id ?? "")}).`,
      `Key (shown once): ${String(result.key ?? "")}`,
    ]);
    return;
  }
  if (action === "remove" || action === "delete") {
    const id = args.shift();
    const yes = takeFlag(args, "--yes");
    if (!id) throw new CliUsageError("key id is required", USAGE);
    if (!yes) throw new CliUsageError("remove requires --yes", USAGE);
    rejectArgs(args, USAGE);
    const result = await runtimeRequest("/api/keys", { method: "DELETE", body: JSON.stringify({ id }) }, deps);
    printData(result, wantsJson, [`Removed API key ${id}.`]);
    return;
  }
  throw new CliUsageError(`unknown key command ${action}`, USAGE);
}

async function endpoints(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<Record<string, unknown>>("/api/keys", {}, deps);
  const view = Object.fromEntries(Object.entries(result).filter(([key]) => key.endsWith("Endpoint") || key === "baseUrl" || key === "endpoint"));
  printData(view, wantsJson, Object.entries(view).map(([name, value]) => `${name}: ${String(value)}`));
}

async function models(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<Record<string, unknown>>("/v1/models", {}, deps);
  const rows = Array.isArray(result.data) ? result.data as Array<Record<string, unknown>> : [];
  printData(result, wantsJson, rows.map(row => `${String(row.id)}  ${String(row.owned_by ?? "")}`.trimEnd()));
}

async function testModel(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const model = args.shift();
  const wantsJson = takeFlag(args, "--json");
  const protocol = takeOption(args, "--protocol") ?? "chat";
  if (!model) throw new CliUsageError("model is required", USAGE);
  if (!(["chat", "responses", "messages"] as const).includes(protocol as "chat" | "responses" | "messages")) {
    throw new CliUsageError("--protocol must be chat, responses, or messages", USAGE);
  }
  rejectArgs(args, USAGE);
  const request = protocol === "responses"
    ? {
      path: "/v1/responses",
      body: {
        model,
        instructions: "Reply with OK.",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        stream: true,
        store: false,
      },
    }
    : protocol === "messages"
      ? { path: "/v1/messages", body: { model, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 16 } }
      : { path: "/v1/chat/completions", body: { model, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 16, stream: false } };
  const result = await runtimeRequest(request.path, {
    method: "POST",
    headers: protocol === "responses" ? { Accept: "text/event-stream" } : undefined,
    body: JSON.stringify(request.body),
  }, deps);
  if (protocol === "responses") requireCompletedResponsesTerminal(result);
  printData(result, wantsJson, [`${model}: ${protocol} request succeeded.`]);
}

export async function handleAccessCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const [sub = "key", ...rest] = argv;
    if (sub === "key" || sub === "keys") await key(rest, deps);
    else if (sub === "endpoints") await endpoints(rest, deps);
    else if (sub === "models") await models(rest, deps);
    else if (sub === "test") await testModel(rest, deps);
    else throw new CliUsageError(`unknown access command ${sub}`, USAGE);
  });
}

export const ACCESS_USAGE = USAGE;
