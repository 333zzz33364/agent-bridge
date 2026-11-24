import { createInterface } from 'node:readline';
import { fileOperations, workspaceFiles } from './workspace-files.mjs';

const root = process.env.AGENT_BRIDGE_WRITE_ROOT;
const changeFile = root && workspaceFiles(root);
const tools = changeFile ? Object.entries(fileOperations).map(([name, operation]) => ({
  name,
  description: operation.description,
  inputSchema: {
    type: 'object',
    properties: Object.fromEntries(Object.entries(operation.fields).map(([key, description]) => [key, { type: 'string', description }])),
    required: Object.keys(operation.fields),
    additionalProperties: false,
  },
})) : [];

function reply(method, params) {
  switch (method) {
    case 'initialize': return {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'workspace-files', version: '1.0.0' },
    };
    case 'ping': return {};
    case 'tools/list': return { tools };
    case 'tools/call': {
      let text;
      let isError = false;
      try {
        if (!changeFile) throw new Error('本次没有授权写入目录');
        text = changeFile(params?.name, params?.arguments);
      } catch (error) {
        text = error.message;
        isError = true;
      }
      return { isError, content: [{ type: 'text', text }] };
    }
    default: return undefined;
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (message?.id === undefined) continue;
  const result = reply(message.method, message.params);
  const payload = result === undefined ? { error: { code: -32601, message: 'method not found' } } : { result };
  console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...payload }));
}
