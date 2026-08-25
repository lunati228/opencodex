# Local integration guidance

Read `AGENTS.md` before changing the repository.

## Public configuration boundary

- The managed Qwen profile defaults to 192K (196,608 tokens); 128K (131,072
  tokens) is an explicit lower-memory row.
- Qwen agent work uses xhigh by default and exposes only low, medium, and
  xhigh in its picker.
- The ignored local runtime profile contains all machine-specific launch and
  verification data. Never copy its paths, hashes, artifact metadata, hardware
  placement, measurements, logs, screenshots, account data, credentials, or
  recovery layout into tracked files.
- Do not start Qwen unless the operator explicitly authorizes a live run.

## Documentation discipline

Write public docs about observable product behavior and safe interfaces only.
Historical local experiments, hardware inventories, raw benchmarks, and private
recovery material are not public documentation. Use a private, access-controlled
operator record for those details.

Run only focused checks for the behavior you change unless broader validation is
explicitly requested.
