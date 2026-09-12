/**
 * tools/system.js
 * Level 2 (USER DATA) — note_read / note_list / note_write / note_delete
 * Level 3 (IMPORTANT) — delete_file / run_shell_command
 *
 * SAFETY DESIGN NOTES
 * --------------------
 * - Every file-touching tool in this module is confined to
 *   WORKSPACE_DIR (default "./workspace"). Path traversal ("../../etc")
 *   is rejected even for the Level 3 delete_file tool — a real
 *   general-purpose file-system tool would need much stronger sandboxing
 *   (containers, OS-level permissions, etc.) before being pointed at a
 *   whole disk. This keeps the reference implementation safe to run.
 * - run_shell_command is fully disabled unless the operator explicitly
 *   sets ALLOW_SYSTEM_EXEC=true in .env. Even when enabled, it is still
 *   gated by the mandatory client-side confirmation modal (server.js
 *   never executes a Level 3 tool without an explicit "approved" flag
 *   coming back from /api/confirm-tool).
 * - Level 2 tools execute automatically but are flagged `softConfirm:
 *   true` so the UI can show a non-blocking "data modified" toast.
 * - Level 3 tools are flagged `softConfirm: false` and `hardConfirm:
 *   true` — server.js treats `hardConfirm` tools as requiring explicit
 *   pre-approval before `execute()` is ever called.
 */

const fs = require('fs/promises');
const path = require('path');
const { exec } = require('child_process');

const WORKSPACE_DIR = path.resolve(process.cwd(), process.env.WORKSPACE_DIR || './workspace');
const NOTES_DIR = path.join(WORKSPACE_DIR, 'notes');

async function ensureDirs() {
  await fs.mkdir(NOTES_DIR, { recursive: true });
}

/** Resolve a user-supplied note title to a safe path inside NOTES_DIR. */
function resolveNotePath(title) {
  const safeName = String(title)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_ ]/gi, '')
    .replace(/\s+/g, '-')
    .slice(0, 80);

  if (!safeName) throw new Error('Note title resolves to an empty/invalid filename');

  const fullPath = path.join(NOTES_DIR, `${safeName}.txt`);
  const resolved = path.resolve(fullPath);

  if (!resolved.startsWith(path.resolve(NOTES_DIR) + path.sep) && resolved !== path.resolve(NOTES_DIR)) {
    throw new Error('Path traversal attempt blocked');
  }
  return resolved;
}

/** Resolve any workspace-relative path, blocking traversal outside WORKSPACE_DIR. */
function resolveWorkspacePath(relativePath) {
  const fullPath = path.resolve(WORKSPACE_DIR, relativePath);
  if (!fullPath.startsWith(path.resolve(WORKSPACE_DIR) + path.sep) && fullPath !== path.resolve(WORKSPACE_DIR)) {
    throw new Error('Path traversal attempt blocked — path escapes the workspace sandbox');
  }
  return fullPath;
}

// ---------------------------------------------------------------------
// Level 1 (read-only): note_list, note_read
// ---------------------------------------------------------------------

const noteListDefinition = {
  type: 'function',
  function: {
    name: 'note_list',
    description: 'List the titles of all saved notes.',
    parameters: { type: 'object', properties: {} },
  },
};

async function noteListExecute() {
  await ensureDirs();
  try {
    const files = await fs.readdir(NOTES_DIR);
    const titles = files.filter((f) => f.endsWith('.txt')).map((f) => f.replace(/\.txt$/, ''));
    return { ok: true, notes: titles };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const noteReadDefinition = {
  type: 'function',
  function: {
    name: 'note_read',
    description: 'Read the contents of a previously saved note by title.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string', description: 'The note title.' } },
      required: ['title'],
    },
  },
};

async function noteReadExecute(args) {
  await ensureDirs();
  try {
    const notePath = resolveNotePath(args.title);
    const content = await fs.readFile(notePath, 'utf8');
    return { ok: true, title: args.title, content };
  } catch (err) {
    return { ok: false, title: args.title, error: err.code === 'ENOENT' ? 'Note not found' : err.message };
  }
}

// ---------------------------------------------------------------------
// Level 2 (modifies user data, soft confirmation): note_write, note_delete
// ---------------------------------------------------------------------

