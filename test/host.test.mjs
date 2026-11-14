import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, lstat, readFile, rm, stat, symlink, writeFile, link } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pipeline } from 'node:stream/promises';

const helper = new URL('../src/host.py', import.meta.url).pathname;

function run(args, input) {
  const child = spawn('python3', [helper, ...args], { stdio: ['pipe', 'ignore', 'pipe'] });
  const errors = [];
  child.stderr.on('data', (chunk) => errors.push(chunk));
  child.stdin.end(input);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(Buffer.concat(errors).toString())));
  });
}

async function pack(source, archive) {
  const child = spawn('python3', [helper, 'pack', source], { stdio: ['ignore', 'pipe', 'inherit'] });
  const ended = Promise.withResolvers();
  child.once('error', ended.reject);
  child.once('close', code => code === 0 ? ended.resolve() : ended.reject(new Error(`pack exited ${code}`)));
  await Promise.all([pipeline(child.stdout, createWriteStream(archive, { mode: 0o600 })), ended.promise]);
}

test('tree archive round-trip preserves hardlinks, executable modes, empty directories, and safe symlinks', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workssh-host-'));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  const archive = path.join(root, 'tree.tar');
  await mkdir(path.join(source, 'empty'), { recursive: true });
  await writeFile(path.join(source, 'run'), '#!/bin/sh\n', { mode: 0o755 });
  await link(path.join(source, 'run'), path.join(source, 'run-copy'));
  await symlink('run', path.join(source, 'run-link'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await pack(source, archive);
  await run(['unpack', destination], await readFile(archive));

  const original = await stat(path.join(destination, 'run'));
  const hardlink = await stat(path.join(destination, 'run-copy'));
  assert.equal(original.ino, hardlink.ino);
  assert.equal(original.mode & 0o111, 0o111);
  assert.equal((await stat(path.join(destination, 'empty'))).isDirectory(), true);
  assert.equal((await lstat(path.join(destination, 'run-link'))).isSymbolicLink(), true);
});

test('tree unpack rejects escaping links and does not publish partial output', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workssh-host-'));
  const archive = path.join(root, 'unsafe.tar');
  const destination = path.join(root, 'destination');
  t.after(() => rm(root, { recursive: true, force: true }));
  await new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', "import tarfile,sys; t=tarfile.open(sys.argv[1],'w'); m=tarfile.TarInfo('escape'); m.type=tarfile.SYMTYPE; m.linkname='../../outside'; t.addfile(m); t.close()", archive]);
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`fixture exited ${code}`)));
  });
  await assert.rejects(run(['unpack', destination], await readFile(archive)));
  await assert.rejects(stat(destination), { code: 'ENOENT' });
});

test('archive traversal, absolute paths, escaping hardlinks and special files never publish or alter outside files', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workssh-unsafe-tree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = path.join(root, 'outside');
  await writeFile(outside, 'outside guard');
  const cases = [
    { name: '../outside', type: 'file' },
    { name: outside, type: 'file' },
    { name: 'link', type: 'hardlink', target: '../outside' },
    { name: 'fifo', type: 'fifo' },
  ];
  for (const [index, entry] of cases.entries()) {
    const archive = path.join(root, `unsafe-${index}.tar`), destination = path.join(root, `destination-${index}`);
    const child = spawn('python3', ['-c', 'import io,json,sys,tarfile; value=json.load(sys.stdin); archive=tarfile.open(sys.argv[1],"w"); member=tarfile.TarInfo(value["name"]); member.type={"file":tarfile.REGTYPE,"hardlink":tarfile.LNKTYPE,"fifo":tarfile.FIFOTYPE}[value["type"]]; member.linkname=value.get("target",""); member.size=4 if value["type"]=="file" else 0; archive.addfile(member,io.BytesIO(b"evil") if member.size else None); archive.close()', archive], { stdio: ['pipe', 'ignore', 'pipe'] });
    const ended = Promise.withResolvers();
    child.once('error', ended.reject); child.once('close', code => code === 0 ? ended.resolve() : ended.reject(new Error('Archive fixture failed')));
    child.stdin.end(JSON.stringify(entry));
    await ended.promise;
    await assert.rejects(run(['unpack', destination], await readFile(archive)));
    await assert.rejects(stat(destination), { code: 'ENOENT' });
    assert.equal(await readFile(outside, 'utf8'), 'outside guard');
  }
});

test('recursive publication refuses existing directories and symlinks without changing their contents', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workssh-tree-no-overwrite-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), destination = path.join(root, 'destination'), alias = path.join(root, 'alias'), archive = path.join(root, 'tree.tar');
  await mkdir(source); await writeFile(path.join(source, 'new'), 'new data');
  await mkdir(destination); await writeFile(path.join(destination, 'guard'), 'existing data');
  await symlink('destination', alias);
  await pack(source, archive);
  const bytes = await readFile(archive);
  await assert.rejects(run(['unpack', destination], bytes));
  await assert.rejects(run(['unpack', alias], bytes));
  assert.equal(await readFile(path.join(destination, 'guard'), 'utf8'), 'existing data');
  await assert.rejects(stat(path.join(destination, 'new')), { code: 'ENOENT' });
  assert.equal((await lstat(alias)).isSymbolicLink(), true);
});
