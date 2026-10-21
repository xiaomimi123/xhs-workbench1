// 企业中枢接入：HUB_MCP_SERVERS_FILE 并入 agent 的 MCP 配置；不合法时一切照旧
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useTempWorkspace, server } from './helpers.mjs';

useTempWorkspace();
const { readHubServers, mergeHubServers, withHubMcp, writeHubConfig, sanitizeServer } = await server('hub-mcp.mjs');
const store = await server('store.mjs');
store.ensureWorkspace();
const { mcpConfigFor } = await server('browser.mjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-mcp-'));
const write = (obj, name = 'hub.json') => { const f = path.join(dir, name); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; };
const bridge = { command: 'node', args: ['bridge.mjs', '--hub', 'http://hub:8200/mcp'], env: { HUB_TOKEN: 'x' } };

test('没有环境变量 / 文件不存在：无服务、无报错', () => {
  assert.deepEqual(readHubServers({}), { servers: {}, file: null, problem: '' });
  const r = readHubServers({ HUB_MCP_SERVERS_FILE: path.join(dir, 'nope.json') });
  assert.deepEqual(r.servers, {});
  assert.match(r.problem, /读取中枢配置失败/);
  assert.match(readHubServers({ HUB_MCP_SERVERS_FILE: 'relative.json' }).problem, /绝对路径/);
});

test('合法文件：读到 enterprise-hub；只保留已知字段；坏条目、保留名（playwright）被忽略并说明', () => {
  const f = write({
    mcpServers: {
      'enterprise-hub': { ...bridge, evil: 'drop-me' },
      playwright: { command: 'steal', args: [] },
      '../bad name': bridge,
      nocommand: { foo: 1 },
      badargs: { command: 'x', args: [1] },
      remote: { url: 'https://hub.example/mcp', type: 'http', headers: { Authorization: 'Bearer t' } },
      notaurl: { url: 'file:///etc/passwd' },
    },
  });
  const r = readHubServers({ HUB_MCP_SERVERS_FILE: f });
  assert.deepEqual(Object.keys(r.servers).sort(), ['enterprise-hub', 'remote']);
  assert.equal(r.servers['enterprise-hub'].evil, undefined);
  assert.deepEqual(r.servers['enterprise-hub'].args, bridge.args);
  assert.match(r.problem, /已忽略/);
  assert.match(r.problem, /playwright/);
});

test('损坏的 JSON、缺 mcpServers、超大文件、目录：不抛错，返回空并给出原因', () => {
  assert.match(readHubServers({ HUB_MCP_SERVERS_FILE: write('{不是 json') }).problem, /读取中枢配置失败/);
  assert.match(readHubServers({ HUB_MCP_SERVERS_FILE: write({ other: 1 }) }).problem, /没有 mcpServers/);
  assert.match(readHubServers({ HUB_MCP_SERVERS_FILE: write(JSON.stringify({ mcpServers: { a: { command: 'x' } }, pad: 'x'.repeat(70 * 1024) })) }).problem, /超过 64KB/);
  assert.match(readHubServers({ HUB_MCP_SERVERS_FILE: dir }).problem, /普通文件|读取中枢配置失败/);
});

test('sanitizeServer：stdio / http 两种形态，类型不对返回 null', () => {
  assert.deepEqual(sanitizeServer({ command: 'a', args: ['b'], env: { K: 'v' } }), { command: 'a', args: ['b'], env: { K: 'v' } });
  assert.equal(sanitizeServer({ command: 'a', env: { K: 1 } }), null);
  assert.equal(sanitizeServer({ url: 'ftp://x' }), null);
  assert.equal(sanitizeServer('x'), null);
  assert.equal(sanitizeServer([]), null);
});

test('并入时不覆盖已有条目：中枢不能替换工作台自己的 playwright', () => {
  const f = write({ mcpServers: { 'enterprise-hub': bridge, playwright: { command: 'evil' } } });
  const want = mergeHubServers({ mcpServers: { playwright: { command: 'npx', args: ['pw'] } } }, { HUB_MCP_SERVERS_FILE: f });
  assert.deepEqual(Object.keys(want.mcpServers).sort(), ['enterprise-hub', 'playwright']);
  assert.equal(want.mcpServers.playwright.command, 'npx');
});

test('mcpConfigFor：没有环境变量时只有 playwright；有环境变量时多一个 enterprise-hub，playwright 不变；撤掉变量后恢复', () => {
  const prev = process.env.HUB_MCP_SERVERS_FILE;
  const read = () => JSON.parse(fs.readFileSync(mcpConfigFor('default', '@playwright/mcp@0.0.1'), 'utf8'));
  try {
    delete process.env.HUB_MCP_SERVERS_FILE;
    const plain = read();
    assert.deepEqual(Object.keys(plain.mcpServers), ['playwright']);
    process.env.HUB_MCP_SERVERS_FILE = write({ mcpServers: { 'enterprise-hub': bridge } });
    const withHub = read();
    assert.deepEqual(Object.keys(withHub.mcpServers).sort(), ['enterprise-hub', 'playwright']);
    assert.deepEqual(withHub.mcpServers.playwright, plain.mcpServers.playwright);
    delete process.env.HUB_MCP_SERVERS_FILE;
    assert.deepEqual(Object.keys(read().mcpServers), ['playwright']);
  } finally {
    if (prev === undefined) delete process.env.HUB_MCP_SERVERS_FILE; else process.env.HUB_MCP_SERVERS_FILE = prev;
  }
});

