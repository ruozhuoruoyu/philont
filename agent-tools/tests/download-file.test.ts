/**
 * downloadFile 工具单测
 *
 * 跑一个本地 HTTP server 做下载源,覆盖:
 *   - 基本下载 + 字节计数 + content-type 返回
 *   - 超 maxBytes 中止并清理 partial
 *   - 相对路径被拒
 *   - 404 → success=false
 *   - 父目录自动创建
 *   - 不把内容进 output(只返回路径 + 元信息)
 */

import { describe, it, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, stat, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  downloadFileTool,
  parseContentDisposition,
  filenameFromUrl,
  sanitizeFilename,
} from '../src/index.js';

let server: Server;
let port: number;
let TMP: string;

describe('downloadFile', () => {
  before(async () => {
    TMP = await mkdtemp(join(tmpdir(), 'philont-dl-'));
    server = createServer((req, res) => {
      if (req.url === '/small') {
        res.writeHead(200, { 'content-type': 'application/pdf' });
        res.end(Buffer.from('PDF-bytes-abc'));
      } else if (req.url === '/big') {
        // 1MB 的 payload
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.alloc(1024 * 1024, 'x'));
      } else if (req.url === '/notfound') {
        res.writeHead(404);
        res.end('nope');
      } else if (req.url === '/advertised-big') {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(10 * 1024 * 1024),
        });
        res.end(Buffer.alloc(1024 * 1024, 'x'));
      } else if (req.url === '/pdf/2601.07372.pdf') {
        // arxiv-like URL: 文件名应该从 path 取
        res.writeHead(200, { 'content-type': 'application/pdf' });
        res.end(Buffer.from('arxiv-pdf-bytes'));
      } else if (req.url === '/with-content-disposition') {
        // 服务端给出文件名,优先级高于 URL
        res.writeHead(200, {
          'content-type': 'application/pdf',
          'content-disposition': 'attachment; filename="DeepSeek-V4.pdf"',
        });
        res.end(Buffer.from('cd-pdf-bytes'));
      } else if (req.url === '/cd-utf8') {
        // RFC 5987 编码
        res.writeHead(200, {
          'content-type': 'application/pdf',
          'content-disposition':
            "attachment; filename*=UTF-8''%E4%B8%AD%E6%96%87%E6%A1%A3.pdf",
        });
        res.end(Buffer.from('utf8-pdf-bytes'));
      } else if (req.url === '/no-extension') {
        // 路径无扩展名,需要靠 mime 兜底
        res.writeHead(200, { 'content-type': 'application/pdf' });
        res.end(Buffer.from('xx'));
      } else if (req.url === '/') {
        // 根路径,文件名要走兜底
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.from('root-bytes'));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve()),
    );
    port = (server.address() as { port: number }).port;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(TMP, { recursive: true, force: true });
  });

  it('downloads a small file and reports metadata', async () => {
    const dest = join(TMP, 'small.pdf');
    const r = await downloadFileTool.execute({
      url: `http://127.0.0.1:${port}/small`,
      dest,
    });
    assert.equal(r.success, true);
    const meta = JSON.parse(r.output);
    assert.equal(meta.path, dest);
    assert.equal(meta.bytes, 13);
    assert.equal(meta.contentType, 'application/pdf');

    // 文件落盘
    const bytes = await readFile(dest);
    assert.equal(bytes.toString(), 'PDF-bytes-abc');
  });

  it('aborts and cleans up when download exceeds maxBytes (streamed)', async () => {
    const dest = join(TMP, 'big.bin');
    const r = await downloadFileTool.execute({
      url: `http://127.0.0.1:${port}/big`,
      dest,
      maxBytes: 100_000,
    });
    assert.equal(r.success, false);
    assert.ok(r.error?.includes('maxBytes'));

    // 主文件不应存在
    await assert.rejects(() => stat(dest));
    // partial 也应被清理
    await assert.rejects(() => stat(`${dest}.partial`));
  });

  it('rejects when advertised Content-Length exceeds maxBytes', async () => {
    const dest = join(TMP, 'adv.bin');
    const r = await downloadFileTool.execute({
      url: `http://127.0.0.1:${port}/advertised-big`,
      dest,
      maxBytes: 1_000_000,
    });
    assert.equal(r.success, false);
    assert.ok(r.error?.includes('Content-Length'));
  });

  it('rejects relative dest', async () => {
    const r = await downloadFileTool.execute({
      url: `http://127.0.0.1:${port}/small`,
      dest: 'relative.bin',
    });
    assert.equal(r.success, false);
    assert.ok(r.error?.includes('absolute'));
  });

  it('returns failure on 404 without writing partial', async () => {
    const dest = join(TMP, 'nope.bin');
    const r = await downloadFileTool.execute({
      url: `http://127.0.0.1:${port}/notfound`,
      dest,
    });
    assert.equal(r.success, false);
    assert.ok(r.error?.includes('404'));
    await assert.rejects(() => stat(dest));
    await assert.rejects(() => stat(`${dest}.partial`));
  });

  it('auto-creates parent directory', async () => {
    const dest = join(TMP, 'deep/nested/dir/small.pdf');
    const r = await downloadFileTool.execute({
      url: `http://127.0.0.1:${port}/small`,
      dest,
    });
    assert.equal(r.success, true);
    const info = await stat(dest);
    assert.equal(info.size, 13);
  });

  it('output does not contain downloaded bytes (stays out of LLM context)', async () => {
    const dest = join(TMP, 'clean.pdf');
    const r = await downloadFileTool.execute({
      url: `http://127.0.0.1:${port}/small`,
      dest,
    });
    assert.equal(r.success, true);
    // output 是 JSON { path, bytes, contentType },不应包含原始内容字串
    assert.ok(!r.output.includes('PDF-bytes-abc'));
  });

  it('metadata on tool definition is correct', () => {
    assert.equal(downloadFileTool.name, 'downloadFile');
    assert.equal(downloadFileTool.capability, 'write');
    assert.equal(downloadFileTool.domain, 'network');
    assert.ok(downloadFileTool.description.includes('download') || downloadFileTool.description.includes('Download'));
  });

  // ── 新场景:dest 可省略 / Content-Disposition / URL 文件名 / 冲突 ──

  it('uses default dir from PHILONT_DOWNLOAD_DIR env when dest is omitted', async () => {
    const dlDir = join(TMP, 'env-default');
    process.env.PHILONT_DOWNLOAD_DIR = dlDir;
    try {
      const r = await downloadFileTool.execute({
        url: `http://127.0.0.1:${port}/pdf/2601.07372.pdf`,
      });
      assert.equal(r.success, true);
      const meta = JSON.parse(r.output);
      assert.equal(meta.path, join(dlDir, '2601.07372.pdf'));
      const bytes = await readFile(meta.path);
      assert.equal(bytes.toString(), 'arxiv-pdf-bytes');
    } finally {
      delete process.env.PHILONT_DOWNLOAD_DIR;
    }
  });

  it('treats dest as parent dir when it ends with /', async () => {
    const dlDir = join(TMP, 'as-dir') + '/';
    const r = await downloadFileTool.execute({
      url: `http://127.0.0.1:${port}/pdf/2601.07372.pdf`,
      dest: dlDir,
    });
    assert.equal(r.success, true);
    const meta = JSON.parse(r.output);
    assert.equal(meta.path, join(TMP, 'as-dir', '2601.07372.pdf'));
  });

  it('treats dest as parent dir when it is an existing directory', async () => {
    const dlDir = join(TMP, 'existing-dir');
    await mkdir(dlDir, { recursive: true });
    const r = await downloadFileTool.execute({
      url: `http://127.0.0.1:${port}/pdf/2601.07372.pdf`,
      dest: dlDir, // no trailing slash, but exists as dir
    });
    assert.equal(r.success, true);
    const meta = JSON.parse(r.output);
    assert.equal(meta.path, join(dlDir, '2601.07372.pdf'));
  });

  it('Content-Disposition takes precedence over URL pathname', async () => {
    const dlDir = join(TMP, 'cd-priority') + '/';
    const r = await downloadFileTool.execute({
      url: `http://127.0.0.1:${port}/with-content-disposition`,
      dest: dlDir,
    });
    assert.equal(r.success, true);
    const meta = JSON.parse(r.output);
    assert.equal(meta.path, join(TMP, 'cd-priority', 'DeepSeek-V4.pdf'));
  });

  it('decodes RFC 5987 encoded filename*= header', async () => {
    const dlDir = join(TMP, 'cd-utf8') + '/';
    const r = await downloadFileTool.execute({
      url: `http://127.0.0.1:${port}/cd-utf8`,
      dest: dlDir,
    });
    assert.equal(r.success, true);
    const meta = JSON.parse(r.output);
    assert.equal(meta.path, join(TMP, 'cd-utf8', '中文档.pdf'));
  });

  it('falls back to download-<hash>.<ext> when URL has no filename', async () => {
    const dlDir = join(TMP, 'fallback') + '/';
    const r = await downloadFileTool.execute({
      url: `http://127.0.0.1:${port}/`, // root path → no filename
      dest: dlDir,
    });
    assert.equal(r.success, true);
    const meta = JSON.parse(r.output);
    assert.match(meta.path, /download-[a-z0-9]+\.bin$/);
  });

  it('appends -1, -2 suffix on collision (no overwrite default)', async () => {
    const dlDir = join(TMP, 'collide') + '/';
    // 第一次:落到 2601.07372.pdf
    const r1 = await downloadFileTool.execute({
      url: `http://127.0.0.1:${port}/pdf/2601.07372.pdf`,
      dest: dlDir,
    });
    assert.equal(r1.success, true);
    const m1 = JSON.parse(r1.output);
    assert.equal(m1.path, join(TMP, 'collide', '2601.07372.pdf'));

    // 第二次:应落到 -1
    const r2 = await downloadFileTool.execute({
      url: `http://127.0.0.1:${port}/pdf/2601.07372.pdf`,
      dest: dlDir,
    });
    assert.equal(r2.success, true);
    const m2 = JSON.parse(r2.output);
    assert.equal(m2.path, join(TMP, 'collide', '2601.07372-1.pdf'));

    // 第三次:-2
    const r3 = await downloadFileTool.execute({
      url: `http://127.0.0.1:${port}/pdf/2601.07372.pdf`,
      dest: dlDir,
    });
    const m3 = JSON.parse(r3.output);
    assert.equal(m3.path, join(TMP, 'collide', '2601.07372-2.pdf'));
  });

  it('overwrite=true bypasses collision suffix', async () => {
    const dest = join(TMP, 'overwrite-target.pdf');
    await writeFile(dest, 'old-content');
    const r = await downloadFileTool.execute({
      url: `http://127.0.0.1:${port}/small`,
      dest,
      overwrite: true,
    });
    assert.equal(r.success, true);
    const meta = JSON.parse(r.output);
    assert.equal(meta.path, dest); // 没加后缀
    const bytes = await readFile(dest);
    assert.equal(bytes.toString(), 'PDF-bytes-abc'); // 内容是新的
  });

  it('falls back to ~/.philont/downloads when both dest and env are absent', async () => {
    // 不真往 ~ 写。覆盖 HOME → 临时目录,期望路径在临时目录下。
    const oldHome = process.env.HOME;
    const oldDl = process.env.PHILONT_DOWNLOAD_DIR;
    const fakeHome = join(TMP, 'fake-home');
    process.env.HOME = fakeHome;
    delete process.env.PHILONT_DOWNLOAD_DIR;
    try {
      const r = await downloadFileTool.execute({
        url: `http://127.0.0.1:${port}/pdf/2601.07372.pdf`,
      });
      assert.equal(r.success, true);
      const meta = JSON.parse(r.output);
      assert.equal(meta.path, join(fakeHome, '.philont', 'downloads', '2601.07372.pdf'));
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldDl !== undefined) process.env.PHILONT_DOWNLOAD_DIR = oldDl;
    }
  });
});

