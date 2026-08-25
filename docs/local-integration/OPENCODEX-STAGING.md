# Package staging policy

A public staging procedure must be portable and non-identifying.

- Start from a clean, reviewed source tree.
- Use already-approved tooling from verified publishers.
- Keep package-only staging separate from a live deployment.
- Verify integrity locally without publishing local paths, binary fingerprints,
  account data, or machine-specific tool inventories.
- Treat credentials, recovery material, raw logs, and generated traffic captures
  as private operator data.

Project-specific staging locations and host details belong in ignored local
operator documentation, never in this repository.
