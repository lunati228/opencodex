# Public artifact-retention policy

The repository records product behavior, not an operator's storage inventory.

Never commit or enumerate local model artifacts, executable locations, binary
hashes or sizes, hardware inventory, benchmark outputs, credential stores,
backup layouts, recovery bundles, process state, or private worktrees. Those
materials are operator-local and must remain ignored or otherwise access
controlled.

Public documentation may state that a machine-local runtime profile exists and
that it is verified locally. It must not reveal how to locate or fingerprint
that profile or its surrounding workstation.
