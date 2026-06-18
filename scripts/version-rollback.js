#!/usr/bin/env node
/**
 * version-rollback.js - 版本回滚工具
 *
 * 用法:
 *   node scripts/version-rollback.js --to <version>            # 回滚到指定版本
 *   node scripts/version-rollback.js --to <version> --dry-run  # 预览不执行
 *   node scripts/version-rollback.js --list                    # 列出可回滚的版本标签
 *
 * 适用场景：已打本地标签但尚未 push 的发布，需要撤销并回退版本号。
 *
 * 安全约束：
 *   1. 目标版本必须存在对应的 Git 标签（即确实发布过）。
 *   2. 当前最新标签若已 push 到远程，则拒绝回滚（会破坏下游依赖），
 *      应改为发布新的回滚版本（见 docs/RELEASE.md 6.2 节）。
 *   3. 执行前强制二次确认，--dry-run 仅预览。
 *
 * 详细说明见 docs/RELEASE.md「版本回滚机制」。
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const PROJECT_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd) {
  try {
    return execSync(cmd, { cwd: PROJECT_ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    // 捕获 stdout（命令失败但仍输出内容时，如 git 在非标签场景），忽略 stderr
    return e.stdout ? String(e.stdout).trim() : null;
  }
}

function runInherit(cmd) {
  execSync(cmd, { cwd: PROJECT_ROOT, stdio: 'inherit' });
}

function gitIsRepo() {
  return run('git rev-parse --is-inside-work-tree') === 'true';
}

function localTags() {
  const out = run('git tag --list "v*"');
  if (!out) return [];
  return out.split('\n').filter(Boolean).sort();
}

function remoteTags() {
  const remote = run('git ls-remote --tags origin "v*" 2>/dev/null');
  if (!remote) return [];
  const tags = new Set();
  for (const line of remote.split('\n')) {
    const m = line.match(/refs\/tags\/(v[0-9][^\^{}]*)$/);
    if (m) tags.add(m[1]);
  }
  return Array.from(tags);
}

function currentVersion() {
  const pkgPath = path.join(PROJECT_ROOT, 'app', 'gui-js', 'package.json');
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function listVersions() {
  console.log('\n  Rollback candidate versions (local Git tags):\n');
  const tags = localTags();
  if (tags.length === 0) {
    console.log('  (no version tags found)');
    console.log('\n  Run a release first: npm run release\n');
    return;
  }
  const remotes = new Set(remoteTags());
  for (const t of [...tags].reverse()) {
    const pushed = remotes.has(t);
    const flag = pushed ? '  [PUSHED - cannot rollback]' : '  [local only - rollbackable]';
    console.log(`    ${t.padEnd(14)}${flag}`);
  }
  const cur = currentVersion();
  console.log(`\n  Current package.json version: ${cur}`);
  console.log('\n  Note: only local (un-pushed) tags can be safely rolled back.\n');
}

async function rollback(toVersion, dryRun) {
  if (!gitIsRepo()) {
    console.error('Error: not a git repository.');
    process.exit(1);
  }

  const targetTag = toVersion.startsWith('v') ? toVersion : `v${toVersion}`;
  const current = currentVersion();
  const currentTag = `v${current}`;

  console.log(`\n  Rollback: ${currentTag}  →  ${targetTag}\n`);

  // 校验 1：目标标签存在
  if (!localTags().includes(targetTag)) {
    console.error(`  ✗ Target tag ${targetTag} does not exist locally.`);
    console.error('    Available tags: node scripts/version-rollback.js --list');
    process.exit(1);
  }

  // 校验 2：当前标签未 push（已 push 的标签不允许回滚）
  const remotes = new Set(remoteTags());
  if (remotes.has(currentTag)) {
    console.error(`  ✗ Current tag ${currentTag} has been pushed to remote.`);
    console.error('    Deleting a pushed tag breaks downstream dependents.');
    console.error('    Instead, publish a NEW rollback version (see docs/RELEASE.md §6.2):');
    console.error(`      npm run version:sync -- ${current}   # then revert the offending commit, bump, release`);
    process.exit(1);
  }

  const plan = [
    `1. Delete local tag ${currentTag}`,
    `2. Sync version fields back to ${toVersion} in all files (via version-sync.js)`,
    `3. (manual) git reset --hard HEAD~1  to drop the release commit`,
  ];
  console.log('  Plan:');
  for (const step of plan) console.log('    ' + step);
  console.log('');

  if (dryRun) {
    console.log('  [dry-run] No changes made.');
    return;
  }

  // 二次确认
  const answer = await prompt(`  Type the target version "${toVersion}" to confirm rollback: `);
  if (answer !== toVersion) {
    console.log('  Aborted: confirmation did not match.');
    process.exit(1);
  }

  console.log('\n  [1/3] Deleting local tag...');
  runInherit(`git tag -d ${currentTag}`);

  console.log('  [2/3] Syncing version fields back...');
  try {
    runInherit(`node "${path.join(__dirname, 'version-sync.js')}" ${toVersion}`);
  } catch (e) {
    console.error('  ✗ Version sync failed:', e.message);
    process.exit(1);
  }

  console.log('  [3/3] Done. Now manually drop the release commit:');
  console.log('    git reset --hard HEAD~1');
  console.log('');
  console.log(`  Rollback to ${toVersion} complete. Files are consistent; commit reset is manual.`);
  console.log('');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
  ContextGate Version Rollback Tool

  Usage:
    node scripts/version-rollback.js --to <version>            Roll back to <version>
    node scripts/version-rollback.js --to <version> --dry-run  Preview without executing
    node scripts/version-rollback.js --list                    List rollbackable version tags

  Safety:
    - Only local (un-pushed) tags can be rolled back.
    - Pushed tags require a NEW rollback version instead.

  See: docs/RELEASE.md §6 (Version Rollback)
`);
    process.exit(0);
  }

  if (args.includes('--list')) {
    listVersions();
    return;
  }

  const toIdx = args.indexOf('--to');
  if (toIdx === -1 || !args[toIdx + 1]) {
    console.error('Error: --to <version> is required');
    console.error('Usage: node scripts/version-rollback.js --to <version> [--dry-run]');
    process.exit(1);
  }
  const toVersion = args[toIdx + 1];
  const dryRun = args.includes('--dry-run');

  await rollback(toVersion, dryRun);
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
