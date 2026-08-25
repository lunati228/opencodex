"use strict";

const moduleBuiltin = require("node:module");

function blocked(name) {
  const replacement = function ornithCapabilityBlocked() {
    const error = new Error(`ORNITH_NETWORK_DISABLED: ${name}`);
    error.code = "ORNITH_NETWORK_DISABLED";
    throw error;
  };
  Object.defineProperty(replacement, "ornithCapabilityBlocked", {
    value: true,
  });
  return replacement;
}

function lock(target, name, replacement = blocked(name)) {
  if (!target || !(name in target)) return;
  if (target[name]?.ornithCapabilityBlocked === true) return;
  try {
    Object.defineProperty(target, name, {
      value: replacement,
      enumerable: Object.prototype.propertyIsEnumerable.call(target, name),
      writable: false,
      configurable: false,
    });
  } catch (definitionError) {
    try {
      target[name] = replacement;
    } catch {
      if (target[name]?.ornithCapabilityBlocked !== true) {
        throw definitionError;
      }
    }
  }
}

lock(globalThis, "fetch", blocked("fetch"));
lock(globalThis, "WebSocket", blocked("WebSocket"));

const httpBuiltins = [
  ["node:http", require("node:http")],
  ["node:https", require("node:https")],
];
for (const [name, builtin] of httpBuiltins) {
  for (const method of ["request", "get", "createServer", "ClientRequest"]) {
    lock(builtin, method, blocked(`${name}.${method}`));
  }
  lock(
    builtin.Agent?.prototype,
    "createConnection",
    blocked(`${name}.Agent.createConnection`),
  );
}
for (const name of ["_http_client", "_http_agent"]) {
  const builtin = process.getBuiltinModule(name);
  lock(builtin, "ClientRequest", blocked(`${name}.ClientRequest`));
  lock(
    builtin?.Agent?.prototype,
    "createConnection",
    blocked(`${name}.Agent.createConnection`),
  );
}

const net = require("node:net");
for (const method of ["connect", "createConnection", "createServer"]) {
  lock(net, method, blocked(`net.${method}`));
}
lock(net.Socket.prototype, "connect", blocked("net.Socket.connect"));
lock(net.Server.prototype, "listen", blocked("net.Server.listen"));

const tls = require("node:tls");
for (const method of ["connect", "createServer"]) {
  lock(tls, method, blocked(`tls.${method}`));
}
lock(tls.TLSSocket.prototype, "connect", blocked("tls.TLSSocket.connect"));

const http2 = require("node:http2");
for (const method of ["connect", "createServer", "createSecureServer"]) {
  lock(http2, method, blocked(`http2.${method}`));
}

const dgram = require("node:dgram");
lock(dgram, "createSocket", blocked("dgram.createSocket"));
for (const method of ["bind", "connect", "send"]) {
  lock(dgram.Socket.prototype, method, blocked(`dgram.Socket.${method}`));
}

const dns = require("node:dns");
for (const method of [
  "getDefaultResultOrder",
  "getServers",
  "lookup",
  "lookupService",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTxt",
  "reverse",
  "setDefaultResultOrder",
  "setServers",
]) {
  lock(dns, method, blocked(`dns.${method}`));
}
for (const method of [
  "lookup",
  "lookupService",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTxt",
  "reverse",
]) {
  lock(dns.promises, method, blocked(`dns.promises.${method}`));
}
for (const [resolver, label] of [
  [dns.Resolver, "dns.Resolver"],
  [dns.promises.Resolver, "dns.promises.Resolver"],
]) {
  for (const method of [
    "cancel",
    "resolve",
    "resolve4",
    "resolve6",
    "resolveAny",
    "resolveCaa",
    "resolveCname",
    "resolveMx",
    "resolveNaptr",
    "resolveNs",
    "resolvePtr",
    "resolveSoa",
    "resolveSrv",
    "resolveTxt",
    "reverse",
    "setLocalAddress",
    "setServers",
  ]) {
    lock(resolver?.prototype, method, blocked(`${label}.${method}`));
  }
}

const childProcess = require("node:child_process");
for (const method of [
  "exec",
  "execFile",
  "execFileSync",
  "execSync",
  "fork",
  "spawn",
  "spawnSync",
]) {
  lock(childProcess, method, blocked(`child_process.${method}`));
}

const inspector = require("node:inspector");
lock(inspector, "open", blocked("inspector.open"));
lock(inspector.Session.prototype, "connect", blocked("inspector.Session.connect"));

const workerThreads = require("node:worker_threads");
lock(workerThreads, "Worker", class OrnithWorkerBlocked {
  constructor() {
    throw blocked("worker_threads.Worker")();
  }
});

for (const method of [
  "abort",
  "binding",
  "_linkedBinding",
  "dlopen",
  "exit",
  "kill",
  "reallyExit",
]) {
  lock(process, method, blocked(`process.${method}`));
}

moduleBuiltin.syncBuiltinESMExports();
