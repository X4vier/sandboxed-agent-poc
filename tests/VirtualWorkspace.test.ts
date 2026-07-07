import { describe, it, expect } from 'vitest';
import {
  VirtualWorkspace,
  WorkspaceError,
  MAX_FILE_BYTES,
} from '../src/main/workspace/VirtualWorkspace';

describe('VirtualWorkspace — staging', () => {
  it('stages a provided file under its basename with provided status', () => {
    const vfs = new VirtualWorkspace();
    const key = vfs.stageProvided('input.csv', Buffer.from('a,b\n1,2'));
    expect(key).toBe('input.csv');
    expect(vfs.status('input.csv')).toBe('provided');
    expect(vfs.readText('input.csv')).toEqual({ ok: true, text: 'a,b\n1,2' });
  });

  it('uses only the basename of a disk path', () => {
    const vfs = new VirtualWorkspace();
    const key = vfs.stageProvided('/home/user/docs/report.md', Buffer.from('hi'));
    expect(key).toBe('report.md');
  });

  it('disambiguates basename collisions with a numeric suffix', () => {
    const vfs = new VirtualWorkspace();
    expect(vfs.stageProvided('a.txt', Buffer.from('1'))).toBe('a.txt');
    expect(vfs.stageProvided('a.txt', Buffer.from('2'))).toBe('a-1.txt');
    expect(vfs.stageProvided('a.txt', Buffer.from('3'))).toBe('a-2.txt');
    expect(vfs.fileCount).toBe(3);
  });

  it('sanitizes a device-name basename rather than crashing', () => {
    const vfs = new VirtualWorkspace();
    const key = vfs.stageProvided('CON', Buffer.from('x'));
    expect(key).not.toBe('CON');
    expect(vfs.has(key)).toBe(true);
  });
});

describe('VirtualWorkspace — write status transitions', () => {
  it('marks a new file created', () => {
    const vfs = new VirtualWorkspace();
    vfs.writeFile('new.txt', 'hello');
    expect(vfs.status('new.txt')).toBe('created');
  });

  it('overwriting a provided file marks it modified', () => {
    const vfs = new VirtualWorkspace();
    vfs.stageProvided('data.txt', Buffer.from('orig'));
    vfs.writeFile('data.txt', 'changed');
    expect(vfs.status('data.txt')).toBe('modified');
  });

  it('overwriting a created file keeps it created', () => {
    const vfs = new VirtualWorkspace();
    vfs.writeFile('c.txt', 'one');
    vfs.writeFile('c.txt', 'two');
    expect(vfs.status('c.txt')).toBe('created');
    expect(vfs.readText('c.txt')).toEqual({ ok: true, text: 'two' });
  });
});

describe('VirtualWorkspace — text vs binary', () => {
  it('reports non-UTF-8 content instead of returning mojibake', () => {
    const vfs = new VirtualWorkspace();
    vfs.stageProvided('img.bin', Buffer.from([0xff, 0xfe, 0x00, 0x80]));
    const r = vfs.readText('img.bin');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.size).toBe(4);
  });
});

describe('VirtualWorkspace — size caps', () => {
  it('rejects a file over the per-file limit', () => {
    const vfs = new VirtualWorkspace();
    const big = Buffer.alloc(MAX_FILE_BYTES + 1);
    expect(() => vfs.stageProvided('big.bin', big)).toThrow(WorkspaceError);
  });

  it('rejects when total would exceed the workspace limit', () => {
    const vfs = new VirtualWorkspace();
    // 11 x 50MB = 550MB > 500MB total.
    const chunk = Buffer.alloc(MAX_FILE_BYTES);
    let threw = false;
    try {
      for (let i = 0; i < 11; i++) vfs.stageProvided(`f${i}.bin`, chunk);
    } catch (e) {
      threw = e instanceof WorkspaceError;
    }
    expect(threw).toBe(true);
  });
});

describe('VirtualWorkspace — listing and reads', () => {
  it('lists files sorted with sizes and status', () => {
    const vfs = new VirtualWorkspace();
    vfs.stageProvided('b.txt', Buffer.from('bb'));
    vfs.writeFile('a.txt', 'aaa');
    expect(vfs.list()).toEqual([
      { path: 'a.txt', size: 3, status: 'created' },
      { path: 'b.txt', size: 2, status: 'provided' },
    ]);
  });

  it('throws on reading a missing file', () => {
    const vfs = new VirtualWorkspace();
    expect(() => vfs.readBuffer('nope.txt')).toThrow(WorkspaceError);
  });

  it('rejects escaping paths on every operation', () => {
    const vfs = new VirtualWorkspace();
    expect(() => vfs.writeFile('../escape.txt', 'x')).toThrow();
    expect(() => vfs.readBuffer('C:\\Windows\\win.ini')).toThrow();
    expect(vfs.fileCount).toBe(0);
  });
});
