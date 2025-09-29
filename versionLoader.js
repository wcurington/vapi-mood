// versionLoader.js
// Load latest versioned file based on version.json

const fs = require('fs');
const path = require('path');

function loadLatestVersion(moduleName) {
  const versionPath = path.join(__dirname, 'version.json');
  if (!fs.existsSync(versionPath)) {
    throw new Error(`version.json not found in project root`);
  }

  const versions = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
  const version = versions[moduleName];
  if (!version) {
    throw new Error(`No version entry found for module: ${moduleName}`);
  }

  const fileName = `${moduleName}_v${version}.js`;
  const filePath = path.join(__dirname, fileName);

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found for ${moduleName} at ${fileName}`);
  }

  console.log(`✨ VersionLoader: Using ${fileName} (v${version})`);

  return require(filePath);
}

module.exports = { loadLatestVersion };
