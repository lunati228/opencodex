# Local integration rollback policy

Public rollback guidance is limited to tracked configuration and documented
interfaces. Do not publish or copy operator paths, credential stores, recovery
layouts, process identifiers, filesystem snapshots, or command transcripts.

1. Stop only the component the operator explicitly approved.
2. Restore a known-good tracked configuration or revert the relevant commit.
3. Restart only through the normal, approved local lifecycle.
4. Verify loopback-only exposure and focused behavior tests.
5. Keep any local profile, credentials, artifact verification, and recovery
   material outside version control.

If rollback would require guessing about private local state, stop and use the
operator's private recovery procedure instead of documenting it here.
