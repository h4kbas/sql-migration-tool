export function formatKb(sql) {
  return (Buffer.byteLength(sql, "utf8") / 1024).toFixed(1);
}

export function countLines(sql) {
  if (!sql) return 0;
  return sql.split("\n").length;
}

export function logSqlStats(label, sql) {
  if (!sql?.trim()) {
    console.log(`${label}: empty`);
    return;
  }

  console.log(`${label}: ${formatKb(sql)} KB, ${countLines(sql)} lines`);
}

export function logDatabaseTarget(config) {
  const { database, schema } = config;

  if (database.runner === "docker") {
    console.log(`Database: docker compose exec ${database.dockerService} (${database.database})`);
  } else {
    console.log(`Database: psql://${database.host}:${database.port}/${database.database}`);
  }

  console.log(`Schema: ${schema}`);
}

export function logStep(message) {
  console.log(message);
}

export function logDone(label, startedAt) {
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`Finished ${label} in ${seconds}s`);
}
