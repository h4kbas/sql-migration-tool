const ENV_RE = /\$\{([A-Z0-9_]+)\}/g;

function escapeSqlLiteral(value) {
  return String(value).replace(/'/g, "''");
}

export function substituteEnv(content, env = {}) {
  return content.replace(ENV_RE, (_match, name) => escapeSqlLiteral(env[name] ?? ""));
}
