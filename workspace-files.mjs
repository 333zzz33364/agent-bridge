import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const protectedDirs = new Set(['.git', '.agents', '.codex', '.aws']);
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function pathParts(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error('写入路径不能为空或包含 NUL');
  }
  const drive = process.platform === 'win32' && /^[a-z]:[\\/]/i.test(value);
  const rest = drive ? value.slice(2) : value;
  if (process.platform === 'win32' && (rest.includes(':') || /^[\\/]/.test(rest) && !drive)) {
    throw new Error('写入路径禁止使用设备、UNC、盘符相对路径或备用数据流');
  }
  const parts = rest.split(/[\\/]+/).filter(Boolean);
  for (const part of parts) {
    if (part === '..' || protectedDirs.has(part.toLowerCase())) throw new Error('写入路径包含上级目录或保护目录');
    if (process.platform === 'win32' && part !== '.' && (
      /[ .]$|[<>"|?*\x01-\x1f]/.test(part) ||
      /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part)
    )) throw new Error('写入路径使用了 Windows 保留名称或无效字符');
  }
  return parts;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function samePath(a, b) {
  return path.relative(a, b) === '';
}

function directory(value) {
  pathParts(value);
  const absolute = path.resolve(value);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const entry = fs.lstatSync(cursor);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('写入目录必须是普通目录，禁止链接和联接点');
  }
  const real = fs.realpathSync.native(absolute);
  pathParts(real);
  return real;
}

export function authorizeWriteDirectory(cwd, roots) {
  if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('写模式必须显式指定 cwd');
  const target = directory(cwd);
  if (!Array.isArray(roots) || !roots.some((root) => inside(directory(root), target))) {
    throw new Error('写入目录越过获准根目录');
  }
  return target;
}

export function parseWriteArguments(args, base, roots) {
  if (args.slice(0, base.length).join('\0') !== base.join('\0')) throw new Error('子代理模型参数与固定配置不符');
  const extra = args.slice(base.length);
  if (!extra.length) return undefined;
  if (extra.length !== 4 || extra[0] !== '--mode' || extra[1] !== 'write' || extra[2] !== '--write-root') {
    throw new Error('写模式必须显式指定写入目录');
  }
  const root = authorizeWriteDirectory(extra[3], roots);
  if (!samePath(root, directory(process.cwd()))) throw new Error('写入边界与当前工作目录不一致');
  return root;
}

function fileState(file) {
  const info = fs.lstatSync(file, { throwIfNoEntry: false, bigint: true });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1n) {
    throw new Error('仅允许普通文件，禁止链接和多重硬链接');
  }
  const real = fs.realpathSync.native(file);
  pathParts(real);
  if (!samePath(real, file)) throw new Error('文件路径与真实路径不一致');
  const bytes = fs.readFileSync(file);
  return { info, bytes };
}

function unchanged(before, after) {
  if (!before || !after) return before === after;
  return before.info.dev === after.info.dev && before.info.ino === after.info.ino &&
    before.info.mtimeNs === after.info.mtimeNs && before.bytes.equals(after.bytes);
}

export const fileOperations = {
  write: {
    description: 'Create or replace a UTF-8 text file within the authorized directory.',
    fields: { file_path: 'Relative path or absolute path within the authorized directory.', content: 'Complete UTF-8 file contents.' },
  },
  edit: {
    description: 'Replace one unique literal string in an existing UTF-8 text file within the authorized directory.',
    fields: { file_path: 'Relative path or absolute path within the authorized directory.', old_string: 'Non-empty literal string that appears exactly once.', new_string: 'Replacement text.' },
  },
};

export function workspaceFiles(root) {
  const boundary = directory(root);
  return (operation, args, signal) => {
    const definition = Object.hasOwn(fileOperations, operation) && fileOperations[operation];
    const keys = Object.keys(definition?.fields ?? {});
    if (!definition || !args || Object.keys(args).length !== keys.length || keys.some((key) => typeof args[key] !== 'string')) {
      throw new Error('文件工具参数无效');
    }
    let file, parent, before;
    try {
      pathParts(args.file_path);
      file = path.resolve(boundary, args.file_path);
      if (!inside(boundary, file) || samePath(boundary, file)) throw new Error('文件路径越过本次授权目录');
      parent = directory(path.dirname(file));
      if (!inside(boundary, parent) || !samePath(parent, path.dirname(file))) throw new Error('文件父目录越过本次授权目录');
      before = fileState(file);
    } catch (error) {
      throw new Error(`写入边界拒绝：${error.message}`, { cause: error });
    }
    const previous = before ? utf8.decode(before.bytes) : null;
    let contents = args.content;
    if (operation === 'edit') {
      const needle = args.old_string;
      const index = previous?.indexOf(needle) ?? -1;
      if (!needle || index < 0 || previous.indexOf(needle, index + 1) >= 0) throw new Error('替换目标必须在现有文件中唯一匹配');
      contents = previous.slice(0, index) + args.new_string + previous.slice(index + needle.length);
    }

    signal?.throwIfAborted();
    const lockKey = createHash('sha256').update(process.platform === 'win32' ? file.toLowerCase() : file).digest('hex');
    const lock = path.join(parent, `.agent-bridge-${lockKey}.lock`);
    const staging = path.join(parent, `.agent-bridge-${randomUUID()}.tmp`);
    let fd;
    try { fd = fs.openSync(lock, 'wx'); } catch (error) {
      if (error.code === 'EEXIST') throw new Error('同一文件已有正在进行的修改');
      throw error;
    }
    try {
      if (!samePath(parent, directory(parent)) || !unchanged(before, fileState(file))) {
        throw new Error('文件或父目录在修改期间发生变化');
      }
      fs.writeFileSync(staging, contents, { flag: 'wx', encoding: 'utf8', mode: Number(before?.info.mode ?? 0o666n) & 0o777 });
      if (!samePath(parent, directory(parent)) || !unchanged(before, fileState(file))) {
        throw new Error('文件或父目录在提交前发生变化');
      }
      signal?.throwIfAborted();
      if (before) fs.renameSync(staging, file);
      else fs.linkSync(staging, file);
    } finally {
      fs.closeSync(fd);
      if (samePath(parent, directory(parent))) {
        try {
          try { fs.unlinkSync(staging); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        } finally {
          fs.unlinkSync(lock);
        }
      }
    }
    return `${before ? 'updated' : 'created'} ${path.relative(boundary, file)}`;
  };
}
