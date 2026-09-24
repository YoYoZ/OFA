const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ofa-test-'));
}

// Starts server.js as a child process; resolves once it listens
async function startServer({ dataDir = tempDataDir(), env = {} } = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: dataDir, // no .env in cwd
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ADMIN_PASSWORD: '', SESSION_SECRET: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const onData = (d) => { output += d; if (output.includes('Server running')) resolve(); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`server exited with ${code}\n${output}`)));
  });
  const base = `http://127.0.0.1:${port}`;

  async function request(method, url, body, headers = {}) {
    const isBuffer = Buffer.isBuffer(body);
    const res = await fetch(base + url, {
      method,
      headers: { ...(isBuffer ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : isBuffer || typeof body === 'string' ? body : JSON.stringify(body)
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  }

  function stop() {
    return new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill();
    });
  }

  return { base, port, dataDir, child, request, stop, output: () => output };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = { startServer, tempDataDir, sleep, ROOT };
