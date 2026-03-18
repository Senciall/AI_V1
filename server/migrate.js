/**
 * One-time migration: moves existing data from v2/ and root temp_uploads/
 * into the new user_data/ structure. Runs automatically on startup if needed.
 */
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const {
  ROOT, USER_DATA, CHATS_DIR, DOCUMENTS_DIR, TEMP_DIR,
  CONFIG_FILE, LIFE_FILE, MANIFEST_FILE,
  DOCS_PDFS, DOCS_IMAGES, DOCS_SPREADSHEETS, DOCS_OTHER,
} = require('./paths');

const CATEGORY_MAP = {
  '.pdf': 'pdfs',
  '.png': 'images', '.jpg': 'images', '.jpeg': 'images', '.gif': 'images',
  '.webp': 'images', '.svg': 'images', '.bmp': 'images',
  '.xlsx': 'spreadsheets', '.xls': 'spreadsheets', '.csv': 'spreadsheets',
};

const CATEGORY_DIRS = {
  pdfs: DOCS_PDFS,
  images: DOCS_IMAGES,
  spreadsheets: DOCS_SPREADSHEETS,
  other: DOCS_OTHER,
};

const MIME_MAP = {
  '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel', '.csv': 'text/csv',
  '.txt': 'text/plain', '.md': 'text/markdown',
};

// Strip timestamp suffix from filenames like "resume-1773439347797.pdf"
function recoverOriginalName(filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  // Match pattern: name-<13-digit-timestamp>
  const match = base.match(/^(.+)-(\d{13})$/);
  return match ? match[1] + ext : filename;
}

function generateId() {
  return `doc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

async function migrateChats() {
  // Migrate from v2/Chats/
  const v2Chats = path.join(ROOT, 'v2', 'Chats');
  if (!fs.existsSync(v2Chats)) return;

  const files = await fsp.readdir(v2Chats);
  let count = 0;
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const src = path.join(v2Chats, f);
    const dest = path.join(CHATS_DIR, f);
    if (!fs.existsSync(dest)) {
      await fsp.copyFile(src, dest);
      count++;
    }
  }
  if (count > 0) console.log(`  Migrated ${count} chats`);
}

async function migrateDocumentsFromDir(sourceDir, manifest) {
  if (!fs.existsSync(sourceDir)) return 0;

  const files = await fsp.readdir(sourceDir);
  let count = 0;

  for (const filename of files) {
    const src = path.join(sourceDir, filename);
    const stat = await fsp.stat(src);
    if (!stat.isFile()) continue;

    const ext = path.extname(filename).toLowerCase();
    const category = CATEGORY_MAP[ext] || 'other';
    const docId = generateId();
    const newFilename = `${docId}${ext}`;
    const destDir = CATEGORY_DIRS[category];
    const dest = path.join(destDir, newFilename);

    // Copy file to new location
    await fsp.copyFile(src, dest);

    // Try text extraction for PDFs and spreadsheets
    let hasText = false;
    try {
      if (ext === '.pdf') {
        const { PDFParse } = require('pdf-parse');
        const buf = await fsp.readFile(dest);
        const parser = new PDFParse({ data: buf });
        const pdf = await parser.getText();
        await parser.destroy();
        if (pdf.text && pdf.text.trim()) {
          await fsp.writeFile(path.join(destDir, `${docId}.txt`), pdf.text);
          hasText = true;
        }
      } else if (['.xlsx', '.xls', '.csv'].includes(ext)) {
        const XLSX = require('xlsx');
        const wb = XLSX.readFile(dest);
        let text = '';
        for (const sn of wb.SheetNames) {
          text += `--- Sheet: ${sn} ---\n` + XLSX.utils.sheet_to_csv(wb.Sheets[sn]) + '\n';
        }
        if (text.trim()) {
          await fsp.writeFile(path.join(destDir, `${docId}.txt`), text);
          hasText = true;
        }
      } else if (['.txt', '.md', '.json'].includes(ext)) {
        // Text files are their own text - just flag as having text
        hasText = true;
        await fsp.copyFile(dest, path.join(destDir, `${docId}.txt`));
      }
    } catch (err) {
      console.warn(`  Warning: text extraction failed for ${filename}: ${err.message}`);
    }

    manifest.documents.push({
      id: docId,
      originalName: recoverOriginalName(filename),
      filename: newFilename,
      category,
      mimeType: MIME_MAP[ext] || 'application/octet-stream',
      size: stat.size,
      uploadedAt: new Date(stat.mtime).toISOString(),
      hasText,
    });
    count++;

    // Small delay to generate unique IDs
    await new Promise(r => setTimeout(r, 2));
  }

  return count;
}

async function migrateConfig() {
  // Migrate v2/data.json -> user_data/config.json
  const v2Data = path.join(ROOT, 'v2', 'data.json');
  if (fs.existsSync(v2Data) && !fs.existsSync(CONFIG_FILE)) {
    await fsp.copyFile(v2Data, CONFIG_FILE);
    console.log('  Migrated config');
  }

  // Migrate v2/life-entries.json -> user_data/life-entries.json
  const v2Life = path.join(ROOT, 'v2', 'life-entries.json');
  if (fs.existsSync(v2Life) && !fs.existsSync(LIFE_FILE)) {
    await fsp.copyFile(v2Life, LIFE_FILE);
    console.log('  Migrated life entries');
  }
}

async function runMigration() {
  // Only run if manifest doesn't exist (first time)
  if (fs.existsSync(MANIFEST_FILE)) return;

  // Check if there's anything to migrate
  const v2Chats = path.join(ROOT, 'v2', 'Chats');
  const rootTemp = path.join(ROOT, 'temp_uploads');
  const v2Temp = path.join(ROOT, 'v2', 'temp_uploads');

  const hasV2 = fs.existsSync(v2Chats);
  const hasRootTemp = fs.existsSync(rootTemp);
  const hasV2Temp = fs.existsSync(v2Temp);

  if (!hasV2 && !hasRootTemp && !hasV2Temp) {
    // No migration needed, just create empty manifest
    await fsp.writeFile(MANIFEST_FILE, JSON.stringify({ documents: [] }, null, 2));
    return;
  }

  console.log('Running one-time data migration...');

  const manifest = { documents: [] };

  // 1. Migrate chats
  await migrateChats();

  // 2. Migrate documents from root temp_uploads/
  if (hasRootTemp) {
    const count = await migrateDocumentsFromDir(rootTemp, manifest);
    if (count > 0) console.log(`  Migrated ${count} documents from temp_uploads/`);
  }

  // 3. Migrate documents from v2/temp_uploads/
  if (hasV2Temp) {
    const count = await migrateDocumentsFromDir(v2Temp, manifest);
    if (count > 0) console.log(`  Migrated ${count} documents from v2/temp_uploads/`);
  }

  // 4. Migrate config
  await migrateConfig();

  // 5. Save manifest
  await fsp.writeFile(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
  console.log(`Migration complete: ${manifest.documents.length} documents indexed`);
}

// Run migration synchronously at require time (startup)
runMigration().catch(err => {
  console.error('Migration failed:', err.message);
  // Create empty manifest so we don't retry on every startup
  if (!fs.existsSync(MANIFEST_FILE)) {
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify({ documents: [] }, null, 2));
  }
});
