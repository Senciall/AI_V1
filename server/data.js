const fs = require('fs').promises;
const fsSync = require('fs');
const { CONFIG_FILE, LIFE_FILE, MANIFEST_FILE, DEFAULT_FILES_DIR } = require('./paths');

async function loadData() {
  try {
    return JSON.parse(await fs.readFile(CONFIG_FILE, 'utf-8'));
  } catch {
    return { config: { filesDir: DEFAULT_FILES_DIR }, settings: {} };
  }
}

async function saveData(data) {
  await fs.writeFile(CONFIG_FILE, JSON.stringify(data, null, 2));
}

function readLifeEntries() {
  try { return JSON.parse(fsSync.readFileSync(LIFE_FILE, 'utf-8')); }
  catch { return []; }
}

function writeLifeEntries(entries) {
  fsSync.writeFileSync(LIFE_FILE, JSON.stringify(entries, null, 2));
}

async function loadManifest() {
  try {
    return JSON.parse(await fs.readFile(MANIFEST_FILE, 'utf-8'));
  } catch {
    return { documents: [] };
  }
}

async function saveManifest(manifest) {
  await fs.writeFile(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
}

module.exports = { loadData, saveData, readLifeEntries, writeLifeEntries, loadManifest, saveManifest };