// ── 纯函数辅助测试(无网络) ────────────────────────────────

test('parseContentDisposition: quoted filename', () => {
  assert.equal(
    parseContentDisposition('attachment; filename="paper.pdf"'),
    'paper.pdf',
  );
});

test('parseContentDisposition: bare filename', () => {
  assert.equal(
    parseContentDisposition('attachment; filename=paper.pdf'),
    'paper.pdf',
  );
});

test('parseContentDisposition: RFC 5987 UTF-8 编码', () => {
  assert.equal(
    parseContentDisposition("attachment; filename*=UTF-8''%E6%96%87%E6%A1%A3.pdf"),
    '文档.pdf',
  );
});

test('parseContentDisposition: filename*= 优先级高于 filename=', () => {
  // 同时给两个时,UTF-8 编码版本应胜出(它支持非 ASCII)
  const both =
    'attachment; filename="docs.pdf"; filename*=UTF-8\'\'%E4%B8%AD%E6%96%87.pdf';
  assert.equal(parseContentDisposition(both), '中文.pdf');
});

test('parseContentDisposition: 缺失 / null → null', () => {
  assert.equal(parseContentDisposition(null), null);
  assert.equal(parseContentDisposition(''), null);
  assert.equal(parseContentDisposition('inline'), null);
});