const servers = { 'enterprise-hub': { command: 'node' } };
const base = ['-p', '--output-format', 'stream-json', '--allowedTools', 'WebSearch,WebFetch'];

test('withHubMcp：普通对话任务加 --mcp-config 并放行中枢工具；已有 mcp-config 时只放行工具；不重复追加', () => {
  const a = withHubMcp(base, { adapterId: 'claude-code', useHub: true, servers, hubFile: '/h/hub.json' });
  assert.deepEqual(a.slice(-2), ['--mcp-config', '/h/hub.json']);
  assert.equal(a[a.indexOf('--allowedTools') + 1], 'WebSearch,WebFetch,mcp__enterprise-hub');
  assert.equal(base.length, 5); // 原数组没被修改
  const b = withHubMcp([...base, '--mcp-config', '/pw.json'], { adapterId: 'claude-code', useHub: true, servers, hubFile: '/h/hub.json' });
  assert.equal(b.filter((x) => x === '--mcp-config').length, 1);
  assert.match(b[b.indexOf('--allowedTools') + 1], /mcp__enterprise-hub/);
  assert.deepEqual(withHubMcp(['-p'], { adapterId: 'claude-code', useHub: true, servers, hubFile: 'h' }).slice(-2), ['--allowedTools', 'mcp__enterprise-hub']);
  const again = withHubMcp(a, { adapterId: 'claude-code', useHub: true, servers, hubFile: '/h/hub.json' });
  assert.equal(again[again.indexOf('--allowedTools') + 1], 'WebSearch,WebFetch,mcp__enterprise-hub');
});

test('withHubMcp：不该加的情况一律原样返回——本地描述助手（--strict-mcp-config）、浏览器专用任务、非 Claude Code、没有服务', () => {
  const strict = [...base, '--strict-mcp-config'];
  assert.equal(withHubMcp(strict, { adapterId: 'claude-code', useHub: true, servers, hubFile: 'h' }), strict);
  assert.equal(withHubMcp(base, { adapterId: 'claude-code', useHub: false, servers, hubFile: 'h' }), base);
  assert.equal(withHubMcp(base, { adapterId: 'codex', useHub: true, servers, hubFile: 'h' }), base);
  assert.equal(withHubMcp(base, { adapterId: 'claude-code', useHub: true, servers: {}, hubFile: 'h' }), base);
});

test('writeHubConfig：只含中枢服务；内容没变不重写，变了才重写', () => {
  const d = path.join(dir, 'mcp');
  const f = writeHubConfig(d, servers);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { mcpServers: servers });
  const before = fs.statSync(f).mtimeMs;
  writeHubConfig(d, servers);
  assert.equal(fs.statSync(f).mtimeMs, before);
  writeHubConfig(d, { 'enterprise-hub': { command: 'other' } });
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers['enterprise-hub'].command, 'other');
});

test('runCli 端到端：中枢服务文件存在时，普通任务的 agent 命令行带 --mcp-config 与放行的 mcp__enterprise-hub；浏览器专用任务与无环境变量时不带', async () => {
  const { runCli } = await server('bridge.mjs');
  const { fakeAdapter, FAKE_AGENT } = await import('./helpers.mjs');
  const audit = path.join(dir, 'audit');
  const prevEnv = { f: process.env.HUB_MCP_SERVERS_FILE, a: process.env.FAKE_AGENT_AUDIT_DIR, m: process.env.FAKE_AGENT_MODE };
  const adapter = fakeAdapter('claude-stream-json', { id: 'claude-code', args: [FAKE_AGENT, '--allowedTools', 'WebSearch,WebFetch'] });
  const lastArgs = () => { const f = fs.readdirSync(audit).sort().at(-1); return JSON.parse(fs.readFileSync(path.join(audit, f), 'utf8')).args; };
  try {
    process.env.FAKE_AGENT_AUDIT_DIR = audit;
    process.env.FAKE_AGENT_MODE = 'claude-json';
    process.env.HUB_MCP_SERVERS_FILE = write({ mcpServers: { 'enterprise-hub': bridge } });
    await runCli(adapter, '你好', { useHub: true }).promise;
    const withHub = lastArgs();
    const cfg = withHub[withHub.indexOf('--mcp-config') + 1];
    assert.deepEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')).mcpServers['enterprise-hub'].command, 'node');
    assert.match(withHub[withHub.indexOf('--allowedTools') + 1], /WebSearch,WebFetch,mcp__enterprise-hub/);
    await runCli(adapter, '浏览器专用任务', { useHub: false }).promise;
    assert.equal(lastArgs().includes('--mcp-config'), false);
    delete process.env.HUB_MCP_SERVERS_FILE;
    await runCli(adapter, '没有中枢', { useHub: true }).promise;
    assert.equal(lastArgs().includes('--mcp-config'), false);
  } finally {
    for (const [k, v] of [['HUB_MCP_SERVERS_FILE', prevEnv.f], ['FAKE_AGENT_AUDIT_DIR', prevEnv.a], ['FAKE_AGENT_MODE', prevEnv.m]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
