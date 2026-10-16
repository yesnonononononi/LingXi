import fs from 'node:fs';
import readline from 'node:readline';

fs.writeFileSync('server.pid', String(process.pid));
for await (const line of readline.createInterface({input: process.stdin})) {
  const message = JSON.parse(line);
  if (!Object.hasOwn(message, 'id')) continue;
  let result;
  if (message.method === 'initialize') {
    result = {protocolVersion: message.params.protocolVersion, capabilities: {tools: {}}, serverInfo: {name: 'business-fixture', version: '1'}};
  } else if (message.method === 'tools/list') {
    result = {tools: [{name: 'inspect', description: '测试工具', inputSchema: {type: 'object', properties: {}, additionalProperties: true}}]};
  } else if (message.method === 'tools/call') {
    const args = message.params.arguments;
    let text = args.value;
    if (args.path) {
      try { text = fs.readFileSync(args.path, 'utf8'); } catch { text = 'DENIED'; }
    }
    result = {content: [{type: 'text', text}]};
  } else result = {};
  process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: message.id, result}) + '\n');
}