test('filenameFromUrl: 普通路径', () => {
  assert.equal(
    filenameFromUrl('https://arxiv.org/pdf/2601.07372.pdf'),
    '2601.07372.pdf',
  );
});

test('filenameFromUrl: query / hash 不影响', () => {
  assert.equal(
    filenameFromUrl('https://example.com/dir/file.zip?token=abc#section'),
    'file.zip',
  );
});

test('filenameFromUrl: percent-encoded 解码', () => {
  assert.equal(
    filenameFromUrl('https://example.com/%E6%96%87%E6%A1%A3.pdf'),
    '文档.pdf',
  );
});

test('filenameFromUrl: 根路径返回 null', () => {
  assert.equal(filenameFromUrl('https://example.com/'), null);
  assert.equal(filenameFromUrl('https://example.com'), null);
});

test('filenameFromUrl: 非法 URL → null', () => {
  assert.equal(filenameFromUrl('not a url'), null);
});

test('sanitizeFilename: 路径分隔符 → _,阻断穿越', () => {
  // /\\ 替成 _ 后,join(parentDir, name) 永远只是 dir 里的一个文件,
  // 不会跨出去。前导 ".." 被剥到第一个 "_" 为止。
  const out = sanitizeFilename('../../etc/passwd');
  assert.ok(!out.includes('/'));
  assert.ok(!out.includes('\\'));
  assert.equal(out, '_.._etc_passwd');
});

