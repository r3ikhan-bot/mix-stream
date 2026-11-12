import crypto from 'node:crypto';

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;

  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, data]);
}

export class WebSocketHub {
  constructor() {
    this.clients = new Set();
  }

  handleUpgrade(req, socket, onMessage, onConnect) {
    const key = req.headers['sec-websocket-key'];
    if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }

    const accept = crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n',
      ].join('\r\n'),
    );
    socket.setNoDelay(true);

    const client = {
      id: crypto.randomUUID(),
      socket,
      buffer: Buffer.alloc(0),
      fragments: [],
      fragmentOpcode: null,
      send(obj) {
        if (socket.destroyed || !socket.writable) return;
        socket.write(encodeFrame(typeof obj === 'string' ? obj : JSON.stringify(obj), 0x1));
      },
      close(code = 1000) {
        if (socket.destroyed) return;
        const buf = Buffer.allocUnsafe(2);
        buf.writeUInt16BE(code, 0);
        try {
          socket.write(encodeFrame(buf, 0x8));
        } catch {}
        socket.end();
      },
    };

    this.clients.add(client);
    if (onConnect) onConnect(client);

    socket.on('data', (chunk) => {
      client.buffer = Buffer.concat([client.buffer, chunk]);
      this.#drain(client, onMessage);
    });

    const cleanup = () => this.clients.delete(client);
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  }

  broadcast(obj, exclude = null) {
    if (this.clients.size === 0) return;
    const frame = encodeFrame(typeof obj === 'string' ? obj : JSON.stringify(obj), 0x1);
    for (const c of this.clients) {
      if (c === exclude) continue;
      if (!c.socket.destroyed && c.socket.writable) {
        c.socket.write(frame);
      }
    }
  }

  #drain(client, onMessage) {
    while (client.buffer.length >= 2) {
      const b0 = client.buffer[0];
      const b1 = client.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (client.buffer.length < 4) return;
        len = client.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (client.buffer.length < 10) return;
        const big = client.buffer.readBigUInt64BE(2);
        if (big > 1024n * 1024n) {
          client.close(1009);
          return;
        }
        len = Number(big);
        offset = 10;
      }

      const maskSize = masked ? 4 : 0;
      const total = offset + maskSize + len;
      if (client.buffer.length < total) return;

      let payload = client.buffer.subarray(offset + maskSize, total);
      if (masked) {
        const mask = client.buffer.subarray(offset, offset + 4);
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      }
      client.buffer = client.buffer.subarray(total);

      if (opcode === 0x8) {
        client.close(1000);
        return;
      }
      if (opcode === 0x9) {
        if (!client.socket.destroyed && client.socket.writable) {
          client.socket.write(encodeFrame(payload, 0xA));
        }
        continue;
      }
      if (opcode === 0xA) continue;

      if (opcode === 0x0) {
        client.fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(client.fragments);
          const orig = client.fragmentOpcode;
          client.fragments = [];
          client.fragmentOpcode = null;
          if (orig === 0x1 && onMessage) onMessage(client, full.toString('utf8'));
        }
        continue;
      }

      if (!fin) {
        client.fragmentOpcode = opcode;
        client.fragments = [payload];
        continue;
      }
      if (opcode === 0x1 && onMessage) onMessage(client, payload.toString('utf8'));
    }
  }
}
