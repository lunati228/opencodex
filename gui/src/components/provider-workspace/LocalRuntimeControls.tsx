import { useCallback, useEffect, useRef, useState } from "react";
import { readJsonOrThrow } from "../../fetch-json";
import { IconRefresh } from "../../icons";
import { useT } from "../../i18n/shared";

type ProfileId = "qwen38-27b-q6kl";
type ReasoningEffort = "off" | "low" | "medium" | "xhigh";
type Candidate = {
  profileId: ProfileId;
  nCtx: number;
  reasoningEffort?: ReasoningEffort;
};
type Effective = Candidate & { model: string; verifiedAt: string };
type ContextConstraints = { min: number; max: number; step: number };
type ProfileDescriptor = {
  id: ProfileId;
  label: string;
  modelId: string;
  context: ContextConstraints;
  contextCheckpoints?: number[];
  defaultContext: number;
  defaultReasoningEffort: ReasoningEffort;
  reasoningEfforts: ReasoningEffort[];
  measuredTokensPerSecond: number;
  measurementNote: string;
};
type RuntimeStatus = {
  state:
    | "stopped"
    | "starting"
    | "running"
    | "restarting"
    | "stopping"
    | "rolled-back"
    | "failed"
    | "blocked-foreign-port";
  revision: number;
  requested: Candidate | null;
  effective: Effective | null;
  lastKnownGood: Candidate | null;
  failure: string | null;
  pid: number | null;
  operationPending: boolean;
  controlEnabled: boolean;
  profileId?: ProfileId;
  contextConstraints: ContextConstraints;
  contextCheckpoints?: number[];
  /** Optional descriptor for the managed Qwen runtime. */
  profiles?: ProfileDescriptor[];
  reasoningEfforts?: ReasoningEffort[];
};

const PROFILE_ID = "qwen38-27b-q6kl" as const;
const FALLBACK_CONTEXT_CONSTRAINTS = { min: 16384, max: 196608, step: 16384 };
const FALLBACK_REASONING_EFFORTS: ReasoningEffort[] = ["off", "low", "medium", "xhigh"];
/** Used only before the first status arrives, or if the server omits profiles. */
const FALLBACK_CONTEXT = 196608;
const FALLBACK_REASONING: ReasoningEffort = "xhigh";
type RuntimeMessage = {
  ok: boolean;
  source: "action" | "status";
  text: string;
};

function isAllowedContextValue(
  value: number,
  constraints: RuntimeStatus["contextConstraints"],
  checkpoints?: readonly number[],
): boolean {
  return Number.isInteger(value)
    && value >= constraints.min
    && value <= constraints.max
    && (value - constraints.min) % constraints.step === 0
    && (!checkpoints?.length || checkpoints.includes(value));
}

/** What the Qwen controls are showing, before it is applied. */
type Draft = {
  profileId: ProfileId;
  nCtx: number;
  reasoningEffort: ReasoningEffort;
};

/**
 * The draft the form should show for a given server status.
 *
 * Shared by the poll handler and the Reset button so the two can never drift:
 * both must fall back through requested -> effective -> last-known-good, then
 * to Qwen's declared defaults.
 */
function draftFromStatus(status: RuntimeStatus | null): Draft {
  const source = status?.requested ?? status?.effective ?? status?.lastKnownGood;
  const profileId = source?.profileId ?? status?.profileId ?? PROFILE_ID;
  const descriptor = status?.profiles?.find(entry => entry.id === profileId);
  return {
    profileId,
    nCtx: source?.nCtx ?? descriptor?.defaultContext ?? FALLBACK_CONTEXT,
    reasoningEffort: source?.reasoningEffort
      ?? descriptor?.defaultReasoningEffort
      ?? FALLBACK_REASONING,
  };
}

function statusLabel(
  state: RuntimeStatus["state"] | undefined,
  t: ReturnType<typeof useT>,
): string {
  switch (state) {
    case "starting": return t("localRuntime.state.starting");
    case "running": return t("localRuntime.state.running");
    case "restarting": return t("localRuntime.state.restarting");
    case "stopping": return t("localRuntime.state.stopping");
    case "rolled-back": return t("localRuntime.state.rolledBack");
    case "failed": return t("localRuntime.state.failed");
    case "blocked-foreign-port": return t("localRuntime.state.foreignPort");
    case "stopped": return t("localRuntime.state.stopped");
    default: return t("localRuntime.state.loading");
  }
}