test('sanitizeFilename: 反斜杠也 → _', () => {
  const out = sanitizeFilename('foo\\bar.exe');
  assert.equal(out, 'foo_bar.exe');
});

test('sanitizeFilename: 控制字符 → _', () => {
  assert.equal(sanitizeFilename('a\x00b\x1Fc.pdf'), 'a_b_c.pdf');
});

test('sanitizeFilename: 前后空白和点被剥', () => {
  assert.equal(sanitizeFilename('  ..report.pdf  '), 'report.pdf');
  assert.equal(sanitizeFilename('foo.pdf...'), 'foo.pdf');
});

test('sanitizeFilename: 单点 / 双点 → 空', () => {
  assert.equal(sanitizeFilename('.'), '');
  assert.equal(sanitizeFilename('..'), '');
});

test('sanitizeFilename: 超长截断保留扩展名', () => {
  const long = 'x'.repeat(300) + '.pdf';
  const out = sanitizeFilename(long);
  assert.ok(out.length <= 200);
  assert.ok(out.endsWith('.pdf'));
});

test('sanitizeFilename: 普通 CJK / emoji 保留', () => {
  assert.equal(sanitizeFilename('中文档案 v2.pdf'), '中文档案 v2.pdf');
  assert.equal(sanitizeFilename('😊-cool.png'), '😊-cool.png');
});
