const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const USER_DATA = path.join(ROOT, 'user_data');
const CHATS_DIR = path.join(USER_DATA, 'chats');
const DOCUMENTS_DIR = path.join(USER_DATA, 'documents');
const DOCS_PDFS = path.join(DOCUMENTS_DIR, 'pdfs');
const DOCS_IMAGES = path.join(DOCUMENTS_DIR, 'images');
const DOCS_SPREADSHEETS = path.join(DOCUMENTS_DIR, 'spreadsheets');
const DOCS_OTHER = path.join(DOCUMENTS_DIR, 'other');
const TEMP_DIR = path.join(USER_DATA, 'temp');
const CONFIG_FILE = path.join(USER_DATA, 'config.json');
const LIFE_FILE = path.join(USER_DATA, 'life-entries.json');
const MANIFEST_FILE = path.join(DOCUMENTS_DIR, 'manifest.json');
const DEFAULT_FILES_DIR = path.join(ROOT, 'user_data', 'files');

// Ensure all directories exist
for (const dir of [USER_DATA, CHATS_DIR, DOCUMENTS_DIR, DOCS_PDFS, DOCS_IMAGES, DOCS_SPREADSHEETS, DOCS_OTHER, TEMP_DIR, DEFAULT_FILES_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

module.exports = {
  ROOT,
  USER_DATA,
  CHATS_DIR,
  DOCUMENTS_DIR,
  DOCS_PDFS,
  DOCS_IMAGES,
  DOCS_SPREADSHEETS,
  DOCS_OTHER,
  TEMP_DIR,
  CONFIG_FILE,
  LIFE_FILE,
  MANIFEST_FILE,
  DEFAULT_FILES_DIR,
};
