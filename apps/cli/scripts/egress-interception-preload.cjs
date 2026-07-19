/*
 * Test-only Node preload used by check:egress-runtime-interception.
 *
 * The preload is deliberately dependency-free and blocks an attempted egress
 * before it reaches the operating system. It records attempts as JSON Lines
 * when LAL_EGRESS_AUDIT_LOG is set. It is not a production firewall: native
 * addons, external processes started before it loads, and non-Node runtimes
 * are outside this harness's visibility.
 */
'use strict';

const fs = require('node:fs');
const dns = require('node:dns');
const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const https = require('node:https');
const childProcess = require('node:child_process');
const logPath = process.env.LAL_EGRESS_AUDIT_LOG;

function record(surface, detail) {
  if (!logPath) return;
  fs.appendFileSync(
    logPath,
    `${JSON.stringify({ surface, detail: String(detail ?? '') })}\n`,
    'utf8',
  );
}

function blocked(surface, detail) {
  record(surface, detail);
  const error = new Error(`LAL egress audit blocked ${surface}`);
  error.code = 'LAL_EGRESS_AUDIT_BLOCKED';
  return error;
}

function blockedDns(surface) {
  return function auditDns(hostname, ...args) {
    const callback = [...args]
      .reverse()
      .find((value) => typeof value === 'function');
    const error = blocked(surface, hostname);
    if (callback) {
      process.nextTick(callback, error);
      return undefined;
    }
    throw error;
  };
}

for (const method of [
  'lookup',
  'resolve',
  'resolve4',
  'resolve6',
  'resolveAny',
  'resolveCaa',
  'resolveCname',
  'resolveMx',
  'resolveNaptr',
  'resolveNs',
  'resolvePtr',
  'resolveSoa',
  'resolveSrv',
  'resolveTxt',
  'reverse',
]) {
  if (typeof dns[method] === 'function') dns[method] = blockedDns(`dns.${method}`);
  if (dns.promises && typeof dns.promises[method] === 'function') {
    dns.promises[method] = async (hostname) => {
      throw blocked(`dns.promises.${method}`, hostname);
    };
  }
}

net.Socket.prototype.connect = function auditSocketConnect(...args) {
  const detail =
    typeof args[0] === 'object' ? args[0]?.host ?? args[0]?.path : args[0];
  const error = blocked('net.Socket.connect', detail);
  process.nextTick(() => this.emit('error', error));
  return this;
};

for (const [module, name, surface] of [
  [net, 'connect', 'net.connect'],
  [net, 'createConnection', 'net.createConnection'],
  [tls, 'connect', 'tls.connect'],
]) {
  if (typeof module[name] === 'function') {
    module[name] = (...args) => {
      const detail =
        typeof args[0] === 'object' ? args[0]?.host ?? args[0]?.path : args[0];
      const error = blocked(surface, detail);
      const socket = new net.Socket();
      process.nextTick(() => socket.emit('error', error));
      return socket;
    };
  }
}

for (const [module, name, surface] of [
  [http, 'request', 'http.request'],
  [http, 'get', 'http.get'],
  [https, 'request', 'https.request'],
  [https, 'get', 'https.get'],
]) {
  module[name] = (...args) => {
    throw blocked(surface, args[0]);
  };
}

if (typeof globalThis.fetch === 'function') {
  globalThis.fetch = async (input) => {
    throw blocked('fetch', typeof input === 'string' ? input : input?.url);
  };
}

for (const name of ['spawn', 'exec', 'execFile', 'fork']) {
  if (typeof childProcess[name] === 'function') {
    childProcess[name] = (...args) => {
      throw blocked(`child_process.${name}`, args[0]);
    };
  }
}
if (typeof childProcess.spawnSync === 'function') {
  childProcess.spawnSync = (...args) => ({
    error: blocked('child_process.spawnSync', args[0]),
    status: 1,
    signal: null,
    stdout: null,
    stderr: null,
  });
}
if (typeof childProcess.execSync === 'function') {
  childProcess.execSync = (...args) => {
    throw blocked('child_process.execSync', args[0]);
  };
}
