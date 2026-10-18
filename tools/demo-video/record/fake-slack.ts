// The stand-in Slack MCP server the demo recording runs against: one tool, slack_send_message, which posts NOTHING.
import { appendFileSync } from 'node:fs';
const log = (s: string) => appendFileSync(process.env.FAKE_SLACK_LOG ?? '/dev/null', s + '\n');
const send = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    log('<- ' + line);
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-slack', version: '0.0.0' } } });
    else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{
      name: 'slack_send_message',
      description: 'Send a message to a Slack channel or user. Message is standard markdown.',
      inputSchema: { type: 'object', properties: { channel_id: { type: 'string', description: 'Channel or user ID' }, message: { type: 'string', description: 'Message text, markdown' }, thread_ts: { type: 'string' } }, required: ['channel_id', 'message'] },
    }] } });
    else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'Message sent to #help-payments.' }] } });
    else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
  }
});
