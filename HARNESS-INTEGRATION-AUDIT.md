# Harness migration: OpenCodex and model integration audit

## Scope and status

This is the documentation record of the migration chat's source/history audit, reconciled on 2026-09-10. It distinguishes committed implementation, recorded diagnostics, retained requirements and unverified outcomes. It is not a new runtime inspection or authorization to continue work. Implementation, agents, installations, launches and acceptance tests remain paused under the maintenance notices in the [fork README](README-FORK.md) and [backlog](BACKLOG.md).

The audited migration uses OpenCodex for local-model lifecycle and verified readiness, while Harness sends research inference directly to the local model. Tor and the managed Brave/VPN transport belong to Harness's privacy web integration, not OpenCodex model routing. No Windows kernel driver or second model supervisor was created.

The later proposal to remove OpenCodex's management dependency from Harness is not implemented, configured or tested by this migration. It must not be confused with the already implemented direct inference path.

## Source boundary and attribution

The OpenCodex implementation baseline is `ccb43ba7a`. The migration adds `32486afa8` (consumer leases and coordinated lifecycle) and `d90f918cf` (verified vision metadata). Their combined diff changes 21 files: 12 production files, seven tests and two documentation files; 1,119 lines were added and 22 removed. These counts exclude this audit and later maintenance changes.

The runtime worker's lease and monotonic-timing fixes were integrated into the first milestone; they are not additional unmerged OpenCodex features. Earlier commits between the research phase and implementation baseline are not attributed to this chat merely because their dates overlap it.

Both main checkouts were clean at the earlier audit checkpoint. The documentation update found pre-existing maintenance-pause edits and a separate uncommitted companion retention patch/test. Those changes are not part of the two-commit migration diff, have not been validated by this update and must not be silently committed as migration work. A Git revision does not prove what source an already-running process loaded.

## Before and after

| Responsibility | Before migration implementation | Migration addition |
| --- | --- | --- |
| Local model loading | Existing verified managed Qwen/llama.cpp runtime, one coordinated slot | External consumers can request readiness through leases |
| Model identity and launch configuration | Existing artifact, process, readiness, memory-reserve and rollback checks; ignored machine-specific profile | Reuse the existing checks and return a sanitized verified descriptor |
| Context and reasoning | Existing 184,320/131,072 context choices and low/medium/xhigh managed picker | Harness consumes the effective setting; no additional model capacity |
| Idle unload | Existing five-minute interval and 30-second sweep, including managed request protection | Include external model-use holds and their final-use time |
| Codex companion | Existing ownership-based close/stop coordination | Busy retry, consumer protection and authenticated exact stop operations |
| Research inference | No private Harness consumer integration | Direct verified local endpoint; no added OpenCodex research inference route |
| Vision | Existing model/runtime capability | Project affirmative identity-verified server metadata to the consumer |

## Every OpenCodex production change

