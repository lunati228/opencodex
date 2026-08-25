const DEFAULT_ALLOWED_NAMES = Object.freeze([
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "SystemDrive",
  "SystemRoot",
  "TEMP",
  "TMP",
  "WINDIR",
]);

export function buildAllowedEnvironment(
  source,
  allowedNames = DEFAULT_ALLOWED_NAMES,
) {
  if (
    source === null ||
    typeof source !== "object" ||
    Array.isArray(source) ||
    !Array.isArray(allowedNames)
  ) {
    throw new TypeError("environment source or allowlist is invalid");
  }
  const allowed = new Set(allowedNames.map((name) => name.toUpperCase()));
  const result = {};
  for (const [name, value] of Object.entries(source)) {
    if (
      allowed.has(name.toUpperCase()) &&
      typeof value === "string" &&
      !name.includes("=") &&
      !value.includes("\0")
    ) {
      result[name] = value;
    }
  }
  return result;
}

export { DEFAULT_ALLOWED_NAMES };
