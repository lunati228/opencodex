# Managed Qwen provider preservation: repair and reassessment

## Verified configuration defect

`configForPersistence` deliberately omits exact managed local and external
provider projections. Loading configuration reconstructs them from the owning
settings. The persisted provider table is therefore not a complete live table.

The original `adoptProviderEditorCandidate` deleted every live provider absent
from that persisted table. Losing `qwen-local` caused the external-model 404
even while `localRuntime.enabled` remained true. The repair preserves exact
managed rows and reapplies the existing projection helper after adoption.

The provider editor must also omit managed rows from its editable payload:
their runtime-only fields fail persisted-config validation. The dashboard DTO
now builds each row independently, retaining managed public metadata through the
same field allowlist while keeping credentials out of the response.

This establishes a real defect. It does not establish which historical write
caused a particular incident, nor does a helper-only test cover every path that
adopts persisted configuration.

## September 12 reassessment

Read-only live inspection again found enabled local settings with no local
provider row. Three startup migrations independently reproduced the same loss:

- `migrateStartupSubagentModels` returned an unprojected persisted document.
- `migrateStartupXaiResponses` returned an unprojected persisted document.
- `runModelRenameStartupMigration` adopted an unprojected persisted document.

Each now calls `withManagedProviderProjections(..., false)` before the disk
snapshot becomes live state. This retains rebased configuration, existing
collision checks and the separation between public projections and external
secret activation. Projection does not launch the local model.

All three startup regressions failed before the repair and passed afterward.
The provider-editor regression exercises the complete management route with
changed and unchanged payloads, both with an existing row and an already-missing
row. It also checks editor omission, dashboard metadata and absence from disk.
These route tests replace the earlier helper-only tests and do not require
exporting the private adoption function.

## Request diagnostics, waiting and socket failures

`ocx:openai-chat:request` is emitted while building the adapter request, before
dispatch. `stream: true` describes the requested upstream mode. Message and tool
counts describe the payload; `bodyBytes` counts serialized UTF-8 bytes, not
tokens. `hasCredential: false` is expected for the managed loopback provider.

These fields establish neither success nor failure, latency, token usage or
prompt-cache behavior. The reviewed request history contained both completed
turns and actual failed streams. A later socket-closed error is a real failure.

The web-search sidecar buffers semantic output by default. The existing
`webSearchSidecar.streamRoutedModelOutput` option changes visibility, with the
tradeoffs documented in the [sidecar guide](../../../docs-site/src/content/docs/guides/sidecars.md).
It is not a socket repair and was not changed by this work.

The provider fetch helpers already pass `timeout: 0`, which disables Bun's
per-request idle timeout while application deadlines remain bounded. A synthetic
loopback connection-reuse probe did not reproduce an inherited idle timeout.
Read-only engine inspection did not establish a crash cause. Neither result
rules out failures under the original workload.

No transport retry, timeout increase, engine upgrade or verbose payload logging
was added. The historical socket-disconnect cause remains unconfirmed. A short
successful smoke test would validate that request only, not long-context
stability.

Primary transport references:

- [Bun fetch timeout contract](https://bun.com/reference/globals/BunFetchRequestInit/timeout).
- [Bun fetch connection pooling](https://bun.com/docs/runtime/networking/fetch).
- [Inspected llama.cpp HTTP implementation](https://github.com/ggml-org/llama.cpp/blob/b2e5e9b28b2484fbf94b543432ece638996a8b97/tools/server/server-http.cpp).

## Activation and scope

The existing authenticated local-runtime enable operation restored the missing
live row without a proxy restart. Local controls were verified afterward.
The operator subsequently rebooted the machine; post-reboot inspection found
the managed row present and controls enabled. Earlier process observations no
longer describe that new process.

Source changes apply when the proxy loads them. Relaunching the desktop and
waiting a fixed minute does not by itself prove that the proxy reloaded or that
a local response completed. Inspect provider state and a terminal response.

The owner authorized completing the prepared canonical merge first and
committing this repair separately. No agents, dependency installations, pushes
or agent-initiated process restarts were used for this reassessment. See
[PROGRESS.md](../../../PROGRESS.md) for validation outcomes and remaining limits.
