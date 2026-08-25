# Local runtime current state

The public managed-local contract is deliberately small:

| Setting | Public behavior |
| --- | --- |
| Default context | 196,608 tokens (192K) |
| Explicit lower context | 131,072 tokens (128K) |
| Default reasoning | xhigh |
| Qwen picker values | low, medium, xhigh |
| Launch details | Ignored machine-local runtime profile |

The public source contains no artifact locations, checksums, sizes, hardware
inventory, placement decisions, or performance measurements. Those facts are
operator-local integrity inputs and must not be copied into tracked files.

A Qwen live run remains an explicit operator action; documenting this state does
not authorize a launch.
