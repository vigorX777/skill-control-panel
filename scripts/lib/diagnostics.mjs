const SEVERITIES = new Set(["error", "warning", "info"]);

export function createDiagnostic({
  code,
  severity,
  message,
  skillId = null,
  path = null,
  agent = null,
  details = {},
}) {
  if (!SEVERITIES.has(severity)) {
    throw new TypeError(`Unsupported diagnostic severity: ${severity}`);
  }

  return { code, severity, message, skillId, path, agent, details };
}

export function countDiagnostics(diagnostics) {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const diagnostic of diagnostics) {
    counts[diagnostic.severity] += 1;
  }
  return counts;
}
