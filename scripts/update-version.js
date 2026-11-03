const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');

const rawVersion = process.argv[2];
if (!rawVersion) {
  console.error('Usage: npm run update-version <new_version>');
  console.error('Example: npm run update-version 1.4.0');
  process.exit(1);
}

const cleanVersion = rawVersion.replace(/^v/i, '').trim();
if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(cleanVersion)) {
  console.error(`Invalid semver format: "${rawVersion}". Expected format: X.Y.Z (e.g., 1.4.0)`);
  process.exit(1);
}

console.log(`Updating project files to version v${cleanVersion}...`);

// 1. Update package.json
const pkgPath = path.join(rootDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const oldVersion = pkg.version;
pkg.version = cleanVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log(`Updated package.json: ${oldVersion} -> ${cleanVersion}`);

// 2. Update package-lock.json
const lockPath = path.join(rootDir, 'package-lock.json');
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.version = cleanVersion;
  if (lock.packages && lock.packages['']) {
    lock.packages[''].version = cleanVersion;
  }
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8');
  console.log(`Updated package-lock.json: ${oldVersion} -> ${cleanVersion}`);
}

// 3. Update README.md
const readmePath = path.join(rootDir, 'README.md');
if (fs.existsSync(readmePath)) {
  let readme = fs.readFileSync(readmePath, 'utf8');
  readme = readme.replace(new RegExp(`version-v${oldVersion.replace(/\./g, '\\.')}-blue\\.svg`, 'g'), `version-v${cleanVersion}-blue.svg`);
  readme = readme.replace(new RegExp(`v${oldVersion.replace(/\./g, '\\.')}(?!\\d)`, 'g'), `v${cleanVersion}`);

  // ★ プロジェクトごとに編集する箇所 (Edit per project) ★
  // <package-name> を実際の VSIX ファイル名プレフィックス（package.json の "name" フィールド等）に
  // 置き換えてください。例: <package-name> -> skillmap-solo / structmap-solo
  readme = readme.replace(new RegExp(`skillmap-solo-${oldVersion.replace(/\./g, '\\.')}\\.vsix`, 'g'), `skillmap-solo-${cleanVersion}.vsix`);

  fs.writeFileSync(readmePath, readme, 'utf8');
  console.log(`Updated README.md references to v${cleanVersion}`);
}

// 4. Update CHANGELOG.md
const changelogPath = path.join(rootDir, 'CHANGELOG.md');
if (fs.existsSync(changelogPath)) {
  let changelog = fs.readFileSync(changelogPath, 'utf8');
  const newHeader = `## [${cleanVersion}]`;
  if (!changelog.includes(newHeader)) {
    const today = new Date().toISOString().split('T')[0];
    const changelogEntry = `## [${cleanVersion}] - ${today}\n\n### 追加 (Added)\n- \n\n`;
    const insertPos = changelog.indexOf('## [');
    if (insertPos !== -1) {
      changelog = changelog.slice(0, insertPos) + changelogEntry + changelog.slice(insertPos);
    } else {
      changelog += `\n${changelogEntry}`;
    }
    fs.writeFileSync(changelogPath, changelog, 'utf8');
    console.log(`Added new release entry ${newHeader} - ${today} to CHANGELOG.md`);
  }
}

// 5. Run check-version.js to verify
console.log('\nRunning version consistency check...');
try {
  execSync('node scripts/check-version.js', { stdio: 'inherit' });
} catch (err) {
  console.error('Version consistency check failed after update!');
  process.exit(1);
}