export default function LocalRuntimeControls({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [draftNCtx, setDraftNCtx] = useState(FALLBACK_CONTEXT);
  const [draftNCtxInput, setDraftNCtxInput] = useState(String(FALLBACK_CONTEXT));
  const [draftDirty, setDraftDirty] = useState(false);
  const [draftProfileId, setDraftProfileId] = useState<ProfileId>(PROFILE_ID);
  const [draftReasoning, setDraftReasoning] = useState<ReasoningEffort>(FALLBACK_REASONING);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<RuntimeMessage | null>(null);
  const mountedRef = useRef(false);
  const statusRef = useRef<RuntimeStatus | null>(null);
  const draftEditingRef = useRef(false);
  const statusRequestRef = useRef(0);
  const statusInFlightRef = useRef<Promise<void> | null>(null);
  const latestRevisionRef = useRef(-1);
  const statusFailureCountRef = useRef(0);
  const mutationInFlightRef = useRef(false);

  const setContextDraft = useCallback((nCtx: number, dirty: boolean) => {
    setDraftNCtx(nCtx);
    setDraftNCtxInput(String(nCtx));
    draftEditingRef.current = dirty;
    setDraftDirty(dirty);
  }, []);

  /** Loads a draft into the Qwen controls at once, marked clean. */
  const applyDraft = useCallback((draft: Draft) => {
    setDraftProfileId(draft.profileId);
    setDraftReasoning(draft.reasoningEffort);
    setContextDraft(draft.nCtx, false);
  }, [setContextDraft]);

  const acceptStatus = useCallback((next: RuntimeStatus): boolean => {
    if (next.revision < latestRevisionRef.current) return false;
    latestRevisionRef.current = next.revision;
    statusRef.current = next;
    setStatus(next);
    if (!draftEditingRef.current) applyDraft(draftFromStatus(next));
    if (next.failure || next.state === "rolled-back") {
      setMessage(previous => {
        if (previous?.source === "status") return null;
        return previous?.ok ? null : previous;
      });
    } else {
      setMessage(previous => previous?.source === "status" ? null : previous);
    }
    return true;
  }, [applyDraft]);

  const fetchStatus = useCallback((): Promise<void> => {
    if (statusInFlightRef.current) return statusInFlightRef.current;
    const request = statusRequestRef.current + 1;
    statusRequestRef.current = request;
    const operation = (async () => {
      try {
        const response = await fetch(`${apiBase}/api/local-runtime/status`);
        const next = await readJsonOrThrow<RuntimeStatus>(
          response,
          t("localRuntime.loadFailed"),
        );
        if (!next) throw new Error(t("localRuntime.loadFailed"));
        if (!mountedRef.current || request !== statusRequestRef.current) return;
        statusFailureCountRef.current = 0;
        acceptStatus(next);
      } catch {
        statusFailureCountRef.current += 1;
        if (mountedRef.current && request === statusRequestRef.current) {
          setMessage({
            ok: false,
            source: "status",
            text: statusRef.current
              ? t("localRuntime.statusStale")
              : t("localRuntime.loadFailed"),
          });
        }
      }
    })();
    statusInFlightRef.current = operation;
    void operation.then(() => {
      if (statusInFlightRef.current === operation) {
        statusInFlightRef.current = null;
      }
    });
    return operation;
  }, [acceptStatus, apiBase, t]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      statusRequestRef.current += 1;
      statusInFlightRef.current = null;
    };
  }, []);

  useEffect(() => {
    let timer: number | undefined;
    let cancelled = false;
    const schedule = (delay: number) => {
      if (cancelled || document.visibilityState !== "visible") return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(poll, delay);
    };
    const poll = async () => {
      timer = undefined;
      if (cancelled || document.visibilityState !== "visible") return;
      await fetchStatus();
      if (cancelled || document.visibilityState !== "visible") return;
      const failureBackoff = [0, 2_000, 5_000, 10_000, 30_000][
        Math.min(statusFailureCountRef.current, 4)
      ] ?? 30_000;
      const normalDelay = status?.operationPending ? 1_000 : 10_000;
      schedule(failureBackoff > 0 ? failureBackoff : normalDelay);
    };
    schedule(0);
    const onVisibilityChange = () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
      if (document.visibilityState === "visible") schedule(0);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [fetchStatus, status?.operationPending]);

  const mutate = async (
    action: "start" | "stop" | "apply",
    body?: Record<string, unknown>,
  ): Promise<void> => {
    if (mutationInFlightRef.current) return;
    mutationInFlightRef.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`${apiBase}/api/local-runtime/${action}`, {
        method: "POST",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await response.json().catch(() => null) as {
        reason?: string;
        error?: string;
        status?: RuntimeStatus;
      } | null;
      if (!response.ok) {
        if (data?.status) acceptStatus(data.status);
        const stale = data?.reason === "stale-revision";
        setMessage({
          ok: false,
          source: "action",
          text: stale
            ? t("localRuntime.staleRevision")
            : (data?.error || data?.reason || t("localRuntime.actionFailed")),
        });
        if (stale) await fetchStatus();
        return;
      }
      if (data?.status) acceptStatus(data.status);
      setContextDraft(
        data?.status?.requested?.nCtx
        ?? data?.status?.effective?.nCtx
        ?? draftNCtx,
        false,
      );
      setMessage({
        ok: true,
        source: "action",
        text: action === "apply"
          ? t("localRuntime.restartAccepted")
          : t("localRuntime.actionAccepted"),
      });
      await fetchStatus();
    } catch {
      setMessage({
        ok: false,
        source: "action",
        text: t("localRuntime.actionFailed"),
      });
    } finally {
      mutationInFlightRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const pending = busy || status?.operationPending === true;
  const canControl = status?.controlEnabled === true;
  // A failed stop deliberately retains the owned PID so the operator can retry.
  // Process ownership, not a friendly state label, decides whether Stop is shown.
  const active = status?.pid != null;
  const requested = status?.requested?.nCtx;
  const effective = status?.effective?.nCtx;
  const lkg = status?.lastKnownGood?.nCtx;
  const profiles = status?.profiles ?? [];
  const draftProfile = profiles.find(entry => entry.id === draftProfileId);
  // Constraints follow the Qwen descriptor from the current status response.
  const constraints = draftProfile?.context
    ?? status?.contextConstraints
    ?? FALLBACK_CONTEXT_CONSTRAINTS;
  const contextCheckpoints = draftProfile
    ? draftProfile.contextCheckpoints
    : status?.contextCheckpoints;
  const reasoningEfforts = status?.reasoningEfforts ?? FALLBACK_REASONING_EFFORTS;
  const numericDraftValue = Number(draftNCtxInput);
  const numericDraftValid = isAllowedContextValue(
    numericDraftValue,
    constraints,
    contextCheckpoints,
  );

  return (
    <div className="pwi-settings-form local-runtime-controls">
      <section className="pws-section" aria-labelledby="local-runtime-heading">
        <div className="local-runtime-heading-row">
          <div>
            <h3 id="local-runtime-heading" className="pws-section-title">
              {t("localRuntime.title")}
            </h3>
            <p className="muted local-runtime-description">
              {t("localRuntime.description")}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void fetchStatus()}
            disabled={pending}
          >
            <IconRefresh width={14} aria-hidden="true" />
            {t("localRuntime.refresh")}
          </button>
        </div>

        <dl className="pws-kv local-runtime-status-grid" aria-live="polite">
          <div className="pws-kv-row">
            <dt>{t("localRuntime.status")}</dt>
            <dd>{statusLabel(status?.state, t)}</dd>
          </div>
          <div className="pws-kv-row">
            <dt>{t("localRuntime.requested")}</dt>
            <dd className="mono">{requested ?? "—"}</dd>
          </div>
          <div className="pws-kv-row">
            <dt>{t("localRuntime.effective")}</dt>
            <dd className="mono">{effective ?? "—"}</dd>
          </div>
          <div className="pws-kv-row">
            <dt>{t("localRuntime.lastKnownGood")}</dt>
            <dd className="mono">{lkg ?? "—"}</dd>
          </div>
          <div className="pws-kv-row">
            <dt>{t("localRuntime.process")}</dt>
            <dd className="mono">{status?.pid ?? "—"}</dd>
          </div>
        </dl>

        {status?.failure && (
          <p className="pwi-settings-msg pwi-settings-msg--err" role="alert">
            {t("localRuntime.failure", { reason: status.failure })}
          </p>
        )}

        <div className="local-runtime-select-row">
          <label htmlFor="local-runtime-reasoning">
            {t("localRuntime.reasoningLabel")}
          </label>
          <select
            id="local-runtime-reasoning"
            className="input local-runtime-reasoning-select"
            value={draftReasoning}
            disabled={pending || !canControl}
            aria-describedby="local-runtime-reasoning-hint"
            onChange={event => {
              setDraftReasoning(event.target.value as ReasoningEffort);
              draftEditingRef.current = true;
              setDraftDirty(true);
            }}
          >
            {reasoningEfforts.map(effort => (
              <option key={effort} value={effort}>
                {t(`localRuntime.reasoning.${effort}`)}
              </option>
            ))}
          </select>
          <p id="local-runtime-reasoning-hint" className="muted text-label">
            {t("localRuntime.reasoningHint")}
          </p>
        </div>

        <fieldset className="local-runtime-context-control">
          <legend className="sr-only">{t("localRuntime.contextLabel")}</legend>
          <div className="local-runtime-context-label-row">
            <label htmlFor="local-runtime-context">
              {t("localRuntime.contextLabel")}
            </label>
            <div className="local-runtime-context-value">
              {contextCheckpoints?.length ? (
                <select
                  id="local-runtime-context"
                  className="input mono local-runtime-context-number"
                  value={draftNCtx}
                  aria-describedby="local-runtime-context-hint"
                  disabled={pending || !canControl}
                  onChange={event => setContextDraft(Number(event.target.value), true)}
                >
                  {contextCheckpoints.map(value => (
                    <option key={value} value={value}>
                      {value % 1024 === 0
                        ? t("localRuntime.contextCheckpoint", { value: value / 1024 })
                        : value}
                    </option>
                  ))}
                </select>
              ) : (
                <>
                  <label className="sr-only" htmlFor="local-runtime-context-number">
                    {t("localRuntime.contextInputLabel")}
                  </label>
                  <input
                    id="local-runtime-context-number"
                    className="input mono local-runtime-context-number"
                    type="number"
                    min={constraints.min}
                    max={constraints.max}
                    step={constraints.step}
                    value={draftNCtxInput}
                    aria-invalid={!numericDraftValid}
                    aria-describedby="local-runtime-context-hint"
                    disabled={pending || !canControl}
                    onChange={event => {
                      const text = event.currentTarget.value;
                      setDraftNCtxInput(text);
                      draftEditingRef.current = true;
                      const value = Number(text);
                      if (isAllowedContextValue(value, constraints)) {
                        setDraftNCtx(value);
                        setDraftDirty(true);
                      }
                    }}
                    onBlur={() => {
                      if (!numericDraftValid) {
                        setDraftNCtxInput(String(draftNCtx));
                        draftEditingRef.current = draftDirty;
                      }
                    }}
                  />
                </>
              )}
            </div>
          </div>
          {!contextCheckpoints?.length && (
            <input
              id="local-runtime-context"
              type="range"
              min={constraints.min}
              max={constraints.max}
              step={constraints.step}
              value={draftNCtx}
              aria-describedby="local-runtime-context-hint"
              disabled={pending || !canControl}
              onChange={event => {
                setContextDraft(Number(event.target.value), true);
              }}
            />
          )}
          <p id="local-runtime-context-hint" className="muted text-label">
            {contextCheckpoints?.length
              ? t("localRuntime.contextChoicesHint", {
                  choices: contextCheckpoints
                    .map(value => t("localRuntime.contextCheckpoint", { value: value / 1024 }))
                    .join(", "),
                })
              : t("localRuntime.contextHint", {
                  min: constraints.min,
                  max: constraints.max,
                  step: constraints.step,
                })}
          </p>
        </fieldset>

        <div className="local-runtime-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={pending || !canControl || !draftDirty || !numericDraftValid}
            onClick={() => void mutate("apply", {
              profileId: draftProfileId,
              nCtx: draftNCtx,
              reasoningEffort: draftReasoning,
              expectedRevision: status?.revision ?? -1,
            })}
          >
            {pending ? t("localRuntime.working") : t("localRuntime.applyRestart")}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={pending || !draftDirty}
            onClick={() => applyDraft(draftFromStatus(status))}
          >
            {t("localRuntime.resetDraft")}
          </button>
          {active ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={pending}
              onClick={() => void mutate("stop")}
            >
              {t("localRuntime.stop")}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={pending || !canControl}
              onClick={() => void mutate("start")}
            >
              {t("localRuntime.start")}
            </button>
          )}
        </div>

        {message && (
          <p
            className={message.ok
              ? "pwi-settings-msg pwi-settings-msg--ok"
              : "pwi-settings-msg pwi-settings-msg--err"}
            role={message.ok ? "status" : "alert"}
          >
            {message.text}
          </p>
        )}
      </section>

      <section className="pws-section local-runtime-cap-note">
        <h3 className="pws-section-title">{t("localRuntime.requestCapTitle")}</h3>
        <p className="muted">{t("localRuntime.requestCapHint")}</p>
      </section>
    </div>
  );
}
