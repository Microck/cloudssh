#!/usr/bin/env node
import { connect } from 'node:net';

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65535) process.exit(2);
const socket = connect({ host: '127.0.0.1', port });
socket.pipe(process.stdout);
process.stdin.pipe(socket);
socket.on('close', () => process.exit());
socket.on('error', () => process.exit(1));
process.stdin.on('error', () => socket.destroy());
