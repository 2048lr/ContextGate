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

// Git 标签创建
async function handleTagCreate(version, message) {
  const semverRegex = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.]+)?$/;
  if (!semverRegex.test(version)) {
    return { exitCode: -1, output: '', error: 'Invalid version format: ' + version };
  }
  const tag = 'v' + version;
  const msg = message || ('Release ' + tag);
  const existingTags = await getGitTags();
  if (existingTags.some(t => t.tag === tag)) {
    return { exitCode: -1, output: '', error: 'Tag ' + tag + ' already exists' };
  }
  const result = await runGit(['tag', '-a', tag, '-m', msg]);
  return {
    exitCode: result.code,
    output: result.stdout || result.stderr || ('Created tag ' + tag),
    error: result.stderr,
    tag: tag,
  };
}

// 构建打包
function handleBuild() {
  return new Promise((resolve) => {
    const child = execFile('npm', ['run', 'build:win'], {
      cwd: GUI_JS_DIR,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      timeout: 600000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      const distPath = path.join(GUI_JS_DIR, 'dist');
      let artifacts = [];
      try {
        if (fs.existsSync(distPath)) {
          artifacts = fs.readdirSync(distPath).map(f => {
            const filePath = path.join(distPath, f);
            const stat = fs.statSync(filePath);
            return { name: f, size: stat.size, path: filePath };
          }).filter(f => f.name.endsWith('.exe') || f.name.endsWith('.7z') || f.name.endsWith('.yml') || f.name.endsWith('.blockmap'));
        }
      } catch (e) {}
      resolve({ exitCode: code, stdout: stdout, stderr: stderr, artifacts: artifacts });
    });
    child.on('error', (err) => {
      resolve({ exitCode: -1, stdout: '', stderr: err.message, artifacts: [] });
    });
  });
}

// GitHub Releases 上传 - 使用 SSE 流式传输进度
const uploadSessions = new Map();

// 从 git remote 自动检测 GitHub owner/repo
async function getGitHubRepoInfo() {
  const remoteResult = await runGit(['remote', 'get-url', 'origin']);
  if (remoteResult.code !== 0) {
    return { hasRemote: false, owner: null, repo: null };
  }
  const url = remoteResult.stdout.trim();
  let owner = null, repo = null;
  // https://github.com/owner/repo.git
  let m = url.match(/github\.com[/:]([^\/]+)\/([^\/\s]+?)(?:\.git)?$/);
  if (m) {
    owner = m[1];
    repo = m[2];
  }
  return { hasRemote: !!owner, owner: owner, repo: repo, remoteUrl: url };
}

// 创建 GitHub Release
function handleGitHubReleaseCreate(token, owner, repo, tagName, releaseName, body, prerelease, draft) {
  return new Promise((resolve) => {
    const https = require('https');
    const payload = JSON.stringify({
      tag_name: tagName,
      name: releaseName || tagName,
      body: body || '',
      draft: !!draft,
      prerelease: !!prerelease,
    });
    const options = {
      hostname: 'api.github.com',
      path: '/repos/' + owner + '/' + repo + '/releases',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'ContextGate-VersionGUI',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch(e) {}
        if (res.statusCode >= 200 && res.statusCode < 300 && parsed) {
          resolve({
            exitCode: 0,
            releaseId: parsed.id,
            htmlUrl: parsed.html_url,
            uploadUrl: parsed.upload_url,
            tagName: parsed.tag_name,
            output: 'GitHub Release 已创建: ' + (parsed.html_url || ''),
          });
        } else {
          resolve({
            exitCode: -1,
            error: 'HTTP ' + res.statusCode + ': ' + (parsed && parsed.message ? parsed.message : data),
            output: data,
          });
        }
      });
    });
    req.on('error', (err) => {
      resolve({ exitCode: -1, error: err.message, output: '' });
    });
    req.write(payload);
    req.end();
  });
}

// 启动 GitHub 资源上传
function handleUploadStart(artifactPath, github) {
  const uploadId = 'upload_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  if (!fs.existsSync(artifactPath)) {
    return { exitCode: -1, error: 'File not found: ' + artifactPath };
  }
  const stat = fs.statSync(artifactPath);
  const session = {
    id: uploadId,
    filePath: artifactPath,
    fileSize: stat.size,
    fileName: path.basename(artifactPath),
    github: github,
    progress: 0,
    status: 'pending',
    startTime: null,
    endTime: null,
    error: null,
    response: null,
  };
  uploadSessions.set(uploadId, session);
  startGitHubUpload(session);
  return { exitCode: 0, uploadId: uploadId, fileSize: stat.size, fileName: path.basename(artifactPath) };
}

// 上传到 GitHub Releases Assets 端点
function startGitHubUpload(session) {
  session.status = 'uploading';
  session.startTime = Date.now();
  const https = require('https');
  const g = session.github;
  if (!g || !g.token || !g.owner || !g.repo || !g.releaseId) {
    session.status = 'failed';
    session.error = '缺少 GitHub 配置 (token/owner/repo/releaseId)';
    session.endTime = Date.now();
    return;
  }
  const fileName = encodeURIComponent(session.fileName);
  const options = {
    hostname: 'uploads.github.com',
    path: '/repos/' + g.owner + '/' + g.repo + '/releases/' + g.releaseId + '/assets?name=' + fileName,
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + g.token,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'ContextGate-VersionGUI',
      'Content-Type': 'application/octet-stream',
      'Content-Length': session.fileSize,
    },
  };
  const fileStream = fs.createReadStream(session.filePath);
  let uploaded = 0;
  const req = https.request(options, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        session.progress = 100;
        session.status = 'completed';
        session.endTime = Date.now();
        session.response = body;
      } else {
        session.status = 'failed';
        session.error = 'HTTP ' + res.statusCode + ': ' + body;
        session.endTime = Date.now();
      }
    });
  });
  req.on('error', (err) => {
    session.status = 'failed';
    session.error = err.message;
    session.endTime = Date.now();
  });
  fileStream.on('data', (chunk) => {
    uploaded += chunk.length;
    session.progress = Math.round((uploaded / session.fileSize) * 100);
  });
  fileStream.pipe(req);
}

function handleUploadProgress(uploadId) {
  const session = uploadSessions.get(uploadId);
  if (!session) return null;
  return {
    uploadId: session.id,
    progress: session.progress,
    status: session.status,
    fileSize: session.fileSize,
    fileName: session.fileName,
    error: session.error,
  };
}

