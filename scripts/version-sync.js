#!/usr/bin/env node

/**
 * ContextGate Version Sync Tool
 *
 * Synchronizes version numbers across project files with a single command.
 *
 * Usage:
 *   node scripts/version-sync.js <new-version>       # e.g. node scripts/version-sync.js 6.0.0
 *   node scripts/version-sync.js --check              # verify all files have consistent versions
 *   node scripts/version-sync.js --current            # print current version from package.json
 *   node scripts/version-sync.js --dry-run 6.0.0      # preview changes without writing
 *
 * Supported files:
 *   - app/gui-js/package.json       → "version" field
 *   - app/gui-js/package-lock.json  → "version" field (top-level name matches package)
 *   - app/gui-js/index.html         → <meta name="version"> tag
 *   - README.md                     → badge URL + changelog heading
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Configuration: version patterns per file
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, '..');

const FILE_CONFIGS = [
  {
    id: 'package.json',
    filePath: path.join(PROJECT_ROOT, 'app', 'gui-js', 'package.json'),
    type: 'json',
    // Replace the top-level "version" field
    replace: (content, newVersion) => {
      const json = JSON.parse(content);
      const oldVersion = json.version;
      json.version = newVersion;
      return { result: JSON.stringify(json, null, 2) + '\n', oldVersion };
    },
    extract: (content) => JSON.parse(content).version,
  },
  {
    id: 'package-lock.json',
    filePath: path.join(PROJECT_ROOT, 'app', 'gui-js', 'package-lock.json'),
    type: 'json',
    // Replace the top-level "version" field only (lockfileVersion stays untouched)
    replace: (content, newVersion) => {
      const json = JSON.parse(content);
      const oldVersion = json.version;
      json.version = newVersion;
      return { result: JSON.stringify(json, null, 2) + '\n', oldVersion };
    },
    extract: (content) => JSON.parse(content).version,
  },
  {
    id: 'index.html',
    filePath: path.join(PROJECT_ROOT, 'app', 'gui-js', 'index.html'),
    type: 'html',
    // Insert or update <meta name="version" content="x.y.z"> in <head>
    replace: (content, newVersion) => {
      const metaRegex = /<meta\s+name="version"\s+content="[^"]*"\s*\/?>/i;
      const metaTag = `<meta name="version" content="${newVersion}">`;

      let oldVersion = null;
      const match = content.match(metaRegex);
      if (match) {
        const contentMatch = match[0].match(/content="([^"]*)"/);
        if (contentMatch) oldVersion = contentMatch[1];
        const updated = content.replace(metaRegex, metaTag);
        return { result: updated, oldVersion };
      }

      // No existing meta tag — insert after <meta charset>
      const charsetRegex = /(<meta\s+charset="[^"]*"\s*>)/i;
      if (charsetRegex.test(content)) {
        const updated = content.replace(charsetRegex, `$1\n  ${metaTag}`);
        return { result: updated, oldVersion: null };
      }

      // Fallback: insert after <head>
      const headRegex = /(<head>)/i;
      if (headRegex.test(content)) {
        const updated = content.replace(headRegex, `$1\n  ${metaTag}`);
        return { result: updated, oldVersion: null };
      }

      return { result: content, oldVersion: null };
    },
    extract: (content) => {
      const match = content.match(/<meta\s+name="version"\s+content="([^"]*)"/i);
      return match ? match[1] : null;
    },
  },
  {
    id: 'README.md',
    filePath: path.join(PROJECT_ROOT, 'README.md'),
    type: 'markdown',
    // Update badge URL and the latest changelog heading
    replace: (content, newVersion) => {
      let oldVersion = null;
      let updated = content;

      // Badge: badge/version-X.Y.Z-blue
      const badgeRegex = /badge\/version-([0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.]+)?)-blue/;
      const badgeMatch = updated.match(badgeRegex);
      if (badgeMatch) {
        oldVersion = badgeMatch[1];
        updated = updated.replace(badgeRegex, `badge/version-${newVersion}-blue`);
      }

      // Changelog heading: ### vX.Y.Z
      const headingRegex = /### v([0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.]+)?)/;
      const headingMatch = updated.match(headingRegex);
      if (headingMatch && !oldVersion) {
        oldVersion = headingMatch[1];
      }
      updated = updated.replace(headingRegex, `### v${newVersion}`);

      return { result: updated, oldVersion };
    },
    extract: (content) => {
      const badgeMatch = content.match(/badge\/version-([0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.]+)?)-blue/);
      if (badgeMatch) return badgeMatch[1];
      const headingMatch = content.match(/### v([0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.]+)?)/);
      if (headingMatch) return headingMatch[1];
      return null;
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SEMVER_REGEX = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.]+)?$/;

function validateVersion(version) {
  if (!SEMVER_REGEX.test(version)) {
    throw new Error(
      `Invalid version "${version}". Expected semver format: MAJOR.MINOR.PATCH (e.g. 6.0.0, 1.2.3-beta.1)`
    );
  }
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`File not found: ${filePath}`);
    }
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      throw new Error(`Permission denied reading: ${filePath}`);
    }
    throw new Error(`Failed to read ${filePath}: ${err.message}`);
  }
}

function writeFileSafe(filePath, content) {
  try {
    fs.writeFileSync(filePath, content, 'utf8');
  } catch (err) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      throw new Error(`Permission denied writing: ${filePath}`);
    }
    throw new Error(`Failed to write ${filePath}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

function getCurrentVersion() {
  const pkgPath = path.join(PROJECT_ROOT, 'app', 'gui-js', 'package.json');
  const content = readFileSafe(pkgPath);
  return JSON.parse(content).version;
}

function checkVersions() {
  const results = [];
  let allConsistent = true;
  let referenceVersion = null;

  for (const cfg of FILE_CONFIGS) {
    try {
      const content = readFileSafe(cfg.filePath);
      const version = cfg.extract(content);
      if (referenceVersion === null && version !== null) {
        referenceVersion = version;
      }
      const consistent = version === referenceVersion;
      if (!consistent) allConsistent = false;
      results.push({ id: cfg.id, version, consistent, exists: true });
    } catch (err) {
      allConsistent = false;
      results.push({ id: cfg.id, version: null, consistent: false, exists: false, error: err.message });
    }
  }

  return { results, allConsistent, referenceVersion };
}

function syncVersion(newVersion, dryRun = false) {
  validateVersion(newVersion);

  const results = [];

  for (const cfg of FILE_CONFIGS) {
    try {
      const content = readFileSafe(cfg.filePath);
      const { result, oldVersion } = cfg.replace(content, newVersion);

      if (!dryRun) {
        writeFileSafe(cfg.filePath, result);
      }

      // Validate the write by reading back
      let verified = false;
      if (!dryRun) {
        const reRead = readFileSafe(cfg.filePath);
        const extracted = cfg.extract(reRead);
        verified = extracted === newVersion;
      } else {
        const extracted = cfg.extract(result);
        verified = extracted === newVersion;
      }

      results.push({
        id: cfg.id,
        oldVersion,
        newVersion,
        updated: oldVersion !== newVersion,
        verified,
        dryRun,
      });
    } catch (err) {
      results.push({
        id: cfg.id,
        oldVersion: null,
        newVersion,
        updated: false,
        verified: false,
        error: err.message,
        dryRun,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// CLI output formatting
// ---------------------------------------------------------------------------

function printCheckResult({ results, allConsistent, referenceVersion }) {
  console.log('\n  Version Consistency Check');
  console.log('  ─────────────────────────\n');

  for (const r of results) {
    const icon = r.consistent ? '✓' : '✗';
    const ver = r.version ?? '(not found)';
    const err = r.error ? `  ← ${r.error}` : '';
    console.log(`  ${icon}  ${r.id.padEnd(22)} ${ver}${err}`);
  }

  console.log();
  if (allConsistent) {
    console.log(`  All files are consistent at v${referenceVersion}\n`);
  } else {
    console.log('  Versions are INCONSISTENT — run sync to fix\n');
  }

  return allConsistent;
}

function printSyncResult(results) {
  console.log('\n  Version Sync Results');
  console.log('  ────────────────────\n');

  let hasErrors = false;

  for (const r of results) {
    if (r.error) {
      hasErrors = true;
      console.log(`  ✗  ${r.id.padEnd(22)} ERROR: ${r.error}`);
      continue;
    }

    const changed = r.updated ? '→' : '=';
    const verifyIcon = r.verified ? '✓' : '✗';
    const old = r.oldVersion ?? '(none)';
    const dryLabel = r.dryRun ? ' [dry-run]' : '';
    console.log(`  ${verifyIcon}  ${r.id.padEnd(22)} ${old} ${changed} ${r.newVersion}${dryLabel}`);

    if (!r.verified) {
      hasErrors = true;
      console.log(`     WARNING: post-write verification failed for ${r.id}`);
    }
  }

  console.log();
  if (hasErrors) {
    console.log('  Some operations failed — review errors above\n');
  } else if (results.every(r => !r.updated)) {
    console.log('  All files already at the target version\n');
  } else {
    console.log('  All files updated and verified successfully\n');
  }

  return !hasErrors;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`
  ContextGate Version Sync Tool

  Usage:
    node scripts/version-sync.js <version>        Sync all files to <version>
    node scripts/version-sync.js --check           Check version consistency
    node scripts/version-sync.js --current         Print current version
    node scripts/version-sync.js --dry-run <ver>   Preview changes without writing

  Examples:
    node scripts/version-sync.js 6.0.0
    node scripts/version-sync.js 5.3.0-beta.1
    node scripts/version-sync.js --check
    node scripts/version-sync.js --dry-run 7.0.0

  Files managed:
    ${FILE_CONFIGS.map(c => c.id).join('\n    ')}
`);
    process.exit(0);
  }

  const flag = args[0];

  if (flag === '--current') {
    try {
      console.log(getCurrentVersion());
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (flag === '--check') {
    try {
      const result = checkVersions();
      const ok = printCheckResult(result);
      process.exit(ok ? 0 : 1);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  const dryRun = flag === '--dry-run';
  const version = dryRun ? args[1] : flag;

  if (!version) {
    console.error('Error: version argument is required');
    process.exit(1);
  }

  try {
    const results = syncVersion(version, dryRun);
    const ok = printSyncResult(results);
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
