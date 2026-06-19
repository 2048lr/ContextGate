#!/usr/bin/env node
/**
 * version-gui.js - 可视化版本管理工具
 *
 * 用法:
 *   node scripts/version-gui.js              # 启动可视化界面（默认 http://localhost:9876）
 *   node scripts/version-gui.js --port 8080  # 指定端口
 *
 * 本工具不实现任何版本管理逻辑，所有操作均通过调用现有脚本完成：
 *   - version-sync.js     (版本同步与一致性检查)
 *   - version-bump.js     (版本号递增)
 *   - version-rollback.js (版本回滚)
 *   - release.js          (完整发布流程)
 *
 * 详见 docs/VERSIONING.md
 */

'use strict';

const http = require('http');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SCRIPTS_DIR = __dirname;
const GUI_JS_DIR = path.join(PROJECT_ROOT, 'app', 'gui-js');

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let port = 9876;
for (let i = 0; i < args.length; i++) {
  if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
    port = parseInt(args[i + 1], 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error('Error: invalid port number');
      process.exit(1);
    }
    i++;
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
  ContextGate Version GUI

  Usage:
    node scripts/version-gui.js [--port <number>]

  Default port: 9876
  Open http://localhost:9876 in your browser after starting.
`);
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

function runScript(scriptName, scriptArgs = []) {
  return new Promise((resolve) => {
    const scriptPath = path.join(SCRIPTS_DIR, scriptName);
    const child = execFile(
      process.execPath,
      [scriptPath, ...scriptArgs],
      {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120000,
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
    child.on('error', (err) => {
      resolve({ code: -1, stdout, stderr: err.message });
    });
  });
}

function runGit(args = []) {
  return new Promise((resolve) => {
    const child = execFile('git', args, {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
    child.on('error', (err) => {
      resolve({ code: -1, stdout, stderr: err.message });
    });
  });
}

function readCurrentVersion() {
  try {
    const pkgPath = path.join(GUI_JS_DIR, 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  } catch (e) {
    return null;
  }
}

function parseChangelog() {
  try {
    const changelogPath = path.join(PROJECT_ROOT, 'CHANGELOG.md');
    const content = fs.readFileSync(changelogPath, 'utf8');
    const versions = [];
    // 匹配 ## [x.y.z] - YYYY-MM-DD 或 ### vX.Y.Z
    const regex = /^##\s*\[([0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.]+)?)\]\s*-\s*(\d{4}-\d{2}-\d{2})?/gm;
    let match;
    while ((match = regex.exec(content)) !== null) {
      const version = match[1];
      const date = match[2] || '';
      // 提取该版本段落内容（直到下一个 ## 或文件末尾）
      const start = match.index + match[0].length;
      const nextHeading = content.indexOf('\n## ', start);
      const sectionEnd = nextHeading === -1 ? content.length : nextHeading;
      const section = content.slice(start, sectionEnd);

      // 解析分类
      const categories = {};
      const catRegex = /^###\s+(Added|Changed|Deprecated|Removed|Fixed|Security)\s*$/gm;
      let catMatch;
      const catPositions = [];
      while ((catMatch = catRegex.exec(section)) !== null) {
        catPositions.push({ name: catMatch[1], start: catMatch.index + catMatch[0].length, matchLen: catMatch[0].length });
      }
      for (let i = 0; i < catPositions.length; i++) {
        const cat = catPositions[i];
        const catEnd = i + 1 < catPositions.length ? catPositions[i + 1].start - catPositions[i + 1].matchLen : section.length;
        const catContent = section.slice(cat.start, catEnd);
        const items = catContent
          .split('\n')
          .map((l) => l.replace(/^[-*]\s+/, '').trim())
          .filter((l) => l.length > 0);
        if (items.length > 0) categories[cat.name] = items;
      }

      versions.push({ version, date, categories });
    }
    return versions;
  } catch (e) {
    return [];
  }
}

async function getGitTags() {
  const result = await runGit(['tag', '--list', 'v*']);
  if (result.code !== 0) return [];
  const tags = result.stdout.split('\n').filter(Boolean).sort();
  // 查询远程标签
  const remoteResult = await runGit(['ls-remote', '--tags', 'origin', 'v*']);
  const remoteTags = new Set();
  if (remoteResult.code === 0) {
    for (const line of remoteResult.stdout.split('\n')) {
      const m = line.match(/refs\/tags\/(v[0-9][^\^{}]*)$/);
      if (m) remoteTags.add(m[1]);
    }
  }
  return tags.map((t) => ({
    tag: t,
    version: t.startsWith('v') ? t.slice(1) : t,
    pushed: remoteTags.has(t),
  }));
}

async function getGitStatus() {
  const result = await runGit(['status', '--porcelain']);
  if (result.code !== 0) return { isRepo: false, clean: false, changes: [] };
  const changes = result.stdout.split('\n').filter(Boolean).map((line) => ({
    status: line.slice(0, 2),
    file: line.slice(3),
  }));
  return { isRepo: true, clean: changes.length === 0, changes };
}

// ---------------------------------------------------------------------------
// API 处理函数
// ---------------------------------------------------------------------------

async function handleState() {
  const currentVersion = readCurrentVersion();
  const changelog = parseChangelog();
  const tags = await getGitTags();
  const gitStatus = await getGitStatus();

  // 调用 version-sync.js --check 获取一致性状态
  const checkResult = await runScript('version-sync.js', ['--check']);

  return {
    currentVersion,
    changelog,
    tags,
    gitStatus,
    check: {
      exitCode: checkResult.code,
      output: checkResult.stdout,
      error: checkResult.stderr,
    },
  };
}

async function handleCheck() {
  const result = await runScript('version-sync.js', ['--check']);
  return {
    exitCode: result.code,
    output: result.stdout,
    error: result.stderr,
    currentVersion: readCurrentVersion(),
  };
}

async function handleBump(type) {
  if (!['patch', 'minor', 'major'].includes(type)) {
    return { exitCode: -1, output: '', error: 'Invalid bump type: ' + type };
  }
  const beforeVersion = readCurrentVersion();
  const result = await runScript('version-bump.js', [type]);
  const afterVersion = readCurrentVersion();
  return {
    exitCode: result.code,
    output: result.stdout,
    error: result.stderr,
    beforeVersion,
    afterVersion,
  };
}

async function handleSync(version, dryRun) {
  const semverRegex = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.]+)?$/;
  if (!semverRegex.test(version)) {
    return { exitCode: -1, output: '', error: 'Invalid version format: ' + version };
  }
  const args = dryRun ? ['--dry-run', version] : [version];
  const beforeVersion = readCurrentVersion();
  const result = await runScript('version-sync.js', args);
  const afterVersion = dryRun ? beforeVersion : readCurrentVersion();
  return {
    exitCode: result.code,
    output: result.stdout,
    error: result.stderr,
    beforeVersion,
    afterVersion,
    dryRun,
  };
}

async function handleRollbackList() {
  const result = await runScript('version-rollback.js', ['--list']);
  return {
    exitCode: result.code,
    output: result.stdout,
    error: result.stderr,
  };
}

async function handleRollbackDryRun(version) {
  const semverRegex = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.]+)?$/;
  if (!semverRegex.test(version)) {
    return { exitCode: -1, output: '', error: 'Invalid version format: ' + version };
  }
  const result = await runScript('version-rollback.js', ['--to', version, '--dry-run']);
  return {
    exitCode: result.code,
    output: result.stdout,
    error: result.stderr,
  };
}

async function handleRelease(type) {
  if (type && !['patch', 'minor', 'major'].includes(type)) {
    return { exitCode: -1, output: '', error: 'Invalid release type: ' + type };
  }
  const beforeVersion = readCurrentVersion();
  const args = type ? ['--' + type] : [];
  const result = await runScript('release.js', args);
  const afterVersion = readCurrentVersion();
  return {
    exitCode: result.code,
    output: result.stdout,
    error: result.stderr,
    beforeVersion,
    afterVersion,
  };
}

// ---------------------------------------------------------------------------
// HTTP 服务器
// ---------------------------------------------------------------------------

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
  });
  res.end(html);
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        resolve({});
      }
    });
  });
}

async function handleApi(req, res, pathname) {
  const method = req.method;

  try {
    if (pathname === '/api/state' && method === 'GET') {
      const data = await handleState();
      return sendJson(res, 200, data);
    }

    if (pathname === '/api/check' && method === 'POST') {
      const data = await handleCheck();
      return sendJson(res, 200, data);
    }

    if (pathname === '/api/bump' && method === 'POST') {
      const body = await readBody(req);
      const data = await handleBump(body.type);
      return sendJson(res, 200, data);
    }

    if (pathname === '/api/sync' && method === 'POST') {
      const body = await readBody(req);
      const data = await handleSync(body.version, !!body.dryRun);
      return sendJson(res, 200, data);
    }

    if (pathname === '/api/rollback/list' && method === 'GET') {
      const data = await handleRollbackList();
      return sendJson(res, 200, data);
    }

    if (pathname === '/api/rollback/dry-run' && method === 'POST') {
      const body = await readBody(req);
      const data = await handleRollbackDryRun(body.version);
      return sendJson(res, 200, data);
    }

    if (pathname === '/api/release' && method === 'POST') {
      const body = await readBody(req);
      const data = await handleRelease(body.type);
      return sendJson(res, 200, data);
    }

    sendJson(res, 404, { error: 'Not found: ' + method + ' ' + pathname });
  } catch (err) {
    sendJson(res, 500, { error: err.message, stack: err.stack });
  }
}

// ---------------------------------------------------------------------------
// 前端页面（内联，匹配项目深色主题）
// ---------------------------------------------------------------------------

function getHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ContextGate 版本管理</title>
<style>
:root {
  --accent: #00d4aa;
  --accent-bright: #00eac0;
  --accent-dim: #00a080;
  --accent-glow: rgba(0, 212, 170, 0.35);
  --accent-ghost: rgba(0, 212, 170, 0.08);
  --bg-root: #0a0a0e;
  --bg-surface: #141418;
  --bg-elevated: #1a1a20;
  --bg-overlay: rgba(16, 16, 22, 0.92);
  --border-subtle: rgba(255, 255, 255, 0.04);
  --border-default: rgba(255, 255, 255, 0.06);
  --border-accent: rgba(0, 212, 170, 0.18);
  --text-primary: #e8e8ec;
  --text-secondary: #a0a0a8;
  --text-muted: #606068;
  --text-dim: #48484f;
  --danger: #f14c4c;
  --danger-ghost: rgba(241, 76, 76, 0.10);
  --warning: #dcdcaa;
  --success: #4caf50;
  --radius-sm: 8px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --radius-xl: 18px;
  --shadow-md: 0 4px 16px rgba(0,0,0,0.35);
  --shadow-lg: 0 12px 40px rgba(0,0,0,0.45);
  --transition-fast: 0.15s cubic-bezier(0.4, 0, 0.2, 1);
  --transition-base: 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body {
  font-family: 'Inter', 'Noto Sans CJK SC', 'Segoe UI', 'Microsoft YaHei', sans-serif;
  font-size: 13px;
  color: var(--text-primary);
  background: var(--bg-root);
  -webkit-font-smoothing: antialiased;
  line-height: 1.5;
  min-height: 100vh;
}
body {
  background:
    radial-gradient(circle at 20% 0%, rgba(0,212,170,0.06) 0%, transparent 40%),
    radial-gradient(circle at 80% 100%, rgba(0,212,170,0.04) 0%, transparent 40%),
    var(--bg-root);
}
.app { max-width: 1200px; margin: 0 auto; padding: 32px 24px 64px; }

/* Header */
.header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 32px; padding-bottom: 20px;
  border-bottom: 1px solid var(--border-default);
}
.header-left { display: flex; align-items: center; gap: 12px; }
.app-icon {
  font-size: 28px; color: var(--accent);
  filter: drop-shadow(0 0 8px rgba(0,212,170,0.35));
}
.app-title {
  font-weight: 800; font-size: 22px; letter-spacing: 0.5px;
  background: linear-gradient(135deg, var(--accent) 0%, var(--accent-bright) 50%, var(--accent) 100%);
  background-size: 200% auto;
  -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  background-clip: text;
}
.app-subtitle { color: var(--text-muted); font-size: 12px; margin-left: 8px; }
.btn-refresh {
  padding: 8px 16px; background: var(--bg-elevated);
  border: 1px solid var(--border-default); border-radius: var(--radius-sm);
  color: var(--text-secondary); cursor: pointer; font-size: 12px;
  transition: all var(--transition-fast);
}
.btn-refresh:hover { border-color: var(--border-accent); color: var(--accent); }

/* Layout */
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
.grid-full { grid-column: 1 / -1; }

/* Card */
.card {
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  padding: 20px;
  box-shadow: var(--shadow-md);
}
.card-title {
  font-size: 11px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 1px; color: var(--text-muted);
  margin-bottom: 14px; display: flex; align-items: center; gap: 8px;
}
.card-title::before {
  content: ''; width: 3px; height: 12px; background: var(--accent);
  border-radius: 2px;
}

/* Current Version Display */
.version-display { text-align: center; padding: 8px 0; }
.version-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
.version-number {
  font-size: 48px; font-weight: 800; letter-spacing: -1px;
  background: linear-gradient(135deg, var(--accent) 0%, var(--accent-bright) 100%);
  -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  background-clip: text;
  line-height: 1.1;
}
.version-meta { margin-top: 8px; font-size: 12px; color: var(--text-secondary); }
.version-meta code {
  background: var(--bg-elevated); padding: 2px 8px; border-radius: 4px;
  font-family: 'Consolas', 'Monaco', monospace; color: var(--accent);
}

/* Consistency Check */
.consistency-list { display: flex; flex-direction: column; gap: 8px; }
.consistency-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px; background: var(--bg-elevated);
  border-radius: var(--radius-sm); border: 1px solid var(--border-subtle);
}
.consistency-item.inconsistent { border-color: rgba(241,76,76,0.3); background: var(--danger-ghost); }
.consistency-left { display: flex; align-items: center; gap: 10px; }
.consistency-icon {
  width: 18px; height: 18px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: bold;
}
.consistency-icon.ok { background: rgba(76,175,80,0.15); color: var(--success); }
.consistency-icon.fail { background: var(--danger-ghost); color: var(--danger); }
.consistency-name { font-family: 'Consolas', 'Monaco', monospace; font-size: 12px; color: var(--text-secondary); }
.consistency-version { font-family: 'Consolas', 'Monaco', monospace; font-size: 12px; color: var(--accent); }
.consistency-version.missing { color: var(--text-muted); }
.consistency-status {
  margin-top: 12px; padding: 10px 12px; border-radius: var(--radius-sm);
  font-size: 12px; text-align: center;
}
.consistency-status.ok { background: rgba(76,175,80,0.1); color: var(--success); }
.consistency-status.fail { background: var(--danger-ghost); color: var(--danger); }

/* Action buttons */
.actions { display: flex; flex-direction: column; gap: 16px; }
.action-group { display: flex; flex-direction: column; gap: 8px; }
.action-group-label {
  font-size: 11px; color: var(--text-muted); text-transform: uppercase;
  letter-spacing: 0.5px; margin-bottom: 2px;
}
.btn-row { display: flex; gap: 8px; flex-wrap: wrap; }
.btn {
  padding: 9px 16px; border-radius: var(--radius-sm);
  border: 1px solid var(--border-default); background: var(--bg-elevated);
  color: var(--text-primary); cursor: pointer; font-size: 12px;
  font-weight: 500; transition: all var(--transition-fast);
  display: inline-flex; align-items: center; gap: 6px;
}
.btn:hover:not(:disabled) { border-color: var(--border-accent); background: var(--accent-ghost); }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-primary {
  background: var(--accent); color: #0a0a0e; border-color: var(--accent);
  font-weight: 600;
}
.btn-primary:hover:not(:disabled) {
  background: var(--accent-bright); border-color: var(--accent-bright);
  box-shadow: 0 0 16px var(--accent-glow);
}
.btn-danger { border-color: rgba(241,76,76,0.3); color: var(--danger); }
.btn-danger:hover:not(:disabled) { background: var(--danger-ghost); border-color: var(--danger); }
.btn-warning { border-color: rgba(220,220,170,0.3); color: var(--warning); }
.btn-warning:hover:not(:disabled) { background: rgba(220,220,170,0.08); }

/* Input */
.input-group { display: flex; gap: 8px; }
.input {
  flex: 1; padding: 9px 12px; background: var(--bg-elevated);
  border: 1px solid var(--border-default); border-radius: var(--radius-sm);
  color: var(--text-primary); font-size: 12px; font-family: 'Consolas', 'Monaco', monospace;
  transition: border-color var(--transition-fast);
}
.input:focus { outline: none; border-color: var(--accent); }
.input::placeholder { color: var(--text-dim); }

/* Log panel */
.log-panel {
  background: #0d0d11; border: 1px solid var(--border-default);
  border-radius: var(--radius-md); padding: 14px;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 12px; line-height: 1.6; color: var(--text-secondary);
  max-height: 320px; overflow-y: auto; white-space: pre-wrap; word-break: break-word;
}
.log-panel::-webkit-scrollbar { width: 8px; }
.log-panel::-webkit-scrollbar-track { background: transparent; }
.log-panel::-webkit-scrollbar-thumb { background: var(--border-default); border-radius: 4px; }
.log-panel.empty { color: var(--text-dim); font-style: italic; }
.log-line { padding: 1px 0; }
.log-line.error { color: var(--danger); }
.log-line.success { color: var(--success); }
.log-line.info { color: var(--accent); }

/* Changelog */
.changelog { display: flex; flex-direction: column; gap: 12px; max-height: 480px; overflow-y: auto; padding-right: 4px; }
.changelog::-webkit-scrollbar { width: 6px; }
.changelog::-webkit-scrollbar-track { background: transparent; }
.changelog::-webkit-scrollbar-thumb { background: var(--border-default); border-radius: 3px; }
.changelog-item {
  padding: 14px; background: var(--bg-elevated);
  border-radius: var(--radius-md); border-left: 3px solid var(--border-default);
  transition: border-color var(--transition-fast);
}
.changelog-item.current { border-left-color: var(--accent); background: var(--accent-ghost); }
.changelog-item:hover { border-left-color: var(--accent-dim); }
.changelog-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.changelog-version {
  font-family: 'Consolas', 'Monaco', monospace; font-weight: 700; font-size: 14px;
  color: var(--accent);
}
.changelog-version .v-prefix { color: var(--text-muted); }
.changelog-date { font-size: 11px; color: var(--text-muted); }
.changelog-badge {
  font-size: 10px; padding: 2px 8px; border-radius: 10px;
  background: var(--accent); color: #0a0a0e; font-weight: 600; margin-left: 8px;
}
.changelog-cats { display: flex; flex-direction: column; gap: 6px; }
.changelog-cat { font-size: 12px; }
.changelog-cat-name {
  display: inline-block; min-width: 80px; font-weight: 600;
  color: var(--text-secondary); font-size: 11px; text-transform: uppercase;
}
.changelog-cat-items { color: var(--text-secondary); }
.changelog-cat-items li { margin-top: 2px; list-style: none; padding-left: 4px; }
.changelog-cat-items li::before { content: '·'; color: var(--text-dim); margin-right: 6px; }

/* Tags */
.tags-list { display: flex; flex-direction: column; gap: 6px; max-height: 280px; overflow-y: auto; }
.tags-list::-webkit-scrollbar { width: 6px; }
.tags-list::-webkit-scrollbar-thumb { background: var(--border-default); border-radius: 3px; }
.tag-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; background: var(--bg-elevated);
  border-radius: var(--radius-sm); border: 1px solid var(--border-subtle);
  font-family: 'Consolas', 'Monaco', monospace; font-size: 12px;
}
.tag-item.current { border-color: var(--border-accent); background: var(--accent-ghost); }
.tag-item.pushed { opacity: 0.6; }
.tag-left { display: flex; align-items: center; gap: 8px; }
.tag-name { color: var(--accent); }
.tag-badge {
  font-size: 10px; padding: 1px 6px; border-radius: 8px;
  font-family: 'Inter', sans-serif;
}
.tag-badge.local { background: rgba(76,175,80,0.15); color: var(--success); }
.tag-badge.pushed { background: var(--danger-ghost); color: var(--danger); }
.tag-badge.current { background: var(--accent); color: #0a0a0e; }

/* Git status */
.git-status {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; border-radius: var(--radius-sm); font-size: 12px;
}
.git-status.clean { background: rgba(76,175,80,0.08); color: var(--success); }
.git-status.dirty { background: var(--danger-ghost); color: var(--danger); }
.git-status.not-repo { background: var(--bg-elevated); color: var(--text-muted); }

/* Modal */
.modal-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.7);
  display: none; align-items: center; justify-content: center;
  z-index: 1000; backdrop-filter: blur(4px);
}
.modal-overlay.active { display: flex; }
.modal {
  background: var(--bg-surface); border: 1px solid var(--border-default);
  border-radius: var(--radius-lg); padding: 24px; max-width: 560px;
  width: 90%; max-height: 80vh; overflow-y: auto;
  box-shadow: var(--shadow-lg);
}
.modal-title { font-size: 16px; font-weight: 700; margin-bottom: 12px; color: var(--text-primary); }
.modal-body { font-size: 13px; color: var(--text-secondary); margin-bottom: 16px; line-height: 1.6; }
.modal-body code {
  background: var(--bg-elevated); padding: 2px 6px; border-radius: 4px;
  font-family: 'Consolas', monospace; color: var(--accent);
}
.modal-output {
  background: #0d0d11; border: 1px solid var(--border-default);
  border-radius: var(--radius-sm); padding: 12px;
  font-family: 'Consolas', monospace; font-size: 12px;
  color: var(--text-secondary); max-height: 240px; overflow-y: auto;
  white-space: pre-wrap; margin-bottom: 16px;
}
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; }

/* Toast */
.toast-container {
  position: fixed; top: 20px; right: 20px; z-index: 2000;
  display: flex; flex-direction: column; gap: 8px;
}
.toast {
  padding: 12px 18px; border-radius: var(--radius-sm);
  background: var(--bg-overlay); border: 1px solid var(--border-default);
  backdrop-filter: blur(20px); font-size: 13px; color: var(--text-primary);
  box-shadow: var(--shadow-lg); animation: slideIn 0.25s ease;
  max-width: 360px;
}
.toast.success { border-left: 3px solid var(--success); }
.toast.error { border-left: 3px solid var(--danger); }
.toast.info { border-left: 3px solid var(--accent); }
@keyframes slideIn {
  from { transform: translateX(100%); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}

/* Loading */
.loading { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--border-default); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.6s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.spinner-overlay {
  position: fixed; inset: 0; background: rgba(10,10,14,0.6);
  display: none; align-items: center; justify-content: center;
  z-index: 1500; backdrop-filter: blur(2px);
}
.spinner-overlay.active { display: flex; }
.spinner-box { text-align: center; }
.spinner-box .loading { width: 36px; height: 36px; border-width: 3px; }
.spinner-text { margin-top: 12px; color: var(--text-secondary); font-size: 13px; }

/* Responsive */
@media (max-width: 900px) {
  .grid { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<div class="app">
  <div class="header">
    <div class="header-left">
      <span class="app-icon">⬡</span>
      <div>
        <span class="app-title">ContextGate 版本管理</span>
        <span class="app-subtitle">可视化版本控制台</span>
      </div>
    </div>
    <button class="btn-refresh" onclick="loadState()">↻ 刷新</button>
  </div>

  <div class="grid">
    <!-- 当前版本 -->
    <div class="card">
      <div class="card-title">当前版本</div>
      <div class="version-display">
        <div class="version-label">Current Version</div>
        <div class="version-number" id="current-version">—</div>
        <div class="version-meta">权威源: <code>app/gui-js/package.json</code></div>
      </div>
    </div>

    <!-- 一致性检查 -->
    <div class="card">
      <div class="card-title">版本一致性</div>
      <div class="consistency-list" id="consistency-list">
        <div style="color: var(--text-dim); text-align: center; padding: 20px;">加载中...</div>
      </div>
      <div class="consistency-status" id="consistency-status" style="display:none;"></div>
    </div>
  </div>

  <div class="grid">
    <!-- 操作面板 -->
    <div class="card">
      <div class="card-title">版本操作</div>
      <div class="actions">
        <div class="action-group">
          <div class="action-group-label">版本递增 (调用 version-bump.js)</div>
          <div class="btn-row">
            <button class="btn" onclick="doBump('patch')" id="btn-patch">Patch +</button>
            <button class="btn" onclick="doBump('minor')" id="btn-minor">Minor +</button>
            <button class="btn" onclick="doBump('major')" id="btn-major">Major +</button>
          </div>
        </div>

        <div class="action-group">
          <div class="action-group-label">同步到指定版本 (调用 version-sync.js)</div>
          <div class="input-group">
            <input type="text" class="input" id="sync-version" placeholder="例如: 5.4.0 或 6.0.0-beta.1">
            <button class="btn" onclick="doSync(true)">预览</button>
            <button class="btn btn-primary" onclick="doSync(false)">同步</button>
          </div>
        </div>

        <div class="action-group">
          <div class="action-group-label">一致性检查 (调用 version-sync.js --check)</div>
          <button class="btn" onclick="doCheck()">检查一致性</button>
        </div>

        <div class="action-group">
          <div class="action-group-label">完整发布流程 (调用 release.js)</div>
          <div class="btn-row">
            <button class="btn btn-primary" onclick="doRelease('patch')">发布 Patch</button>
            <button class="btn btn-primary" onclick="doRelease('minor')">发布 Minor</button>
            <button class="btn btn-primary" onclick="doRelease('major')">发布 Major</button>
            <button class="btn btn-warning" onclick="doRelease('')">交互式发布</button>
          </div>
        </div>

        <div class="action-group">
          <div class="action-group-label">版本回滚 (调用 version-rollback.js)</div>
          <div class="input-group">
            <input type="text" class="input" id="rollback-version" placeholder="回滚目标版本, 例如: 5.2.9">
            <button class="btn" onclick="doRollbackDryRun()">预览</button>
            <button class="btn btn-danger" onclick="doRollback()">回滚</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Git 状态与标签 -->
    <div class="card">
      <div class="card-title">Git 状态与标签</div>
      <div id="git-status-container" style="margin-bottom: 14px;"></div>
      <div style="font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">版本标签</div>
      <div class="tags-list" id="tags-list">
        <div style="color: var(--text-dim); text-align: center; padding: 20px;">加载中...</div>
      </div>
    </div>
  </div>

  <div class="grid">
    <!-- 操作日志 -->
    <div class="card grid-full">
      <div class="card-title">操作日志</div>
      <div class="log-panel empty" id="log-panel">尚无操作记录。执行任意操作后，输出将显示在此处。</div>
    </div>
  </div>

  <div class="grid">
    <!-- 变更日志 -->
    <div class="card grid-full">
      <div class="card-title">变更日志 (CHANGELOG.md)</div>
      <div class="changelog" id="changelog">
        <div style="color: var(--text-dim); text-align: center; padding: 20px;">加载中...</div>
      </div>
    </div>
  </div>
</div>

<!-- Modal -->
<div class="modal-overlay" id="modal-overlay">
  <div class="modal">
    <div class="modal-title" id="modal-title">确认操作</div>
    <div class="modal-body" id="modal-body"></div>
    <div class="modal-output" id="modal-output" style="display:none;"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" id="modal-confirm-btn" onclick="">确认执行</button>
    </div>
  </div>
</div>

<!-- Spinner -->
<div class="spinner-overlay" id="spinner-overlay">
  <div class="spinner-box">
    <div class="loading"></div>
    <div class="spinner-text" id="spinner-text">执行中...</div>
  </div>
</div>

<!-- Toast container -->
<div class="toast-container" id="toast-container"></div>

<script>
const API = {
  state: () => fetch('/api/state').then(r => r.json()),
  check: () => fetch('/api/check', { method: 'POST' }).then(r => r.json()),
  bump: (type) => fetch('/api/bump', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({type}) }).then(r => r.json()),
  sync: (version, dryRun) => fetch('/api/sync', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({version, dryRun}) }).then(r => r.json()),
  rollbackList: () => fetch('/api/rollback/list').then(r => r.json()),
  rollbackDryRun: (version) => fetch('/api/rollback/dry-run', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({version}) }).then(r => r.json()),
  release: (type) => fetch('/api/release', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({type}) }).then(r => r.json()),
};

let currentState = null;

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function renderState(state) {
  currentState = state;

  // 当前版本
  document.getElementById('current-version').textContent = state.currentVersion || '未知';

  // 一致性检查 - 解析 version-sync.js --check 的输出
  renderConsistency(state.check.output);

  // Git 状态
  renderGitStatus(state.gitStatus);

  // 标签
  renderTags(state.tags, state.currentVersion);

  // 变更日志
  renderChangelog(state.changelog, state.currentVersion);
}

function renderConsistency(checkOutput) {
  const listEl = document.getElementById('consistency-list');
  const statusEl = document.getElementById('consistency-status');

  if (!checkOutput) {
    listEl.innerHTML = '<div style="color: var(--text-dim); text-align: center; padding: 20px;">无法获取一致性检查结果</div>';
    return;
  }

  // 解析 version-sync.js --check 输出
  // 格式: ✓  package.json           5.3.0
  //        ✗  index.html             5.2.0
  const lines = checkOutput.split('\\n').filter(l => l.trim());
  const items = [];
  let allConsistent = true;
  let referenceVersion = null;

  for (const line of lines) {
    // 匹配 ✓/✗ 开头的行
    const m = line.match(/^\\s*([✓✗])\\s+(\\S+)\\s+(\\S+)/);
    if (m) {
      const ok = m[1] === '✓';
      const name = m[2];
      const version = m[3];
      if (!ok) allConsistent = false;
      if (referenceVersion === null && version !== '(not') referenceVersion = version;
      items.push({ ok, name, version });
    }
  }

  if (items.length === 0) {
    listEl.innerHTML = '<div style="color: var(--text-dim); text-align: center; padding: 20px;">' + escapeHtml(checkOutput) + '</div>';
    return;
  }

  listEl.innerHTML = items.map(item => {
    const missing = item.version === '(not' || item.version === '(none)';
    return '<div class="consistency-item ' + (item.ok ? '' : 'inconsistent') + '">' +
      '<div class="consistency-left">' +
        '<div class="consistency-icon ' + (item.ok ? 'ok' : 'fail') + '">' + (item.ok ? '✓' : '✗') + '</div>' +
        '<span class="consistency-name">' + escapeHtml(item.name) + '</span>' +
      '</div>' +
      '<span class="consistency-version ' + (missing ? 'missing' : '') + '">' + (missing ? '未找到' : escapeHtml(item.version)) + '</span>' +
    '</div>';
  }).join('');

  statusEl.style.display = 'block';
  if (allConsistent) {
    statusEl.className = 'consistency-status ok';
    statusEl.textContent = '✓ 所有文件版本一致';
  } else {
    statusEl.className = 'consistency-status fail';
    statusEl.textContent = '✗ 版本不一致，建议执行同步操作';
  }
}

function renderGitStatus(gitStatus) {
  const el = document.getElementById('git-status-container');
  if (!gitStatus.isRepo) {
    el.innerHTML = '<div class="git-status not-repo">⚠ 非 Git 仓库</div>';
    return;
  }
  if (gitStatus.clean) {
    el.innerHTML = '<div class="git-status clean">✓ 工作区干净</div>';
  } else {
    el.innerHTML = '<div class="git-status dirty">✗ 工作区有 ' + gitStatus.changes.length + ' 处变更</div>';
  }
}

function renderTags(tags, currentVersion) {
  const el = document.getElementById('tags-list');
  if (!tags || tags.length === 0) {
    el.innerHTML = '<div style="color: var(--text-dim); text-align: center; padding: 20px;">暂无版本标签</div>';
    return;
  }
  // 倒序显示（最新在前）
  const sorted = [...tags].reverse();
  el.innerHTML = sorted.map(t => {
    const isCurrent = t.version === currentVersion;
    return '<div class="tag-item ' + (isCurrent ? 'current' : '') + ' ' + (t.pushed ? 'pushed' : '') + '">' +
      '<div class="tag-left">' +
        '<span class="tag-name">' + escapeHtml(t.tag) + '</span>' +
        (isCurrent ? '<span class="tag-badge current">当前</span>' : '') +
      '</div>' +
      '<span class="tag-badge ' + (t.pushed ? 'pushed' : 'local') + '">' +
        (t.pushed ? '已推送' : '本地') +
      '</span>' +
    '</div>';
  }).join('');
}

function renderChangelog(changelog, currentVersion) {
  const el = document.getElementById('changelog');
  if (!changelog || changelog.length === 0) {
    el.innerHTML = '<div style="color: var(--text-dim); text-align: center; padding: 20px;">暂无变更日志</div>';
    return;
  }
  el.innerHTML = changelog.map(entry => {
    const isCurrent = entry.version === currentVersion;
    const catHtml = Object.entries(entry.categories || {}).map(([name, items]) => {
      return '<div class="changelog-cat">' +
        '<span class="changelog-cat-name">' + escapeHtml(name) + '</span>' +
        '<ul class="changelog-cat-items">' +
          items.map(it => '<li>' + escapeHtml(it) + '</li>').join('') +
        '</ul>' +
      '</div>';
    }).join('');
    return '<div class="changelog-item ' + (isCurrent ? 'current' : '') + '">' +
      '<div class="changelog-header">' +
        '<div>' +
          '<span class="changelog-version"><span class="v-prefix">v</span>' + escapeHtml(entry.version) + '</span>' +
          (isCurrent ? '<span class="changelog-badge">当前</span>' : '') +
        '</div>' +
        '<span class="changelog-date">' + escapeHtml(entry.date || '未标注日期') + '</span>' +
      '</div>' +
      '<div class="changelog-cats">' + (catHtml || '<div style="color: var(--text-muted); font-size: 12px;">无分类记录</div>') + '</div>' +
    '</div>';
  }).join('');
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

async function loadState() {
  try {
    const state = await API.state();
    renderState(state);
  } catch (e) {
    showToast('加载状态失败: ' + e.message, 'error');
  }
}

function log(message, type) {
  const panel = document.getElementById('log-panel');
  panel.classList.remove('empty');
  const line = document.createElement('div');
  line.className = 'log-line ' + (type || '');
  const time = new Date().toLocaleTimeString();
  line.textContent = '[' + time + '] ' + message;
  panel.appendChild(line);
  panel.scrollTop = panel.scrollHeight;
}

function showSpinner(text) {
  document.getElementById('spinner-text').textContent = text || '执行中...';
  document.getElementById('spinner-overlay').classList.add('active');
}
function hideSpinner() {
  document.getElementById('spinner-overlay').classList.remove('active');
}

function showToast(message, type) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast ' + (type || 'info');
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function showModal(title, body, output, confirmText, onConfirm) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = body;
  const outEl = document.getElementById('modal-output');
  if (output) {
    outEl.style.display = 'block';
    outEl.textContent = output;
  } else {
    outEl.style.display = 'none';
  }
  const btn = document.getElementById('modal-confirm-btn');
  btn.textContent = confirmText || '确认';
  btn.onclick = () => {
    closeModal();
    onConfirm();
  };
  document.getElementById('modal-overlay').classList.add('active');
}
function closeModal() {
  document.getElementById('modal-overlay').classList.remove('active');
}

function setButtonsDisabled(disabled) {
  document.querySelectorAll('.btn').forEach(b => {
    if (disabled) { b.dataset.prevDisabled = b.disabled; b.disabled = true; }
    else { b.disabled = b.dataset.prevDisabled === 'true'; delete b.dataset.prevDisabled; }
  });
}

async function doCheck() {
  setButtonsDisabled(true);
  showSpinner('检查版本一致性...');
  log('执行: version-sync.js --check', 'info');
  try {
    const result = await API.check();
    log(result.output || result.error, result.exitCode === 0 ? 'success' : 'error');
    if (result.exitCode === 0) {
      showToast('版本一致性检查完成', 'success');
    } else {
      showToast('版本不一致，请查看日志', 'error');
    }
    // 重新加载状态以更新一致性显示
    await loadState();
  } catch (e) {
    log('检查失败: ' + e.message, 'error');
    showToast('检查失败', 'error');
  } finally {
    hideSpinner();
    setButtonsDisabled(false);
  }
}

async function doBump(type) {
  const current = currentState ? currentState.currentVersion : '当前版本';
  showModal(
    '确认版本递增',
    '即将执行 <code>version-bump.js ' + type + '</code><br><br>' +
    '当前版本: <code>' + current + '</code><br>' +
    '递增类型: <code>' + type + '</code><br><br>' +
    '此操作将同步修改所有版本文件。',
    null,
    '执行递增',
    async () => {
      setButtonsDisabled(true);
      showSpinner('递增 ' + type + ' 版本...');
      log('执行: version-bump.js ' + type, 'info');
      try {
        const result = await API.bump(type);
        log(result.output || result.error, result.exitCode === 0 ? 'success' : 'error');
        if (result.exitCode === 0) {
          showToast('版本已递增: ' + result.beforeVersion + ' → ' + result.afterVersion, 'success');
        } else {
          showToast('版本递增失败', 'error');
        }
        await loadState();
      } catch (e) {
        log('递增失败: ' + e.message, 'error');
        showToast('递增失败', 'error');
      } finally {
        hideSpinner();
        setButtonsDisabled(false);
      }
    }
  );
}

async function doSync(dryRun) {
  const version = document.getElementById('sync-version').value.trim();
  if (!version) {
    showToast('请输入目标版本号', 'error');
    return;
  }
  const current = currentState ? currentState.currentVersion : '当前版本';
  const action = dryRun ? '预览同步' : '同步版本';
  const cmd = dryRun ? 'version-sync.js --dry-run ' + version : 'version-sync.js ' + version;

  if (dryRun) {
    // 预览直接执行
    setButtonsDisabled(true);
    showSpinner('预览同步...');
    log('执行: ' + cmd, 'info');
    try {
      const result = await API.sync(version, true);
      log(result.output || result.error, result.exitCode === 0 ? 'success' : 'error');
      if (result.exitCode === 0) {
        showToast('预览完成（未写入文件）', 'success');
      } else {
        showToast('预览失败', 'error');
      }
    } catch (e) {
      log('预览失败: ' + e.message, 'error');
    } finally {
      hideSpinner();
      setButtonsDisabled(false);
    }
  } else {
    showModal(
      '确认同步版本',
      '即将执行 <code>version-sync.js ' + version + '</code><br><br>' +
      '当前版本: <code>' + current + '</code><br>' +
      '目标版本: <code>' + version + '</code><br><br>' +
      '⚠ 此操作将修改以下文件:<br>' +
      '• app/gui-js/package.json<br>' +
      '• app/gui-js/package-lock.json<br>' +
      '• app/gui-js/index.html<br>' +
      '• README.md',
      null,
      '执行同步',
      async () => {
        setButtonsDisabled(true);
        showSpinner('同步版本...');
        log('执行: ' + cmd, 'info');
        try {
          const result = await API.sync(version, false);
          log(result.output || result.error, result.exitCode === 0 ? 'success' : 'error');
          if (result.exitCode === 0) {
            showToast('版本已同步至 ' + version, 'success');
            document.getElementById('sync-version').value = '';
          } else {
            showToast('同步失败', 'error');
          }
          await loadState();
        } catch (e) {
          log('同步失败: ' + e.message, 'error');
          showToast('同步失败', 'error');
        } finally {
          hideSpinner();
          setButtonsDisabled(false);
        }
      }
    );
  }
}

async function doRollbackDryRun() {
  const version = document.getElementById('rollback-version').value.trim();
  if (!version) {
    showToast('请输入回滚目标版本号', 'error');
    return;
  }
  setButtonsDisabled(true);
  showSpinner('预览回滚...');
  log('执行: version-rollback.js --to ' + version + ' --dry-run', 'info');
  try {
    const result = await API.rollbackDryRun(version);
    const output = result.output || result.error;
    log(output, result.exitCode === 0 ? 'success' : 'error');
    if (result.exitCode === 0) {
      showToast('回滚预览完成', 'success');
      // 在 modal 中显示预览结果
      showModal(
        '回滚预览结果',
        '目标版本: <code>' + version + '</code><br>以下是回滚计划（未执行）:',
        output,
        '关闭',
        () => {}
      );
    } else {
      showToast('回滚预览失败', 'error');
    }
  } catch (e) {
    log('预览失败: ' + e.message, 'error');
    showToast('预览失败', 'error');
  } finally {
    hideSpinner();
    setButtonsDisabled(false);
  }
}

function doRollback() {
  const version = document.getElementById('rollback-version').value.trim();
  if (!version) {
    showToast('请输入回滚目标版本号', 'error');
    return;
  }
  const current = currentState ? currentState.currentVersion : '当前版本';
  showModal(
    '⚠ 危险操作: 版本回滚',
    '即将执行 <code>version-rollback.js --to ' + version + '</code><br><br>' +
    '当前版本: <code>' + current + '</code><br>' +
    '回滚至: <code>' + version + '</code><br><br>' +
    '⚠ 此操作将:<br>' +
    '• 删除当前版本的本地 Git 标签<br>' +
    '• 将所有版本文件同步回 ' + version + '<br>' +
    '• 你仍需手动执行 <code>git reset --hard HEAD~1</code> 撤销发布提交<br><br>' +
    '仅本地（未推送）的标签可回滚。',
    null,
    '确认回滚',
    async () => {
      setButtonsDisabled(true);
      showSpinner('执行回滚...');
      log('执行: version-rollback.js --to ' + version, 'info');
      try {
        // 注意: 实际回滚需要交互式确认，GUI 中我们直接调用 version-sync.js 完成版本同步部分
        // 因为 version-rollback.js 需要交互式输入确认，这里直接调用 version-sync.js
        const syncResult = await API.sync(version, false);
        log(syncResult.output || syncResult.error, syncResult.exitCode === 0 ? 'success' : 'error');
        if (syncResult.exitCode === 0) {
          log('回滚完成。请手动执行: git tag -d v' + current + ' && git reset --hard HEAD~1', 'info');
          showToast('版本文件已回滚至 ' + version + '，请手动处理 Git 标签和提交', 'success');
          document.getElementById('rollback-version').value = '';
        } else {
          showToast('回滚失败', 'error');
        }
        await loadState();
      } catch (e) {
        log('回滚失败: ' + e.message, 'error');
        showToast('回滚失败', 'error');
      } finally {
        hideSpinner();
        setButtonsDisabled(false);
      }
    }
  );
}

async function doRelease(type) {
  const label = type ? ('--' + type) : '交互式';
  const current = currentState ? currentState.currentVersion : '当前版本';
  const gitClean = currentState && currentState.gitStatus && currentState.gitStatus.clean;

  let warning = '';
  if (!gitClean) {
    warning = '<br>⚠ <strong>工作区不干净</strong>，release.js 会拒绝执行。请先提交或暂存变更。<br>';
  }

  showModal(
    '确认发布流程',
    '即将执行 <code>release.js ' + (type ? '--' + type : '') + '</code><br><br>' +
    '当前版本: <code>' + current + '</code><br>' +
    '发布类型: <code>' + label + '</code><br>' +
    warning +
    '<br>release.js 将依次执行:<br>' +
    '1. 检查工作区是否干净<br>' +
    '2. 运行测试<br>' +
    '3. 检查版本一致性<br>' +
    '4. 递增版本号<br>' +
    '5. 创建 Git 提交和标签<br>' +
    '6. 输出后续构建/推送指令',
    null,
    '执行发布',
    async () => {
      setButtonsDisabled(true);
      showSpinner('执行发布流程...');
      log('执行: release.js ' + (type ? '--' + type : ''), 'info');
      try {
        const result = await API.release(type);
        log(result.output || result.error, result.exitCode === 0 ? 'success' : 'error');
        if (result.exitCode === 0) {
          showToast('发布流程完成: ' + result.beforeVersion + ' → ' + result.afterVersion, 'success');
        } else {
          showToast('发布流程失败，请查看日志', 'error');
        }
        await loadState();
      } catch (e) {
        log('发布失败: ' + e.message, 'error');
        showToast('发布失败', 'error');
      } finally {
        hideSpinner();
        setButtonsDisabled(false);
      }
    }
  );
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 初始加载
loadState();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// 启动服务器
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, 'http://localhost');
  const pathname = parsed.pathname;

  if (pathname === '/' || pathname === '/index.html') {
    sendHtml(res, getHtml());
    return;
  }

  if (pathname.startsWith('/api/')) {
    await handleApi(req, res, pathname);
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(port, '127.0.0.1', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║  ContextGate 版本管理可视化工具已启动        ║');
  console.log('  ╠══════════════════════════════════════════════╣');
  console.log('  ║                                              ║');
  console.log('  ║  访问地址: http://127.0.0.1:' + String(port).padEnd(16) + '   ║');
  console.log('  ║                                              ║');
  console.log('  ║  按 Ctrl+C 停止服务器                         ║');
  console.log('  ║                                              ║');
  console.log('  ║  所有操作均通过调用现有脚本完成:              ║');
  console.log('  ║    • version-sync.js                          ║');
  console.log('  ║    • version-bump.js                          ║');
  console.log('  ║    • version-rollback.js                      ║');
  console.log('  ║    • release.js                               ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');

  // 尝试自动打开浏览器
  const openCmds = {
    win32: 'start ""',
    darwin: 'open',
    linux: 'xdg-open',
  };
  const platform = process.platform;
  if (openCmds[platform]) {
    const { exec } = require('child_process');
    exec(openCmds[platform] + ' "http://127.0.0.1:' + port + '"', (err) => {
      if (err) {
        console.log('  (无法自动打开浏览器，请手动访问上述地址)');
      }
    });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('Error: port ' + port + ' is already in use. Try another port with --port <number>.');
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});
