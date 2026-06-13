#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const GUIJS = path.join(ROOT, 'app', 'gui-js')

const PKG = path.join(GUIJS, 'package.json')
const LOCK = path.join(GUIJS, 'package-lock.json')
const README = path.join(ROOT, 'README.md')

function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')) }

function writeJSON(p, obj) {
  const orig = fs.readFileSync(p, 'utf8')
  const indent = orig.match(/^\s+/m)?.[0] || '  '
  fs.writeFileSync(p, JSON.stringify(obj, null, indent) + '\n', 'utf8')
}

function bumpVersion(current, type) {
  const [major, minor, patch] = current.split('.').map(Number)
  switch (type) {
    case 'major': return `${major + 1}.0.0`
    case 'minor': return `${major}.${minor + 1}.0`
    case 'patch': return `${major}.${minor}.${patch + 1}`
    default:
      if (/^\d+\.\d+\.\d+$/.test(type)) return type
      console.error(`Invalid version or bump type: ${type}`)
      console.error('Usage: node scripts/version.js <major|minor|patch|x.y.z>')
      process.exit(1)
  }
}

function updateFile(filePath, oldStr, newStr) {
  const content = fs.readFileSync(filePath, 'utf8')
  if (!content.includes(oldStr)) {
    console.error(`  SKIP ${path.relative(ROOT, filePath)}: "${oldStr}" not found`)
    return false
  }
  fs.writeFileSync(filePath, content.replace(oldStr, newStr), 'utf8')
  console.log(`  OK   ${path.relative(ROOT, filePath)}`)
  return true
}

// ── Main ──

const arg = process.argv[2]
if (!arg) {
  const pkg = readJSON(PKG)
  console.log(`Current version: ${pkg.version}`)
  console.log('Usage: node scripts/version.js <major|minor|patch|x.y.z>')
  console.log('  major  -> next major (1.2.3 -> 2.0.0)')
  console.log('  minor  -> next minor (1.2.3 -> 1.3.0)')
  console.log('  patch  -> next patch (1.2.3 -> 1.2.4)')
  console.log('  x.y.z  -> explicit version')
  process.exit(0)
}

const currentVersion = readJSON(PKG).version
const newVersion = bumpVersion(currentVersion, arg)

if (newVersion === currentVersion) {
  console.log(`Version is already ${currentVersion}, nothing to do.`)
  process.exit(0)
}

console.log(`\nBumping: ${currentVersion} -> ${newVersion}\n`)

// 1. package.json
const pkg = readJSON(PKG)
pkg.version = newVersion
writeJSON(PKG, pkg)
console.log(`  OK   ${path.relative(ROOT, PKG)}`)

// 2. package-lock.json (2 places)
const lock = readJSON(LOCK)
lock.version = newVersion
if (lock.packages?.['']) lock.packages[''].version = newVersion
writeJSON(LOCK, lock)
console.log(`  OK   ${path.relative(ROOT, LOCK)}`)

// 3. README.md badge
updateFile(README, `version-${currentVersion}-blue`, `version-${newVersion}-blue`)

// 4. README.md changelog header (if exists)
updateFile(README, `### v${currentVersion}`, `### v${newVersion}`)

console.log(`\nDone! Version: ${currentVersion} -> ${newVersion}`)
console.log('\nTo commit:')
console.log(`  git add package.json package-lock.json README.md`)
console.log(`  git commit -m "chore: bump version to ${newVersion}"`)
