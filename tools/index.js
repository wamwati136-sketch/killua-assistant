/**
 * tools/index.js
 * Central tool registry. Aggregates every tool module into one
 * lookup table keyed by function name, and exposes the handful of
 * helpers server.js needs:
 *
 *   getToolDefinitions()   -> array formatted for the Groq `tools` param
 *   getToolMeta(name)      -> { level, softConfirm, hardConfirm }
 *   executeTool(name, args) -> Promise<object> (the tool's JSON result)
 */

const calculator = require('./calculator');
const weather = require('./weather');
const webSearch = require('./webSearch');
const system = require('./system');

// Flatten every module into a single list of { level, definition, execute, softConfirm, hardConfirm }
const registry = [
  { ...calculator },
  { ...weather },
  { ...webSearch },
  ...system.tools,
];

const byName = new Map();
for (const tool of registry) {
  byName.set(tool.definition.function.name, tool);
}

function getToolDefinitions() {
  return registry.map((t) => t.definition);
}

function getToolMeta(name) {
  const tool = byName.get(name);
  if (!tool) return null;
  return {
    level: tool.level,
    softConfirm: Boolean(tool.softConfirm),
    hardConfirm: Boolean(tool.hardConfirm),
  };
}

async function executeTool(name, args) {
  const tool = byName.get(name);
  if (!tool) {
    return { ok: false, error: `Unknown tool "${name}"` };
  }
  try {
    return await tool.execute(args || {});
  } catch (err) {
    return { ok: false, error: `Tool "${name}" threw an error: ${err.message}` };
  }
}

function isKnownTool(name) {
  return byName.has(name);
}

module.exports = {
  getToolDefinitions,
  getToolMeta,
  executeTool,
  isKnownTool,
};