const noteWriteDefinition = {
  type: 'function',
  function: {
    name: 'note_write',
    description: 'Create or overwrite a note with the given title and content.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The note title.' },
        content: { type: 'string', description: 'The full text content to save.' },
        append: { type: 'boolean', description: 'If true, append to an existing note instead of overwriting it.' },
      },
      required: ['title', 'content'],
    },
  },
};

async function noteWriteExecute(args) {
  await ensureDirs();
  try {
    const notePath = resolveNotePath(args.title);
    if (args.append) {
      await fs.appendFile(notePath, `\n${args.content}`, 'utf8');
    } else {
      await fs.writeFile(notePath, args.content, 'utf8');
    }
    return { ok: true, title: args.title, mode: args.append ? 'appended' : 'overwritten' };
  } catch (err) {
    return { ok: false, title: args.title, error: err.message };
  }
}

const noteDeleteDefinition = {
  type: 'function',
  function: {
    name: 'note_delete',
    description: 'Delete a previously saved note by title.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string', description: 'The note title to delete.' } },
      required: ['title'],
    },
  },
};

async function noteDeleteExecute(args) {
  await ensureDirs();
  try {
    const notePath = resolveNotePath(args.title);
    await fs.unlink(notePath);
    return { ok: true, title: args.title, deleted: true };
  } catch (err) {
    return { ok: false, title: args.title, error: err.code === 'ENOENT' ? 'Note not found' : err.message };
  }
}

// ---------------------------------------------------------------------
// Level 3 (mandatory hard confirmation): delete_file, run_shell_command
// ---------------------------------------------------------------------

const deleteFileDefinition = {
  type: 'function',
  function: {
    name: 'delete_file',
    description:
      'Permanently delete a file inside the KILLUA workspace sandbox. Irreversible — requires explicit user authorization.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path relative to the workspace root, e.g. "notes/old-idea.txt"',
        },
      },
      required: ['path'],
    },
  },
};

async function deleteFileExecute(args) {
  try {
    const target = resolveWorkspacePath(args.path);
    await fs.unlink(target);
    return { ok: true, path: args.path, deleted: true };
  } catch (err) {
    return { ok: false, path: args.path, error: err.code === 'ENOENT' ? 'File not found' : err.message };
  }
}

const runShellCommandDefinition = {
  type: 'function',
  function: {
    name: 'run_shell_command',
    description:
      'Execute a shell command on the host machine and return its output. Extremely powerful and irreversible — requires explicit user authorization, and is disabled entirely unless the operator has opted in via ALLOW_SYSTEM_EXEC=true.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute.' },
      },
      required: ['command'],
    },
  },
};

async function runShellCommandExecute(args) {
  if (process.env.ALLOW_SYSTEM_EXEC !== 'true') {
    return {
      ok: false,
      command: args.command,
      error:
        'System execution is disabled on this server. Set ALLOW_SYSTEM_EXEC=true in .env to enable this capability (at your own risk).',
    };
  }

  return new Promise((resolve) => {
    exec(
      args.command,
      { cwd: WORKSPACE_DIR, timeout: 10_000, maxBuffer: 1024 * 256 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, command: args.command, error: error.message, stderr: stderr?.slice(0, 2000) });
        } else {
          resolve({
            ok: true,
            command: args.command,
            stdout: stdout?.slice(0, 4000),
            stderr: stderr?.slice(0, 2000),
          });
        }
      }
    );
  });
}

module.exports = {
  // Each entry: { level, definition, execute, softConfirm, hardConfirm }
  tools: [
    { level: 1, definition: noteListDefinition, execute: noteListExecute, softConfirm: false },
    { level: 1, definition: noteReadDefinition, execute: noteReadExecute, softConfirm: false },
    { level: 2, definition: noteWriteDefinition, execute: noteWriteExecute, softConfirm: true },
    { level: 2, definition: noteDeleteDefinition, execute: noteDeleteExecute, softConfirm: true },
    { level: 3, definition: deleteFileDefinition, execute: deleteFileExecute, hardConfirm: true },
    { level: 3, definition: runShellCommandDefinition, execute: runShellCommandExecute, hardConfirm: true },
  ],
};
