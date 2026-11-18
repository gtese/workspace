import net from 'node:net';
import tls from 'node:tls';

function readLines(socket) {
  let buf = '';
  const queue = [];
  const waiters = [];
  const onData = (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (!queue.length) queue.push(line); else queue.push(line);
    }
    flush();
  };
  const flush = () => {
    if (!waiters.length || !queue.length) return;
    while (waiters.length && queue.length) {
      waiters.shift()(queue.shift());
    }
  };
  socket.on('data', onData);
  return {
    line: () => new Promise((resolve, reject) => { waiters.push(resolve); flush(); setTimeout(() => reject(new Error('SMTP 读超时')), 15000); }),
    detach: () => socket.off('data', onData),
  };
}

function expect(rl, codes) {
  return (async () => {
    for (;;) {
      const line = await rl.line();
      const code = Number(line.slice(0, 3));
      if (line.length > 3 && line[3] === '-') continue; // 多行响应
      if (codes && !codes.includes(code)) throw new Error(`SMTP 响应异常：${line}`);
      return line;
    }
  })();
}

export async function sendMail({ host, port = 465, secure = true, user, pass, from, to, subject, text }) {
  let socket = secure
    ? tls.connect({ host, port, servername: host })
    : net.connect({ host, port });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  let rl = readLines(socket);
  await expect(rl, [220]);
  const ehlo = () => send(`EHLO backup-center`);
  const send = (line) => { socket.write(line + '\r\n'); return expect(rl, null); };
  await ehlo();
  if (!secure) {
    await send('STARTTLS');
    socket = tls.connect({ socket, servername: host });
    await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
    rl = readLines(socket);
    await ehlo();
  }
  if (user) {
    await send('AUTH LOGIN');
    await send(Buffer.from(user).toString('base64'));
    socket.write(Buffer.from(pass).toString('base64') + '\r\n');
    await expect(rl, [235]);
  }
  await send(`MAIL FROM:<${from}>`);
  for (const r of to) await send(`RCPT TO:<${r}>`);
  await send('DATA');
  const body = `From: ${from}\r\nTo: ${to.join(', ')}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${text}\r\n.\r\n`;
  socket.write(body);
  await expect(rl, [250]);
  socket.write('QUIT\r\n');
  socket.end();
  rl.detach();
}