// 提交管理 + 自动更新 CHANGELOG.md
async function handleCommit(message, changelogContent, version) {
  const results = { commit: null, changelog: null };

  // 1. 更新 CHANGELOG.md（将所有提交信息合并为一个完整整体，不分类不分组）
  if (changelogContent && changelogContent.trim().length > 0) {
    try {
      const changelogPath = path.join(PROJECT_ROOT, 'CHANGELOG.md');
      let content = fs.readFileSync(changelogPath, 'utf8');
      const today = new Date().toISOString().slice(0, 10);
      const versionStr = version || readCurrentVersion();
      let newSection = '## [' + versionStr + '] - ' + today + '\n\n';
      // 直接将完整内容写入，保持原始完整性和逻辑连贯性
      newSection += changelogContent.trim() + '\n';
      const firstVersionIdx = content.indexOf('\n## [');
      if (firstVersionIdx !== -1) {
        content = content.slice(0, firstVersionIdx + 1) + newSection + content.slice(firstVersionIdx + 1);
      } else {
        content += '\n' + newSection;
      }
      fs.writeFileSync(changelogPath, content, 'utf8');
      results.changelog = { success: true, version: versionStr, date: today };
    } catch (e) {
      results.changelog = { success: false, error: e.message };
    }
  }

  // 2. Git add 和 commit
  try {
    await runGit(['add', '-A']);
    const commitResult = await runGit(['commit', '-m', message]);
    results.commit = {
      exitCode: commitResult.code,
      output: commitResult.stdout || commitResult.stderr,
      error: commitResult.stderr,
    };
  } catch (e) {
    results.commit = { exitCode: -1, output: '', error: e.message };
  }
  return results;
}

// 仓库状态对比
async function handleRepoDiff() {
  const result = {
    isRepo: false,
    branch: null,
    remote: null,
    ahead: 0,
    behind: 0,
    aheadCommits: [],
    behindCommits: [],
    localChanges: [],
    remoteExists: false,
    fetchError: null,
  };
  const isRepoResult = await runGit(['rev-parse', '--is-inside-work-tree']);
  if (isRepoResult.code !== 0 || isRepoResult.stdout.trim() !== 'true') return result;
  result.isRepo = true;

  const branchResult = await runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  result.branch = branchResult.stdout.trim();

  const remoteResult = await runGit(['remote']);
  result.remoteExists = remoteResult.stdout.trim().length > 0;
  if (result.remoteExists) {
    result.remote = remoteResult.stdout.trim().split('\n')[0];
    const fetchResult = await runGit(['fetch', result.remote, '--quiet']);
    if (fetchResult.code !== 0) result.fetchError = fetchResult.stderr || 'Fetch failed';

    if (result.branch) {
      const upstream = result.remote + '/' + result.branch;
      const countResult = await runGit(['rev-list', '--left-right', '--count', upstream + '...HEAD']);
      if (countResult.code === 0) {
        const parts = countResult.stdout.trim().split(/\s+/);
        result.behind = parseInt(parts[0], 10) || 0;
        result.ahead = parseInt(parts[1], 10) || 0;
      }
      if (result.ahead > 0) {
        const aheadResult = await runGit(['log', '--oneline', upstream + '..HEAD']);
        if (aheadResult.code === 0) {
          result.aheadCommits = aheadResult.stdout.split('\n').filter(Boolean).map(line => {
            const m = line.match(/^([a-f0-9]+)\s+(.*)/);
            return m ? { hash: m[1], message: m[2] } : { hash: '', message: line };
          });
        }
      }
      if (result.behind > 0) {
        const behindResult = await runGit(['log', '--oneline', 'HEAD..' + upstream]);
        if (behindResult.code === 0) {
          result.behindCommits = behindResult.stdout.split('\n').filter(Boolean).map(line => {
            const m = line.match(/^([a-f0-9]+)\s+(.*)/);
            return m ? { hash: m[1], message: m[2] } : { hash: '', message: line };
          });
        }
      }
    }
  }

  const statusResult = await runGit(['status', '--porcelain']);
  if (statusResult.code === 0) {
    result.localChanges = statusResult.stdout.split('\n').filter(Boolean).map(line => ({
      status: line.slice(0, 2),
      file: line.slice(3),
    }));
  }
  return result;
}

