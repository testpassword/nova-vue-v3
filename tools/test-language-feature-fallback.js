"use strict";

const { spawn } = require("child_process");
const path = require("path");
const { pathToFileURL } = require("url");

const root = path.resolve(__dirname, "..");
const {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter
} = require(path.join(
  root,
  "Vue.novaextension",
  "Support",
  "server",
  "node_modules",
  "vscode-jsonrpc",
  "lib",
  "node",
  "main.js"
));

if (process.argv.includes("--globalPlugins")) {
  runFakeTsserver();
} else if (process.argv.includes("--stdio")) {
  runFakeVueServer();
} else {
  runTest().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

async function runTest() {
  const proxyPath = path.join(root, "Vue.novaextension", "Support", "proxy", "vue-lsp-proxy.js");
  const vueUri = pathToFileURL(path.join(root, "test-workspaces", "diagnostics", "fallback.vue")).href;
  const bridge = spawn(process.execPath, [
    proxyPath,
    "--vueServer",
    __filename,
    "--vueServerKind",
    "script",
    "--tsserver",
    __filename,
    "--tsdk",
    __dirname,
    "--pluginProbeLocation",
    __dirname,
    "--cwd",
    root
  ], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const connection = createConnection(bridge.stdout, bridge.stdin);
  let stderr = "";
  bridge.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  connection.listen();

  try {
    await requestWithTimeout(connection, "initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      workspaceFolders: [{ uri: pathToFileURL(root).href, name: "fallback-test" }],
      capabilities: {},
      initializationOptions: {
        proxy: { fallbackToVueLanguageServer: true },
        vue: {
          diagnostics: { enabled: false },
          codeActions: { enabled: false },
          completion: { enabled: true },
          typescript: { enabled: true, navigation: true }
        }
      }
    });
    connection.sendNotification("initialized", {});
    connection.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: vueUri,
        languageId: "vue",
        version: 1,
        text: "<script setup lang=\"ts\">\nfoo\n</script>\n"
      }
    });

    assertCompletion(await requestCompletion(connection, vueUri, 1), "vue-no-content-fallback");
    assertCompletion(await requestCompletion(connection, vueUri, 2), "vue-error-fallback");

    const successfulEmpty = await requestCompletion(connection, vueUri, 3);
    if (completionItems(successfulEmpty).length !== 0) {
      throw new Error(`Successful empty TypeScript completion must not fall back: ${JSON.stringify(successfulEmpty)}`);
    }

    const signatureHelp = await requestWithTimeout(connection, "textDocument/signatureHelp", {
      textDocument: { uri: vueUri },
      position: { line: 1, character: 1 },
      context: { triggerKind: 1, isRetrigger: false }
    });
    if (signatureHelp?.signatures?.[0]?.label !== "vueFallback(value: string): void") {
      throw new Error(`Expected Vue signature fallback: ${JSON.stringify(signatureHelp)}`);
    }

    await delay(50);
    if (!stderr.includes("TypeScript completion failed: synthetic tsserver failure")) {
      throw new Error(`Expected real tsserver failure to be logged: ${stderr}`);
    }
    if (stderr.includes("failed: No content available.")) {
      throw new Error(`No-content response must not be logged as an error: ${stderr}`);
    }

    console.log("Language feature fallback integration test passed.");
  } finally {
    connection.dispose();
    bridge.kill();
  }
}

function requestCompletion(connection, uri, character) {
  return requestWithTimeout(connection, "textDocument/completion", {
    textDocument: { uri },
    position: { line: 1, character },
    context: { triggerKind: 1 }
  });
}

function requestWithTimeout(connection, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Bridge request timed out: ${method}`));
    }, 5000);
    connection.sendRequest(method, params).then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function assertCompletion(result, label) {
  if (!completionItems(result).some((item) => item.label === label)) {
    throw new Error(`Expected ${label}: ${JSON.stringify(result)}`);
  }
}

function completionItems(result) {
  return Array.isArray(result) ? result : result?.items || [];
}

function runFakeTsserver() {
  const writer = new StreamMessageWriter(process.stdout);
  let buffer = "";
  let nextSeq = 1;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd < 0) {
        return;
      }
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      if (!line) {
        continue;
      }
      const request = JSON.parse(line);
      if (["open", "change", "close"].includes(request.command)) {
        continue;
      }
      let response;
      if (request.command === "completionInfo" && request.arguments?.offset === 3) {
        response = tsserverResponse(request, false, undefined, "synthetic tsserver failure");
      } else if (request.command === "completionInfo" && request.arguments?.offset === 4) {
        response = tsserverResponse(request, true, { isIncomplete: false, entries: [] });
      } else {
        response = tsserverResponse(request, false, undefined, "No content available.");
      }
      response.seq = nextSeq++;
      writer.write(response);
    }
  });
}

function tsserverResponse(request, success, body, message) {
  return {
    seq: 0,
    type: "response",
    command: request.command,
    request_seq: request.seq,
    success,
    body,
    message
  };
}

function runFakeVueServer() {
  const connection = createConnection(process.stdin, process.stdout);
  connection.onRequest("initialize", () => ({
    capabilities: {
      completionProvider: {},
      signatureHelpProvider: {}
    }
  }));
  connection.onRequest("textDocument/completion", (params) => {
    const labels = {
      1: "vue-no-content-fallback",
      2: "vue-error-fallback",
      3: "vue-should-not-run"
    };
    return {
      isIncomplete: false,
      items: [{ label: labels[params?.position?.character] || "vue-fallback" }]
    };
  });
  connection.onRequest("textDocument/signatureHelp", () => ({
    signatures: [{ label: "vueFallback(value: string): void" }],
    activeSignature: 0,
    activeParameter: 0
  }));
  connection.listen();
}

function createConnection(input, output) {
  return createMessageConnection(
    new StreamMessageReader(input),
    new StreamMessageWriter(output)
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
