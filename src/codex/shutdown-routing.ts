import { markJournalIntentionalShutdown } from "./journal";

let preservedForExit = false;

/** Persist the companion handoff before acknowledging its stop request. */
export function preserveCodexRoutingForExit(): void {
  markJournalIntentionalShutdown();
  preservedForExit = true;
}

/** The exit handler must honor the same decision as the authenticated stop route. */
export function isCodexRoutingPreservedForExit(): boolean {
  return preservedForExit;
}