// 完整发布流程（整合标签+构建+上传）
async function handleFullRelease(type, options) {
  const steps = [];
  const currentVersion = readCurrentVersion();

  // Step 1: 检查版本一致性
  const checkResult = await runScript('version-sync.js', ['--check']);
  steps.push({ step: 'check', name: '版本一致性检查', exitCode: checkResult.code, output: checkResult.stdout });
  if (checkResult.code !== 0) {
    return { steps: steps, error: '版本一致性检查失败', currentVersion: currentVersion };
  }

  // Step 2: 递增版本号
  if (type) {
    const bumpResult = await runScript('version-bump.js', [type]);
    steps.push({ step: 'bump', name: '版本递增', exitCode: bumpResult.code, output: bumpResult.stdout });
    if (bumpResult.code !== 0) {
      return { steps: steps, error: '版本递增失败', currentVersion: currentVersion };
    }
  }
  const newVersion = readCurrentVersion();

  // Step 3: 更新 CHANGELOG（合并为完整整体，不分类不分组）
  if (options && options.changelogContent && options.changelogContent.trim().length > 0) {
    try {
      const changelogPath = path.join(PROJECT_ROOT, 'CHANGELOG.md');
      let content = fs.readFileSync(changelogPath, 'utf8');
      const today = new Date().toISOString().slice(0, 10);
      let newSection = '## [' + newVersion + '] - ' + today + '\n\n';
      newSection += options.changelogContent.trim() + '\n';
      const firstVersionIdx = content.indexOf('\n## [');
      if (firstVersionIdx !== -1) {
        content = content.slice(0, firstVersionIdx + 1) + newSection + content.slice(firstVersionIdx + 1);
      } else {
        content += '\n' + newSection;
      }
      fs.writeFileSync(changelogPath, content, 'utf8');
      steps.push({ step: 'changelog', name: '更新变更日志', exitCode: 0, output: 'CHANGELOG.md 已更新 (v' + newVersion + ')' });
    } catch (e) {
      steps.push({ step: 'changelog', name: '更新变更日志', exitCode: -1, output: e.message });
    }
  }

  // Step 4: Git 提交
  const commitMessage = (options && options.commitMessage) || ('release: v' + newVersion);
  await runGit(['add', '-A']);
  const commitResult = await runGit(['commit', '-m', commitMessage]);
  steps.push({ step: 'commit', name: 'Git 提交', exitCode: commitResult.code, output: commitResult.stdout || commitResult.stderr });

  // Step 5: 创建标签
  const tagMessage = (options && options.tagMessage) || ('Release v' + newVersion);
  const tagResult = await runGit(['tag', '-a', 'v' + newVersion, '-m', tagMessage]);
  steps.push({ step: 'tag', name: '创建 Git 标签', exitCode: tagResult.code, output: tagResult.stdout || tagResult.stderr || ('已创建标签 v' + newVersion) });

  // Step 6: 构建（如果请求）
  if (options && options.build) {
    const buildResult = await handleBuild();
    steps.push({ step: 'build', name: '构建打包', exitCode: buildResult.exitCode, output: buildResult.stdout.slice(-500), artifacts: buildResult.artifacts });

    // Step 7: 创建 GitHub Release 并上传（如果请求）
    if (options.upload && buildResult.artifacts && buildResult.artifacts.length > 0) {
      if (!options.githubToken || !options.githubOwner || !options.githubRepo) {
        steps.push({ step: 'upload', name: 'GitHub Release 上传', exitCode: -1, output: '缺少 GitHub 配置 (token/owner/repo)' });
      } else {
        // 创建 Release
        const tagName = 'v' + newVersion;
        const releaseBody = (options.changelogContent && options.changelogContent.trim()) || '';
        const releaseResult = await handleGitHubReleaseCreate(
          options.githubToken, options.githubOwner, options.githubRepo,
          tagName, 'Release ' + tagName, releaseBody, false, false
        );
        steps.push({ step: 'release_create', name: '创建 GitHub Release', exitCode: releaseResult.exitCode, output: releaseResult.output || releaseResult.error });
        if (releaseResult.exitCode === 0 && releaseResult.releaseId) {
          // 上传所有构建产物
          for (const artifact of buildResult.artifacts) {
            const uploadStart = handleUploadStart(artifact.path, {
              token: options.githubToken,
              owner: options.githubOwner,
              repo: options.githubRepo,
              releaseId: releaseResult.releaseId,
            });
            steps.push({ step: 'upload', name: '上传 ' + artifact.name, exitCode: uploadStart.exitCode, output: uploadStart.error || ('开始上传: ' + artifact.name), uploadId: uploadStart.uploadId });
          }
        }
      }
    }
  }

  return { steps: steps, currentVersion: currentVersion, newVersion: newVersion, error: null };
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

    if (pathname === '/api/tag/create' && method === 'POST') {
      const body = await readBody(req);
      const data = await handleTagCreate(body.version, body.message);
      return sendJson(res, 200, data);
    }
    if (pathname === '/api/build' && method === 'POST') {
      const data = await handleBuild();
      return sendJson(res, 200, data);
    }
    if (pathname === '/api/upload/start' && method === 'POST') {
      const body = await readBody(req);
      const data = handleUploadStart(body.artifactPath, body.github);
      return sendJson(res, 200, data);
    }
    if (pathname === '/api/github/config' && method === 'GET') {
      const data = await getGitHubRepoInfo();
      return sendJson(res, 200, data);
    }
    if (pathname === '/api/github/release/create' && method === 'POST') {
      const body = await readBody(req);
      const data = await handleGitHubReleaseCreate(body.token, body.owner, body.repo, body.tagName, body.releaseName, body.body, body.prerelease, body.draft);
      return sendJson(res, 200, data);
    }
    if (pathname === '/api/commit' && method === 'POST') {
      const body = await readBody(req);
      const data = await handleCommit(body.message, body.changelogContent, body.version);
      return sendJson(res, 200, data);
    }
    if (pathname === '/api/repo/diff' && method === 'GET') {
      const data = await handleRepoDiff();
      return sendJson(res, 200, data);
    }
    if (pathname === '/api/release/full' && method === 'POST') {
      const body = await readBody(req);
      const data = await handleFullRelease(body.type, body);
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

/* 进度条 */
.progress-bar-container {
  width: 100%; height: 24px; background: var(--bg-elevated);
  border-radius: var(--radius-sm); overflow: hidden;
  border: 1px solid var(--border-default); position: relative;
}
.progress-bar-fill {
  height: 100%; background: linear-gradient(90deg, var(--accent) 0%, var(--accent-bright) 100%);
  transition: width 0.3s ease; border-radius: var(--radius-sm);
}
.progress-bar-text {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  font-size: 11px; font-weight: 600; color: var(--text-primary);
  text-shadow: 0 1px 2px rgba(0,0,0,0.5);
}
.upload-status { margin-top: 8px; font-size: 12px; color: var(--text-secondary); }
.upload-status.success { color: var(--success); }
.upload-status.error { color: var(--danger); }

/* 构建产物列表 */
.artifact-list { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
.artifact-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; background: var(--bg-elevated);
  border-radius: var(--radius-sm); border: 1px solid var(--border-subtle);
  font-size: 12px;
}
.artifact-name { font-family: 'Consolas', monospace; color: var(--accent); }
.artifact-size { color: var(--text-muted); font-size: 11px; }
.artifact-upload-btn { padding: 4px 10px; font-size: 11px; }

/* 变更日志编辑器 */
.changelog-editor { display: flex; flex-direction: column; gap: 12px; }
.changelog-cat-row { display: flex; flex-direction: column; gap: 4px; }
.changelog-cat-label {
  font-size: 11px; font-weight: 600; color: var(--text-secondary);
  text-transform: uppercase; letter-spacing: 0.5px;
}
.changelog-cat-input {
  width: 100%; padding: 8px 12px; background: var(--bg-elevated);
  border: 1px solid var(--border-default); border-radius: var(--radius-sm);
  color: var(--text-primary); font-size: 12px; font-family: inherit;
  resize: vertical; min-height: 60px; transition: border-color var(--transition-fast);
}
.changelog-cat-input:focus { outline: none; border-color: var(--accent); }
.changelog-cat-input::placeholder { color: var(--text-dim); }
.changelog-hint { font-size: 11px; color: var(--text-muted); margin-top: -4px; }

/* 仓库状态对比 */
.repo-diff-section { margin-bottom: 16px; }
.repo-diff-title {
  font-size: 11px; font-weight: 600; color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;
}
.repo-diff-stats { display: flex; gap: 12px; margin-bottom: 10px; }
.repo-diff-stat {
  flex: 1; padding: 10px; background: var(--bg-elevated);
  border-radius: var(--radius-sm); text-align: center;
  border: 1px solid var(--border-subtle);
}
.repo-diff-stat-value { font-size: 22px; font-weight: 700; line-height: 1.2; }
.repo-diff-stat-value.ahead { color: var(--success); }
.repo-diff-stat-value.behind { color: var(--danger); }
.repo-diff-stat-value.clean { color: var(--accent); }
.repo-diff-stat-label { font-size: 10px; color: var(--text-muted); text-transform: uppercase; margin-top: 2px; }
.repo-commit-list { display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow-y: auto; }
.repo-commit-list::-webkit-scrollbar { width: 6px; }
.repo-commit-list::-webkit-scrollbar-thumb { background: var(--border-default); border-radius: 3px; }
.repo-commit-item {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; background: var(--bg-elevated);
  border-radius: var(--radius-sm); font-size: 12px;
}
.repo-commit-hash { font-family: 'Consolas', monospace; color: var(--accent); font-size: 11px; flex-shrink: 0; }
.repo-commit-msg { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.repo-file-list { display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow-y: auto; }
.repo-file-list::-webkit-scrollbar { width: 6px; }
.repo-file-list::-webkit-scrollbar-thumb { background: var(--border-default); border-radius: 3px; }
.repo-file-item {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; background: var(--bg-elevated);
  border-radius: var(--radius-sm); font-size: 12px;
}
.repo-file-status {
  font-family: 'Consolas', monospace; font-size: 10px; font-weight: 700;
  padding: 1px 5px; border-radius: 3px; flex-shrink: 0; min-width: 28px; text-align: center;
}
.repo-file-status.modified { background: rgba(220,220,170,0.15); color: var(--warning); }
.repo-file-status.added { background: rgba(76,175,80,0.15); color: var(--success); }
.repo-file-status.deleted { background: var(--danger-ghost); color: var(--danger); }
.repo-file-status.untracked { background: rgba(0,212,170,0.15); color: var(--accent); }
.repo-file-name { font-family: 'Consolas', monospace; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.repo-branch-info { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; font-size: 12px; }
.repo-branch-name { color: var(--accent); font-family: 'Consolas', monospace; font-weight: 600; }
.repo-arrow { color: var(--text-muted); }
.repo-remote-name { color: var(--text-secondary); font-family: 'Consolas', monospace; }

/* 步骤列表（完整发布流程） */
.release-steps { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; }
.release-step {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px; background: var(--bg-elevated);
  border-radius: var(--radius-sm); font-size: 12px;
}
.release-step-icon {
  width: 18px; height: 18px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: bold; flex-shrink: 0;
}
.release-step-icon.ok { background: rgba(76,175,80,0.15); color: var(--success); }
.release-step-icon.fail { background: var(--danger-ghost); color: var(--danger); }
.release-step-icon.pending { background: var(--bg-surface); color: var(--text-muted); }
.release-step-name { color: var(--text-secondary); flex: 1; }
.release-step-status { font-size: 11px; color: var(--text-muted); }

/* 标签创建区域 */
.tag-create-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.tag-message-input { flex: 1; min-width: 200px; }

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
            <button class="btn" onclick="doBump('patch')" id="btn-patch">补丁 +</button>
            <button class="btn" onclick="doBump('minor')" id="btn-minor">次版本 +</button>
            <button class="btn" onclick="doBump('major')" id="btn-major">主版本 +</button>
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
            <button class="btn btn-primary" onclick="doRelease('patch')">发布补丁版本</button>
            <button class="btn btn-primary" onclick="doRelease('minor')">发布次版本</button>
            <button class="btn btn-primary" onclick="doRelease('major')">发布主版本</button>
            <button class="btn btn-warning" onclick="doRelease('')">交互式发布</button>
          </div>
        </div>

        <div class="action-group">
          <div class="action-group-label">一键发布 (检查→递增→提交→标签→构建→上传)</div>
          <div class="btn-row">
            <button class="btn btn-primary" onclick="doFullRelease('patch')">一键发布补丁</button>
            <button class="btn btn-primary" onclick="doFullRelease('minor')">一键发布次版本</button>
            <button class="btn btn-primary" onclick="doFullRelease('major')">一键发布主版本</button>
          </div>
          <div style="margin-top: 8px;">
            <label style="font-size: 11px; color: var(--text-muted); display: flex; align-items: center; gap: 6px;">
              <input type="checkbox" id="full-release-build" checked> 构建安装包
            </label>
            <label style="font-size: 11px; color: var(--text-muted); display: flex; align-items: center; gap: 6px; margin-top: 4px;">
              <input type="checkbox" id="full-release-upload"> 上传安装包
            </label>
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
    <!-- Git 标签管理 -->
    <div class="card">
      <div class="card-title">Git 标签管理</div>
      <div class="action-group">
        <div class="action-group-label">创建版本标签 (git tag -a)</div>
        <div class="input-group">
          <input type="text" class="input" id="tag-version" placeholder="版本号, 例如: 5.4.0">
          <input type="text" class="input tag-message-input" id="tag-message" placeholder="标签信息 (可选)">
          <button class="btn btn-primary" onclick="doTagCreate()">创建标签</button>
        </div>
      </div>
    </div>

    <!-- 构建与 GitHub Release 上传 -->
    <div class="card">
      <div class="card-title">构建与 GitHub Release 上传</div>
      <div class="action-group">
        <div class="action-group-label">构建安装包 (npm run build:win)</div>
        <button class="btn btn-primary" onclick="doBuild()" id="btn-build">开始构建</button>
      </div>
      <div class="artifact-list" id="artifact-list" style="display:none;"></div>
      <div class="action-group" style="margin-top: 14px;">
        <div class="action-group-label">GitHub 配置</div>
        <input type="password" class="input" id="github-token" placeholder="GitHub Personal Access Token (需要 repo 权限)" style="margin-bottom: 8px;">
        <div class="input-group">
          <input type="text" class="input" id="github-owner" placeholder="仓库 Owner">
          <input type="text" class="input" id="github-repo" placeholder="仓库名">
          <button class="btn" onclick="loadGitHubConfig()">自动获取</button>
        </div>
      </div>
      <div class="action-group" style="margin-top: 14px;">
        <div class="action-group-label">创建 GitHub Release</div>
        <div class="input-group">
          <input type="text" class="input" id="release-tag" placeholder="标签名, 例如: v5.4.0">
          <input type="text" class="input" id="release-name" placeholder="Release 名称 (可选)">
          <button class="btn btn-primary" onclick="doCreateRelease()">创建 Release</button>
        </div>
        <textarea class="input" id="release-body" placeholder="Release 说明 (可选, 支持 Markdown)" style="margin-top: 8px; min-height: 60px; resize: vertical; font-family: inherit;"></textarea>
        <div style="margin-top: 8px; display: flex; gap: 16px;">
          <label style="font-size: 12px; color: var(--text-secondary); display: flex; align-items: center; gap: 4px;">
            <input type="checkbox" id="release-prerelease"> 预发布
          </label>
          <label style="font-size: 12px; color: var(--text-secondary); display: flex; align-items: center; gap: 4px;">
            <input type="checkbox" id="release-draft"> 草稿
          </label>
        </div>
      </div>
      <div id="release-info" style="display:none; margin-top: 14px; padding: 10px; background: var(--accent-ghost); border-radius: var(--radius-sm); font-size: 12px;">
      </div>
      <div id="upload-progress-container" style="display:none; margin-top: 14px;">
        <div class="progress-bar-container">
          <div class="progress-bar-fill" id="upload-progress-fill" style="width: 0%;"></div>
          <span class="progress-bar-text" id="upload-progress-text">0%</span>
        </div>
        <div class="upload-status" id="upload-status"></div>
      </div>
    </div>
  </div>

  <div class="grid">
    <!-- 提交管理 -->
    <div class="card">
      <div class="card-title">提交管理</div>
      <div class="action-group">
        <div class="action-group-label">提交信息</div>
        <input type="text" class="input" id="commit-message" placeholder="例如: release: v5.4.0" style="margin-bottom: 12px;">
      </div>
      <div class="action-group">
        <div class="action-group-label">变更日志内容 (自动更新 CHANGELOG.md)</div>
        <textarea class="changelog-cat-input" id="cl-content" placeholder="输入所有提交信息，将合并为一个完整整体写入 CHANGELOG.md&#10;支持多行，保持原始内容的完整性和逻辑连贯性" style="min-height: 120px;"></textarea>
        <div class="changelog-hint">所有内容将合并为一个完整整体写入 CHANGELOG，不分类不分组。</div>
      </div>
      <button class="btn btn-primary" onclick="doCommit()" style="margin-top: 12px;">提交并更新日志</button>
    </div>

    <!-- 仓库状态对比 -->
    <div class="card">
      <div class="card-title">仓库状态对比 (本地 ↔ 远程)</div>
      <div id="repo-diff-container">
        <div style="color: var(--text-dim); text-align: center; padding: 20px;">点击下方按钮获取状态</div>
      </div>
      <button class="btn" onclick="loadRepoDiff()" style="margin-top: 12px;">刷新仓库状态</button>
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
  tagCreate: (version, message) => fetch('/api/tag/create', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({version, message}) }).then(r => r.json()),
  build: () => fetch('/api/build', { method: 'POST' }).then(r => r.json()),
  uploadStart: (artifactPath, github) => fetch('/api/upload/start', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({artifactPath, github}) }).then(r => r.json()),
  githubConfig: () => fetch('/api/github/config').then(r => r.json()),
  githubReleaseCreate: (token, owner, repo, tagName, releaseName, body, prerelease, draft) => fetch('/api/github/release/create', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({token, owner, repo, tagName, releaseName, body, prerelease, draft}) }).then(r => r.json()),
  commit: (message, changelogContent, version) => fetch('/api/commit', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({message, changelogContent, version}) }).then(r => r.json()),
  repoDiff: () => fetch('/api/repo/diff').then(r => r.json()),
  fullRelease: (type, options) => fetch('/api/release/full', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({type, ...options}) }).then(r => r.json()),
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
    '递增类型: <code>' + versionTypeLabel(type) + '版本</code><br><br>' +
    '此操作将同步修改所有版本文件。',
    null,
    '执行递增',
    async () => {
      setButtonsDisabled(true);
      showSpinner('递增' + versionTypeLabel(type) + '版本...');
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
  const label = type ? versionTypeLabel(type) + '版本' : '交互式';
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

function versionTypeLabel(type) {
  const labels = { patch: '补丁', minor: '次版本', major: '主版本' };
  return labels[type] || type;
}

// Git 标签创建
async function doTagCreate() {
  const version = document.getElementById('tag-version').value.trim();
  const message = document.getElementById('tag-message').value.trim();
  if (!version) { showToast('请输入版本号', 'error'); return; }
  const current = currentState ? currentState.currentVersion : '';
  showModal(
    '确认创建 Git 标签',
    '即将执行 <code>git tag -a v' + version + '</code><br><br>' +
    '当前版本: <code>' + current + '</code><br>' +
    '标签版本: <code>v' + version + '</code><br>' +
    '标签信息: <code>' + (message || 'Release v' + version) + '</code>',
    null, '创建标签',
    async () => {
      setButtonsDisabled(true);
      showSpinner('创建 Git 标签 v' + version + '...');
      log('执行: git tag -a v' + version, 'info');
      try {
        const result = await API.tagCreate(version, message);
        log(result.output || result.error, result.exitCode === 0 ? 'success' : 'error');
        if (result.exitCode === 0) {
          showToast('标签 v' + version + ' 已创建', 'success');
          document.getElementById('tag-version').value = '';
          document.getElementById('tag-message').value = '';
        } else {
          showToast('创建标签失败', 'error');
        }
        await loadState();
      } catch (e) {
        log('创建标签失败: ' + e.message, 'error');
        showToast('创建标签失败', 'error');
      } finally {
        hideSpinner(); setButtonsDisabled(false);
      }
    }
  );
}

// 构建
async function doBuild() {
  showModal(
    '确认构建',
    '即将执行 <code>npm run build:win</code><br><br>' +
    '构建目录: <code>app/gui-js</code><br>' +
    '产物目录: <code>app/gui-js/dist</code><br><br>' +
    '构建可能需要数分钟，请耐心等待。',
    null, '开始构建',
    async () => {
      setButtonsDisabled(true);
      showSpinner('构建安装包中... (可能需要数分钟)');
      log('执行: npm run build:win', 'info');
      try {
        const result = await API.build();
        log('构建' + (result.exitCode === 0 ? '成功' : '失败'), result.exitCode === 0 ? 'success' : 'error');
        if (result.stdout) log(result.stdout.slice(-500), 'info');
        if (result.stderr) log(result.stderr.slice(-500), 'error');
        if (result.exitCode === 0) {
          showToast('构建完成，共 ' + result.artifacts.length + ' 个产物', 'success');
          renderArtifacts(result.artifacts);
        } else {
          showToast('构建失败', 'error');
        }
      } catch (e) {
        log('构建失败: ' + e.message, 'error');
        showToast('构建失败', 'error');
      } finally {
        hideSpinner(); setButtonsDisabled(false);
      }
    }
  );
}

function renderArtifacts(artifacts) {
  const el = document.getElementById('artifact-list');
  if (!artifacts || artifacts.length === 0) {
    el.style.display = 'none';
    return;
  }
  el.style.display = 'flex';
  el.innerHTML = artifacts.map(a => {
    const sizeMB = (a.size / 1024 / 1024).toFixed(2);
    return '<div class="artifact-item">' +
      '<div>' +
        '<span class="artifact-name">' + escapeHtml(a.name) + '</span>' +
        ' <span class="artifact-size">' + sizeMB + ' MB</span>' +
      '</div>' +
      '<button class="btn artifact-upload-btn" onclick="uploadArtifact(\\'' + escapeHtml(a.path) + '\\', \\'' + escapeHtml(a.name) + '\\')">上传到 Release</button>' +
    '</div>';
  }).join('');
}

function uploadArtifact(artifactPath, artifactName) {
  doUpload(artifactPath, artifactName);
}

function getGitHubConfig() {
  return {
    token: document.getElementById('github-token').value.trim(),
    owner: document.getElementById('github-owner').value.trim(),
    repo: document.getElementById('github-repo').value.trim(),
    releaseId: window.currentReleaseId || null,
  };
}

async function loadGitHubConfig() {
  try {
    const config = await API.githubConfig();
    if (config.hasRemote) {
      document.getElementById('github-owner').value = config.owner;
      document.getElementById('github-repo').value = config.repo;
      showToast('已从 Git Remote 获取: ' + config.owner + '/' + config.repo, 'success');
    } else {
      showToast('未检测到 GitHub 远程仓库', 'error');
    }
  } catch (e) {
    showToast('获取失败: ' + e.message, 'error');
  }
}

async function doCreateRelease() {
  const token = document.getElementById('github-token').value.trim();
  const owner = document.getElementById('github-owner').value.trim();
  const repo = document.getElementById('github-repo').value.trim();
  const tagName = document.getElementById('release-tag').value.trim();
  const releaseName = document.getElementById('release-name').value.trim();
  const body = document.getElementById('release-body').value.trim();
  const prerelease = document.getElementById('release-prerelease').checked;
  const draft = document.getElementById('release-draft').checked;
  if (!token) { showToast('请输入 GitHub Token', 'error'); return; }
  if (!owner || !repo) { showToast('请输入仓库 Owner 和名称', 'error'); return; }
  if (!tagName) { showToast('请输入标签名', 'error'); return; }
  setButtonsDisabled(true);
  showSpinner('创建 GitHub Release...');
  log('创建 GitHub Release: ' + owner + '/' + repo + ' tag=' + tagName, 'info');
  try {
    const result = await API.githubReleaseCreate(token, owner, repo, tagName, releaseName, body, prerelease, draft);
    if (result.exitCode === 0) {
      window.currentReleaseId = result.releaseId;
      log('GitHub Release 已创建: ' + (result.htmlUrl || ''), 'success');
      showToast('Release 已创建', 'success');
      const infoEl = document.getElementById('release-info');
      infoEl.style.display = 'block';
      infoEl.innerHTML = '✓ Release ID: ' + result.releaseId + '<br>✓ 链接: <a href="' + result.htmlUrl + '" target="_blank" style="color: var(--accent);">' + result.htmlUrl + '</a><br>现在可以上传安装包到此 Release';
    } else {
      log('创建 Release 失败: ' + (result.error || ''), 'error');
      showToast('创建 Release 失败', 'error');
    }
  } catch (e) {
    log('创建 Release 失败: ' + e.message, 'error');
    showToast('创建 Release 失败', 'error');
  } finally {
    hideSpinner(); setButtonsDisabled(false);
  }
}

async function doUpload(artifactPath, artifactName) {
  if (!artifactPath) { showToast('请先构建以获取安装包', 'error'); return; }
  const github = getGitHubConfig();
  if (!github.token) { showToast('请输入 GitHub Token', 'error'); return; }
  if (!github.owner || !github.repo) { showToast('请输入仓库 Owner 和名称', 'error'); return; }
  if (!github.releaseId) { showToast('请先创建 GitHub Release', 'error'); return; }
  setButtonsDisabled(true);
  log('开始上传到 GitHub Release: ' + (artifactName || artifactPath), 'info');
  try {
    const startResult = await API.uploadStart(artifactPath, github);
    if (startResult.exitCode !== 0) {
      log('上传启动失败: ' + (startResult.error || ''), 'error');
      showToast('上传启动失败', 'error');
      setButtonsDisabled(false);
      return;
    }
    log('上传已启动, ID: ' + startResult.uploadId, 'info');
    const container = document.getElementById('upload-progress-container');
    const fill = document.getElementById('upload-progress-fill');
    const text = document.getElementById('upload-progress-text');
    const status = document.getElementById('upload-status');
    container.style.display = 'block';
    fill.style.width = '0%';
    text.textContent = '0%';
    status.className = 'upload-status';
    status.textContent = '上传中: ' + startResult.fileName + ' (' + (startResult.fileSize / 1024 / 1024).toFixed(2) + ' MB)';
    const evtSource = new EventSource('/api/upload/progress?id=' + startResult.uploadId);
    evtSource.onmessage = function(event) {
      const data = JSON.parse(event.data);
      if (data.error) {
        status.className = 'upload-status error';
        status.textContent = '错误: ' + data.error;
        evtSource.close();
        setButtonsDisabled(false);
        return;
      }
      fill.style.width = data.progress + '%';
      text.textContent = data.progress + '%';
      if (data.status === 'completed') {
        status.className = 'upload-status success';
        status.textContent = '✓ 上传完成: ' + data.fileName;
        log('上传完成: ' + data.fileName, 'success');
        showToast('上传完成', 'success');
        evtSource.close();
        setButtonsDisabled(false);
      } else if (data.status === 'failed') {
        status.className = 'upload-status error';
        status.textContent = '✗ 上传失败: ' + (data.error || '未知错误');
        log('上传失败: ' + (data.error || ''), 'error');
        showToast('上传失败', 'error');
        evtSource.close();
        setButtonsDisabled(false);
      }
    };
    evtSource.onerror = function() {
      status.className = 'upload-status error';
      status.textContent = '连接中断';
      evtSource.close();
      setButtonsDisabled(false);
    };
  } catch (e) {
    log('上传失败: ' + e.message, 'error');
    showToast('上传失败', 'error');
    setButtonsDisabled(false);
  }
}

// 提交管理
async function doCommit() {
  const message = document.getElementById('commit-message').value.trim();
  if (!message) { showToast('请输入提交信息', 'error'); return; }
  const changelogContent = document.getElementById('cl-content').value.trim();
  const hasChangelog = changelogContent.length > 0;
  const version = currentState ? currentState.currentVersion : '';
  let body = '即将执行:<br>' +
    '<code>git add -A && git commit -m "' + escapeHtml(message) + '"</code><br><br>';
  if (hasChangelog) {
    body += '将自动更新 <code>CHANGELOG.md</code>，新增 <code>v' + version + '</code> 版本条目<br>';
    body += '合并内容预览 (' + changelogContent.length + ' 字符):<br>';
    body += '<div style="margin-top: 6px; padding: 8px; background: var(--bg-elevated); border-radius: 4px; max-height: 120px; overflow-y: auto; font-size: 11px; white-space: pre-wrap;">' + escapeHtml(changelogContent.slice(0, 500)) + (changelogContent.length > 500 ? '\\n...' : '') + '</div>';
  }
  showModal('确认提交', body, null, '执行提交', async () => {
    setButtonsDisabled(true);
    showSpinner('提交代码...');
    log('执行: git commit -m "' + message + '"', 'info');
    try {
      const result = await API.commit(message, hasChangelog ? changelogContent : null, version);
      if (result.changelog) {
        if (result.changelog.success) {
          log('CHANGELOG.md 已更新 (v' + result.changelog.version + ')', 'success');
        } else {
          log('CHANGELOG 更新失败: ' + result.changelog.error, 'error');
        }
      }
      if (result.commit) {
        log(result.commit.output || result.commit.error, result.commit.exitCode === 0 ? 'success' : 'error');
        if (result.commit.exitCode === 0) {
          showToast('提交成功', 'success');
          document.getElementById('commit-message').value = '';
          document.getElementById('cl-content').value = '';
        } else {
          showToast('提交失败', 'error');
        }
      }
      await loadState();
    } catch (e) {
      log('提交失败: ' + e.message, 'error');
      showToast('提交失败', 'error');
    } finally {
      hideSpinner(); setButtonsDisabled(false);
    }
  });
}

// 仓库状态对比
async function loadRepoDiff() {
  const container = document.getElementById('repo-diff-container');
  container.innerHTML = '<div style="color: var(--text-dim); text-align: center; padding: 20px;"><div class="loading" style="margin: 0 auto;"></div><div style="margin-top: 8px;">获取仓库状态中...</div></div>';
  try {
    const diff = await API.repoDiff();
    renderRepoDiff(diff);
  } catch (e) {
    container.innerHTML = '<div style="color: var(--danger); text-align: center; padding: 20px;">获取失败: ' + escapeHtml(e.message) + '</div>';
  }
}

function renderRepoDiff(diff) {
  const container = document.getElementById('repo-diff-container');
  if (!diff.isRepo) {
    container.innerHTML = '<div class="git-status not-repo">⚠ 非 Git 仓库</div>';
    return;
  }
  let html = '';
  // 分支信息
  html += '<div class="repo-branch-info">';
  html += '<span class="repo-branch-name">' + escapeHtml(diff.branch || 'HEAD') + '</span>';
  if (diff.remote) {
    html += '<span class="repo-arrow">↔</span>';
    html += '<span class="repo-remote-name">' + escapeHtml(diff.remote) + '/' + escapeHtml(diff.branch || '') + '</span>';
  } else {
    html += '<span class="repo-arrow">—</span>';
    html += '<span class="repo-remote-name">无远程仓库</span>';
  }
  html += '</div>';

  if (diff.fetchError) {
    html += '<div class="git-status dirty" style="margin-bottom: 12px;">⚠ Fetch 失败: ' + escapeHtml(diff.fetchError) + '</div>';
  }

  // 统计
  html += '<div class="repo-diff-stats">';
  html += '<div class="repo-diff-stat"><div class="repo-diff-stat-value ahead">' + diff.ahead + '</div><div class="repo-diff-stat-label">领先远程</div></div>';
  html += '<div class="repo-diff-stat"><div class="repo-diff-stat-value behind">' + diff.behind + '</div><div class="repo-diff-stat-label">落后远程</div></div>';
  html += '<div class="repo-diff-stat"><div class="repo-diff-stat-value clean">' + diff.localChanges.length + '</div><div class="repo-diff-stat-label">本地变更</div></div>';
  html += '</div>';

  // 领先的提交
  if (diff.aheadCommits && diff.aheadCommits.length > 0) {
    html += '<div class="repo-diff-section">';
    html += '<div class="repo-diff-title">本地领先提交 (↑ ' + diff.aheadCommits.length + ')</div>';
    html += '<div class="repo-commit-list">';
    for (const c of diff.aheadCommits) {
      html += '<div class="repo-commit-item"><span class="repo-commit-hash">' + escapeHtml(c.hash.slice(0, 7)) + '</span><span class="repo-commit-msg">' + escapeHtml(c.message) + '</span></div>';
    }
    html += '</div></div>';
  }

  // 落后的提交
  if (diff.behindCommits && diff.behindCommits.length > 0) {
    html += '<div class="repo-diff-section">';
    html += '<div class="repo-diff-title">远程新提交 (↓ ' + diff.behindCommits.length + ')</div>';
    html += '<div class="repo-commit-list">';
    for (const c of diff.behindCommits) {
      html += '<div class="repo-commit-item"><span class="repo-commit-hash">' + escapeHtml(c.hash.slice(0, 7)) + '</span><span class="repo-commit-msg">' + escapeHtml(c.message) + '</span></div>';
    }
    html += '</div></div>';
  }

  // 本地文件变更
  if (diff.localChanges && diff.localChanges.length > 0) {
    html += '<div class="repo-diff-section">';
    html += '<div class="repo-diff-title">工作区文件变更 (' + diff.localChanges.length + ')</div>';
    html += '<div class="repo-file-list">';
    for (const f of diff.localChanges) {
      const st = f.status.trim();
      let cls = 'modified', label = 'M';
      if (st === '??') { cls = 'untracked'; label = '?'; }
      else if (st.includes('A') || st === 'A') { cls = 'added'; label = 'A'; }
      else if (st.includes('D') || st === 'D') { cls = 'deleted'; label = 'D'; }
      html += '<div class="repo-file-item"><span class="repo-file-status ' + cls + '">' + label + '</span><span class="repo-file-name">' + escapeHtml(f.file) + '</span></div>';
    }
    html += '</div></div>';
  }

  if (diff.ahead === 0 && diff.behind === 0 && diff.localChanges.length === 0) {
    html += '<div class="git-status clean" style="margin-top: 12px;">✓ 本地与远程同步，工作区干净</div>';
  }

  container.innerHTML = html;
}

// 完整发布流程
async function doFullRelease(type) {
  const label = versionTypeLabel(type);
  const current = currentState ? currentState.currentVersion : '当前版本';
  const build = document.getElementById('full-release-build').checked;
  const upload = document.getElementById('full-release-upload').checked;
  const githubToken = document.getElementById('github-token').value.trim();
  const githubOwner = document.getElementById('github-owner').value.trim();
  const githubRepo = document.getElementById('github-repo').value.trim();

  // 收集 changelog 内容（合并为完整整体）
  const changelogContent = document.getElementById('cl-content').value.trim();

  let steps = '1. 版本一致性检查<br>2. 递增' + label + '版本<br>3. 更新 CHANGELOG.md<br>4. Git 提交<br>5. 创建 Git 标签';
  if (build) steps += '<br>6. 构建安装包';
  if (upload) steps += '<br>7. 创建 GitHub Release 并上传安装包';

  showModal(
    '确认一键发布 (' + label + '版本)',
    '即将执行完整发布流程:<br><br>' +
    '当前版本: <code>' + current + '</code><br>' +
    '发布类型: <code>' + label + '版本</code><br><br>' +
    steps + '<br><br>' +
    (build ? '⚠ 构建可能需要数分钟<br>' : '') +
    (upload && (!githubToken || !githubOwner || !githubRepo) ? '⚠ 未配置 GitHub Token/Owner/Repo，上传将失败<br>' : ''),
    null, '执行发布',
    async () => {
      setButtonsDisabled(true);
      showSpinner('执行一键发布 (' + label + ')...');
      log('执行完整发布流程: ' + label, 'info');
      try {
        const result = await API.fullRelease(type, {
          build: build,
          upload: upload,
          githubToken: githubToken,
          githubOwner: githubOwner,
          githubRepo: githubRepo,
          changelogContent: changelogContent.length > 0 ? changelogContent : null,
          commitMessage: 'release: v' + (type ? '' : current),
        });
        // 渲染步骤结果
        if (result.steps) {
          for (const s of result.steps) {
            const icon = s.exitCode === 0 ? '✓' : '✗';
            log(icon + ' [' + (s.name || s.step) + '] ' + (s.output || '').slice(0, 200), s.exitCode === 0 ? 'success' : 'error');
          }
        }
        if (result.error) {
          log('发布中断: ' + result.error, 'error');
          showToast('发布中断: ' + result.error, 'error');
        } else if (result.newVersion) {
          log('发布完成: ' + result.currentVersion + ' → ' + result.newVersion, 'success');
          showToast('发布完成: v' + result.newVersion, 'success');
          // 如果有上传步骤，显示进度
          const uploadStep = result.steps.find(s => s.step === 'upload');
          if (uploadStep && uploadStep.uploadId) {
            monitorUpload(uploadStep.uploadId);
          }
          // 如果有构建产物
          const buildStep = result.steps.find(s => s.step === 'build');
          if (buildStep && buildStep.artifacts) {
            renderArtifacts(buildStep.artifacts);
          }
        }
        await loadState();
      } catch (e) {
        log('发布失败: ' + e.message, 'error');
        showToast('发布失败', 'error');
      } finally {
        hideSpinner(); setButtonsDisabled(false);
      }
    }
  );
}

function monitorUpload(uploadId) {
  const container = document.getElementById('upload-progress-container');
  const fill = document.getElementById('upload-progress-fill');
  const text = document.getElementById('upload-progress-text');
  const status = document.getElementById('upload-status');
  container.style.display = 'block';
  fill.style.width = '0%';
  text.textContent = '0%';
  status.className = 'upload-status';
  status.textContent = '上传中...';
  const evtSource = new EventSource('/api/upload/progress?id=' + uploadId);
  evtSource.onmessage = function(event) {
    const data = JSON.parse(event.data);
    if (data.error) {
      status.className = 'upload-status error';
      status.textContent = '错误: ' + data.error;
      evtSource.close();
      return;
    }
    fill.style.width = data.progress + '%';
    text.textContent = data.progress + '%';
    if (data.status === 'completed') {
      status.className = 'upload-status success';
      status.textContent = '✓ 上传完成: ' + data.fileName;
      log('上传完成: ' + data.fileName, 'success');
      showToast('上传完成', 'success');
      evtSource.close();
    } else if (data.status === 'failed') {
      status.className = 'upload-status error';
      status.textContent = '✗ 上传失败: ' + (data.error || '');
      log('上传失败: ' + (data.error || ''), 'error');
      evtSource.close();
    }
  };
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

  // SSE 上传进度
  if (pathname === '/api/upload/progress' && req.method === 'GET') {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const uploadId = parsedUrl.searchParams.get('id');
    if (!uploadId) {
      sendJson(res, 400, { error: 'Missing upload id' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const sendProgress = () => {
      const progress = handleUploadProgress(uploadId);
      if (!progress) {
        res.write('data: ' + JSON.stringify({ error: 'Upload session not found' }) + '\n\n');
        res.end();
        return;
      }
      res.write('data: ' + JSON.stringify(progress) + '\n\n');
      if (progress.status === 'completed' || progress.status === 'failed') {
        res.end();
      }
    };
    const interval = setInterval(sendProgress, 300);
    sendProgress();
    req.on('close', () => { clearInterval(interval); });
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
