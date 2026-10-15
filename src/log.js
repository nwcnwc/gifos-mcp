// stdout belongs to the MCP stdio transport; everything human goes to stderr.
export function log(line) {
  process.stderr.write('[gifos-mcp] ' + new Date().toISOString() + ' ' + line + '\n');
}
