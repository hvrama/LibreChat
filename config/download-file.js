#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const mongoose = require('mongoose');
const { File } = require('@librechat/data-schemas').createModels(mongoose);
const { silentExit } = require('./helpers');
const connect = require('./connect');

const root = path.resolve(__dirname, '..');
const localRoots = {
  '/images/': path.join(root, 'client', 'public', 'images'),
  '/uploads/': path.join(root, 'uploads'),
};

const resolveLocalPath = (filepath) => {
  if (path.isAbsolute(filepath) && fs.existsSync(filepath)) {
    return filepath;
  }
  const prefix = Object.keys(localRoots).find((key) => filepath.startsWith(key));
  if (!prefix) {
    return null;
  }
  const candidate = path.join(localRoots[prefix], filepath.slice(prefix.length));
  return fs.existsSync(candidate) ? candidate : null;
};

const writeText = (file) => {
  const ext = file.textFormat === 'html' ? '.html' : '.txt';
  const target = path.join(process.cwd(), `${file.filename}${ext}`);
  fs.writeFileSync(target, file.text, 'utf8');
  return target;
};

const copyLocal = (file) => {
  const sourcePath = resolveLocalPath(file.filepath);
  if (!sourcePath) {
    return null;
  }
  const target = path.join(process.cwd(), file.filename);
  fs.copyFileSync(sourcePath, target);
  return target;
};

(async () => {
  const [fileId] = process.argv.slice(2);
  if (!fileId) {
    console.red('Usage: npm run download-file <file_id>');
    silentExit(1);
  }

  await connect();

  const file = await File.findOne({ file_id: fileId }).lean();
  if (!file) {
    console.red(`No file found with file_id "${fileId}"`);
    silentExit(1);
  }

  console.purple('--------------------------');
  console.purple(`Filename: ${file.filename}`);
  console.purple(`Type: ${file.type}`);
  console.purple(`Source: ${file.source}`);
  console.purple(`Filepath: ${file.filepath}`);
  console.purple(`Bytes: ${file.bytes}`);
  console.purple('--------------------------');

  const target = file.text ? writeText(file) : copyLocal(file);
  if (!target) {
    console.red(
      `File content is not stored in MongoDB and "${file.filepath}" was not found on local disk (source: ${file.source}).`,
    );
    silentExit(1);
  }

  console.green(`Saved to ${target}`);
  silentExit(0);
})();