The table accounts for every production file in the migration diff. Detailed endpoint fields and timing are owned by the [lease API reference](README-FORK.md#local-consumer-leases-management-api-v1).

| Source | Change and observable consequence |
| --- | --- |
| [consumer-leases.ts](src/local-runtime/consumer-leases.ts) | New bounded in-memory registry with owner-bound opaque tokens, acquire/status/heartbeat/release, 90-second expiry, 30-second heartbeat and monotonic elapsed time. Separate proxy ownership from model demand. Fence acquisition during accepted shutdown. Restart invalidates leases; no research prompts are stored in them. |
| [companion-lifecycle-auth.ts](src/local-runtime/companion-lifecycle-auth.ts) | New 30-second, single-use, process/port/request-bound authentication for the two exact companion stop operations. This is not Harness's permanent management credential. |
| [companion-runtime.ts](src/codex/companion-runtime.ts) | Verify the loopback manager identity, use authenticated coordinated stop requests, preserve Codex routing on that proxy-stop path, and report busy rather than force termination. Proxy ownership remains required. |
| [companion.ts](src/codex/companion.ts) | Treat protected model/proxy shutdown as busy and retry later rather than recording successful release. Closing Codex may leave a model/manager needed by Harness running. |
| [on-demand.ts](src/local-runtime/on-demand.ts) | Account for external model holds and settled consumer-use time in the existing idle observer. Add an explicit consumer-in-use readiness refusal. |
| [production.ts](src/local-runtime/production.ts) | Connect reservations and existing active-request counts to the supervisor/idle sweep; avoid clearing activity after a rejected stop; reject conflicting context changes; project affirmative verified vision metadata. |
| [supervisor.ts](src/local-runtime/supervisor.ts) | Receive consumer-use dependencies; reject conflicting apply/stop operations with consumer-in-use; distinguish model demand from proxy-only ownership for idle stops; add optional effective vision metadata. |
| [local-runtime-routes.ts](src/server/management/local-runtime-routes.ts) | Add the four authenticated versioned lease endpoints. Acquire/heartbeat with demand can start the model; status does not start or renew. Expose an endpoint only after verified readiness. Refuse conflicting lifecycle mutations. |
| [management-api.ts](src/server/management-api.ts) | Refuse manager stop while protected consumers exist and fence new acquisitions before accepted teardown. Preserve relevant active-request protection on companion stop. |
| [management-auth.ts](src/server/management-auth.ts) | Admit the narrow companion lifecycle capability for its exact operations without replacing existing management authentication. |
| [context.ts](src/server/management/context.ts) | Add the optional reservation-registry dependency for management wiring and tests; no separate service process. |
| [system-restart.ts](src/server/management/system-restart.ts) | Refuse a manager restart while consumer ownership exists, including requests without an explicit idle-only flag. |

These controls coordinate cooperating clients. They do not prevent Task Manager, operating-system shutdown, a crash or a privileged force kill. Sharing the same model also shares its hardware capacity; reservations do not create a second execution slot.

## Harness-side model work

The following inventory identifies the corresponding changes in the separate Harness repository; it does not imply these packages are part of OpenCodex.

- `packages/privacy/private-local-model` owns six source files: `index.ts` activates/disposes the service and reads the backend credential; `management.ts` owns lease calls and renewal; `network.ts` restricts destinations/methods; `direct.ts` owns direct HTTP connections; `adapter.ts` supplies verified local inference; `types.ts` defines configuration.
- The private adapter supplies only the `privacy-local` route. It permits canonical numeric-loopback HTTP destinations, refuses redirects and ambient proxy routing, uses explicit model profiles, limits active case/request ownership and aborts when lease authority is lost. It has no cloud fallback or installed credential/catalog discovery.
- The existing `llm-pi-ai` adapter/config/catalog/provider files gained caller-owned HTTP support, construction from explicit profiles and a no-installed-catalog mode. Ordinary Harness defaults remain separate. OpenAI-compatible wire syntax is used with a local endpoint and a non-secret placeholder key; it is not an OpenAI account connection.
- The research supervisor owns activation and releases demand on pause, completion, blocking or disposal. Compaction, completion review and stagnation replanning use the same local route with separately logged contexts. No OpenCodex cloud helper configuration is inherited for those roles.
- The research journal retains objective, known facts, attempts, evidence, unanswered questions and recovery state. Exact completed operations can return saved results. Compaction adds bounded journal-derived recovery and freshly read instructions; it does not inject the entire report into every request or guarantee that the model obeys the report-read instruction.
- The private CLI/Electron composition separates application state and excludes cloud providers, arbitrary shell, remote MCP, telemetry, automatic updates and agent-driven plugin installation. The active interface uses the original Harness chat client, not a modification of the Codex/ChatGPT application.
- Private case disposal opts into preserving the durable pending inbox; stock disposal defaults remain unchanged. The stock chat backend currently accepts only its verified active model selection, not a complete editor for shared OpenCodex context/effort settings.
- Vision is admitted only after affirmative verified capability metadata. The local encoding path exists, but complete desktop image admission and real image inference are not accepted.

The configured research defaults use 184,320 context and xhigh, with 131,072 supported as an alternative. The package's stream-idle default is five minutes; the inspected desktop configuration uses a 15-minute allowance. Readiness allows 15 minutes and normal output is bounded at 8,192 tokens. These are client settings, not changes to Qwen weights or physical context capacity.

## Credentials, configuration and shared-process effects

Harness's trusted backend reads the existing broad OpenCodex management credential. Its restricted four-endpoint client and owner-bound leases do not make that credential lease-only. Model-visible tools and the renderer are excluded from the credential path, but this is not protection against arbitrary code running as the same operating-system user. The companion's short-lived stop capability is a different authorization mechanism.

The pre-existing successful-start persistence in [production.ts](src/local-runtime/production.ts) saves the verified runtime candidate and managed local-provider projection through the existing configuration writer. A Harness-triggered start can therefore cause OpenCodex configuration writes without the adapter editing those files directly. The audit found no migration replacement of the ignored launch profile. Without complete before/after configuration snapshots, later modification times cannot establish every file-level side effect or its author.

OpenCodex remains cloud-capable for unrelated clients. Private research inference bypasses its general router; that does not make the whole shared process cloud-free. The ordinary [CLI startup](src/cli/index.ts) retains its existing token/history guardians, configured Codex startup synchronization, Claude reconciliation and other optional integration work. The final reviewed manager-only operator startup and shortcut setup were not fully provisioned in the audited Harness installation.

Effects visible to other clients include a refused restart/update/stop while Harness holds ownership, a refused conflicting context change, shared local-model resource use, and model/manager residency after Codex closes. Neither the migration nor a passing smoke authorizes interrupting those clients.

## Recorded diagnostics and what they prove

This table reports the chat's historical operations, not commands run for this documentation update. Raw prompts, responses, credentials, process identities, private paths and captures are intentionally excluded.

| Recorded operation | Result and limit |
| --- | --- |
| Pre-implementation managed-Qwen start, synthetic compaction/ledger diagnostics and stop | Existing local runtime was exercised; synthetic tests explored lossy summarization and explicit prior-work retrieval. The recorded reassessment reported restoring the stopped state. This was not the final research controller or an existing private investigation. |
| One comparison request through OpenCodex's general chat-completions router, explicitly selecting local Qwen | Synthetic connectivity succeeded. This exception prevents the claim that no development prompt ever passed through the router; it does not change the final private adapter's direct route. |
| Five identity-bound idle-only manager restart requests | All were refused as busy with HTTP 423 and accepted false. No forced restart bypassed them. The requests were real lifecycle attempts, not merely status reads. |
| Post-reboot compiled private-adapter smoke | Authorized loading, verified 184,320-token/xhigh runtime, one normally completed synthetic response with reasoning deltas, and test-owner release passed. This supersedes the earlier lease-API-unavailable blocker. |
| Historical focused OpenCodex checks | The migration record reports 85 focused lifecycle tests, type checking and a privacy scan passing at that milestone. The later vision change has focused source checks. These are not complete desktop or endurance evidence and were not rerun for this update. |
| Actual desktop research with repeated compaction | Not established. No accepted eight-hour campaign, ten-compaction live run, substantive-claim audit, measured idle-unload test or whole-application network/residue audit is recorded. |

Cloud development workers were used during implementation/review. They are not installed as automatic private research helpers. The local-only runtime design does not make the development conversation or material supplied to those workers local-only.

## Test and documentation accounting

The seven test files in the two-commit OpenCodex migration diff are:

- [local-runtime-companion-auth.test.ts](tests/local-runtime-companion-auth.test.ts)
- [local-runtime-consumer-companion.test.ts](tests/local-runtime-consumer-companion.test.ts)
- [local-runtime-consumer-leases.test.ts](tests/local-runtime-consumer-leases.test.ts)
- [local-runtime-consumer-management.test.ts](tests/local-runtime-consumer-management.test.ts)
- [local-runtime-supervisor.test.ts](tests/local-runtime-supervisor.test.ts)
- [local-runtime-vision.test.ts](tests/local-runtime-vision.test.ts)
- [system-restart.test.ts](tests/system-restart.test.ts)

The two documentation files were [README-FORK.md](README-FORK.md) and [BACKLOG.md](BACKLOG.md). The later companion-retention test is separate maintenance work, not an eighth migration test file.

The audited diff does not change the general router, model launch profile/context-tier implementation, CLI startup implementation, Codex injection/catalog, Claude source, OpenCodex GUI, package manifest or lockfile. No migration change to the ChatGPT account or Codex application binary, usage reset, replacement model-weight download or new managed slot was recorded. This is a bounded source/history finding, not proof of every operation ever performed on the computer.

## Remaining work stays paused

The private adapter's successful plain response does not satisfy the backlog's durable-edit requirement. Real tool-driven desktop research, all-effort/vision protocol acceptance, multi-consumer and measured idle behavior, complete stock settings/attachments, final launcher setup, validated Brave traffic, whole-application privacy tests and long-run compaction/endurance remain open. Harness worker-tree drafts and a campaign runner are not proof of integrated or executed acceptance.

This update only reconciles documentation. It does not resume workers, merge upstream, modify lifecycle code, change configuration, install dependencies, run model inference or close an unverified acceptance requirement.
