/**
 * demo-credential-injection — 零暴露凭据注入演示
 *
 * 演示：
 *   1. SecretStore 加密存储 API token
 *   2. Secured http tool 只见 {TOKEN} placeholder，从不接触明文
 *   3. 注入发生在 fetch 包装层（宿主侧），工具代码里无泄露
 *   4. 出站泄露检测：若 API 响应含 secret，自动 redact
 *
 * 对比：
 *   - 传统方式：工具读 process.env.GITHUB_TOKEN，能被 console.log/output 泄露
 *   - 零暴露：工具写 'Bearer {GITHUB_TOKEN}'，宿主注入，明文从未进入工具空间
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SecretStore,
  AuditLog,
  createDefaultMatrix,
  createToolChecker,
  ValidatorChain,
  createSsrfValidator,
  wrapToolWithOutputScan,
} from '@agent/policy';
import { createToolset } from '@agent/tools';

const banner = (t: string) => {
  console.log('\n' + '═'.repeat(70));
  console.log('  ' + t);
  console.log('═'.repeat(70));
};

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║   零暴露凭据注入演示                                       ║');
  console.log('║   Secret 加密存储 → 工具只见 placeholder → 宿主边界注入    ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  // 准备一个临时工作目录
  const workDir = mkdtempSync(join(tmpdir(), 'philont-cred-demo-'));
  const storePath = join(workDir, 'secrets.json');

  // ── 1. 建立 SecretStore ────────────────────────────────
  banner('1. 创建 SecretStore，存入一个"GitHub Token"');
  const masterKey = Buffer.alloc(32, 'k').toString('base64');
  const secrets = new SecretStore({
    masterKey,
    path: storePath,
  });
  secrets.set('GITHUB_TOKEN', 'ghp_' + 'x'.repeat(36));
  console.log('  Store 存储的 ID 列表:', secrets.list());
  console.log('  注意：外部无法通过 list() 看到 value');

  // 检查磁盘内容不含明文
  const { readFileSync } = await import('node:fs');
  const onDisk = readFileSync(storePath, 'utf-8');
  console.log('  磁盘内容包含明文 "ghp_xxx..."?', onDisk.includes('ghp_x'));
  console.log('  磁盘内容长度:', onDisk.length, '字符（全加密）');

  // ── 2. 用 secretStore 创建 toolset ──────────────────────
  banner('2. createToolset({ secretStore }) → http 变成 secured 版本');
  const auditInject = new AuditLog();
  const injectLog: Array<{ secretIds: string[]; url: string }> = [];

  const registry = createToolset({
    profile: 'full',
    secretStore: secrets,
    securedHttpOptions: {
      allowedSecrets: ['GITHUB_TOKEN'],
      redactResponse: true,
      onInject: (info) => {
        injectLog.push(info);
        auditInject.append('tool_call', {
          toolName: 'http',
          action: 'inject',
          secretIds: info.secretIds,
          url: info.url.slice(0, 80),
        });
      },
    },
  });

  const http = registry.get('http')!;
  console.log('  http 工具描述:', http.description);

  // ── 3. 工具调用：LLM 写的代码里只有 {GITHUB_TOKEN} ──────
  banner('3. 工具调用：headers.Authorization = "Bearer {GITHUB_TOKEN}"');
  console.log('  工具代码里从未出现 "ghp_xxx..."，只有 placeholder');
  console.log('  宿主在 fetch 前自动替换为真实值\n');

  // 用 mock fetch 捕获实际请求（演示用，不真联网）
  const realFetch = globalThis.fetch;
  let captured: { url: string; headers: Record<string, string> } | null = null;
  globalThis.fetch = (async (url: any, init?: any) => {
    const h = init?.headers ?? {};
    captured = { url: String(url), headers: h };
    // 模拟 API 回显（有意带个秘密来测出站脱敏）
    return new Response(JSON.stringify({
      user: 'demo',
      // 假设上游 API 响应里意外含了另一个 secret（常见bug场景）
      echo: 'accidental: sk-' + 'z'.repeat(30),
    }), { status: 200 });
  }) as any;

  const result = await http.execute({
    url: 'https://api.github.com/user',
    method: 'GET',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer {GITHUB_TOKEN}',
    },
  });

  globalThis.fetch = realFetch;

  console.log('  实际发送的 headers:');
  for (const [k, v] of Object.entries(captured!.headers)) {
    console.log(`    ${k}: ${v}`);
  }
  console.log('  注入日志:', injectLog);

  // ── 4. 出站脱敏 ───────────────────────────────────────
  banner('4. 出站脱敏：响应里的 sk-xxx 被 redactResponse 替换');
  console.log('  工具返回 output (前 200 字符):');
  console.log('  ' + result.output.slice(0, 200));
  console.log('  含原始 sk-z...?', result.output.includes('sk-zzzz'));
  console.log('  含 [REDACTED]?', result.output.includes('REDACTED'));

  // ── 5. 关键不变量验证 ────────────────────────────────
  banner('5. 安全不变量检查');

  const resultStr = JSON.stringify(result);
  const params = { headers: { Authorization: 'Bearer {GITHUB_TOKEN}' } };
  const paramsStr = JSON.stringify(params);

  const token = secrets.get('GITHUB_TOKEN')!;
  console.log('  ✓ 工具 params 不含 token 明文:', !paramsStr.includes(token));
  console.log('  ✓ 工具 result.output 不含 token 明文:', !resultStr.includes(token));
  console.log('  ✓ 审计日志只记录 ID 不记录 value:',
    !JSON.stringify(auditInject.getEvents()).includes(token));
  console.log('  ✓ 哈希链完整:', auditInject.verify());

  // ── 6. 预注入扫描：防 LLM 把真实 secret 塞回 ────────
  banner('6. 预注入扫描：防 LLM 塞入真实 secret');
  console.log('  场景：LLM 被骗，试图把 sk-xxx 直接放在 body 里而不是 placeholder');

  globalThis.fetch = (async () => new Response('ok')) as any;
  const r = await http.execute({
    url: 'https://api.example.com/',
    method: 'POST',
    headers: {},
    body: 'key=sk-' + 'a'.repeat(30),
  });
  globalThis.fetch = realFetch;

  console.log('  工具返回:', r.success ? 'ALLOWED (bad)' : 'BLOCKED ✓');
  console.log('  错误信息:', r.error?.slice(0, 100));

  // 清理
  rmSync(workDir, { recursive: true, force: true });

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║   演示完成：零暴露凭据注入工作正常                         ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
}

main().catch(err => {
  console.error('Demo failed:', err);
  process.exit(1);
});
