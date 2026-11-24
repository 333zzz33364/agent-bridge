import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileOperations, workspaceFiles } from './workspace-files.mjs';

const install = process.env.DSH_INSTALL_DIR || 'C:\\Program Files\\DeepSeek Harness';
const pkgPath = existsSync(join(install, 'resources', 'app', 'dsh', 'package.json'))
  ? join(install, 'resources', 'app', 'dsh', 'package.json')
  : join(install, 'resources', 'app.asar', 'dsh', 'package.json');
const require = createRequire(pkgPath);
const { defineTool } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href);

export const name = 'bridge-file-tools';
export const inject = ['tools'];

export function apply(ctx, config) {
  const changeFile = workspaceFiles(config.root);
  for (const [name, operation] of Object.entries(fileOperations)) {
    ctx.tools.register(defineTool({
      name,
      description: operation.description,
      parameters: Object.fromEntries(Object.entries(operation.fields).map(([key, description]) => [key, {
        type: 'string', required: true, description,
      }])),
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: (args, exec) => changeFile(name, args, exec.signal),
    }));
  }
}
