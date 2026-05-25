const fs = require('fs')
const crypto = require('crypto')
const path = require('path')

const CONTEXT_HASH_FILE = '.context_hash'

/**
 * @typedef {Object} ContextSignature
 * @property {string} mainHash - SHA1 hash of the main context file
 * @property {string} combinedHash - SHA1 hash of all referenced file hashes
 * @property {Object.<string, string>} fileHashes - Map of file paths to their hashes
 * @property {number} fileCount - Number of referenced files
 * @property {string[]} files - List of referenced file paths
 * @property {string} file - Path to the context file
 */

/**
 * Compute SHA1 hash of a file's contents.
 * @param {string} filePath - Absolute file path
 * @returns {string|null} Hex digest of the hash, or null on failure
 */
function computeFileHash(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    const content = fs.readFileSync(filePath)
    return crypto.createHash('sha1').update(content).digest('hex')
  } catch (e) {
    console.error(`Failed to compute file hash for ${filePath}:`, e)
    return null
  }
}

/**
 * Load a previously saved context hash from disk.
 * @param {string} contextDir - Directory containing the hash file
 * @returns {string|null} Saved hash string, or null if not found
 */
function loadSavedContextHash(contextDir) {
  const hashFile = path.join(contextDir, CONTEXT_HASH_FILE)
  try {
    if (fs.existsSync(hashFile)) {
      return fs.readFileSync(hashFile, 'utf8').trim()
    }
  } catch (e) {
    console.error('Failed to load context hash:', e)
  }
  return null
}

/**
 * Save a context hash to disk for later comparison.
 * @param {string} contextDir - Directory to save the hash file
 * @param {string} hash - Hash string to save
 */
function saveContextHash(contextDir, hash) {
  const hashFile = path.join(contextDir, CONTEXT_HASH_FILE)
  try {
    fs.writeFileSync(hashFile, hash, 'utf8')
  } catch (e) {
    console.error('Failed to save context hash:', e)
  }
}

/**
 * Compute a full context signature including main file hash and all referenced file hashes.
 * @param {string} contextFile - Path to the context file
 * @param {string|null} projectRoot - Project root directory for resolving relative paths
 * @returns {ContextSignature|null} Signature object, or null on failure
 */
function computeContextSignature(contextFile, projectRoot) {
  try {
    if (!fs.existsSync(contextFile)) return null
    const content = fs.readFileSync(contextFile, 'utf8')
    const mainHash = crypto.createHash('sha1').update(content).digest('hex')
    const files = []
    for (const line of content.split('\n')) {
      const fileMatch = line.match(/^# File: (.+)$/)
      if (fileMatch) {
        files.push(fileMatch[1])
      }
    }
    const fileHashes = {}
    for (const fileRelPath of files) {
      if (!projectRoot) continue
      const absPath = path.join(projectRoot, fileRelPath)
      const hash = computeFileHash(absPath)
      if (hash) {
        fileHashes[fileRelPath] = hash
      }
    }
    const combinedHash = crypto
      .createHash('sha1')
      .update(JSON.stringify(fileHashes))
      .digest('hex')
    return { mainHash, combinedHash, fileHashes, fileCount: files.length, files, file: contextFile }
  } catch (e) {
    console.error('Failed to compute context signature:', e)
    return null
  }
}

/**
 * Check if the context has changed since the last known signature.
 * @param {ContextSignature|null} currentSignature - Previously known signature
 * @param {string} contextFile - Path to the context file
 * @param {string|null} projectRoot - Project root directory
 * @returns {boolean} True if context has changed
 */
function checkContextChanged(currentSignature, contextFile, projectRoot) {
  const newSignature = computeContextSignature(contextFile, projectRoot)
  if (!newSignature) return false
  if (!currentSignature) return true
  return newSignature.combinedHash !== currentSignature.combinedHash ||
         newSignature.mainHash !== currentSignature.mainHash
}

/**
 * Get a hash string from a context signature.
 * @param {ContextSignature|null} signature - Context signature
 * @returns {string} Hash string, or 'none' if no signature
 */
function getContextHash(signature) {
  if (!signature) return 'none'
  return signature.combinedHash || signature.mainHash
}

module.exports = {
  computeFileHash,
  loadSavedContextHash,
  saveContextHash,
  computeContextSignature,
  checkContextChanged,
  getContextHash
}
