export function createLogger(scope) {
  const prefix = `[${scope}]`;

  return {
    info(message, meta) {
      log("INFO", message, meta);
    },
    warn(message, meta) {
      log("WARN", message, meta);
    },
    error(message, meta) {
      log("ERROR", message, meta);
    }
  };

  function log(level, message, meta) {
    const ts = new Date().toISOString();
    if (meta !== undefined) {
      console.log(`${ts} ${level} ${prefix} ${message}`, meta);
      return;
    }
    console.log(`${ts} ${level} ${prefix} ${message}`);
  }
}