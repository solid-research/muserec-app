import { put } from '@vercel/blob';
import fs from 'fs';

const blob = await put('muserec.db', fs.readFileSync('./data/data.db'), {
  access: 'public',
  token: process.env.BLOB_READ_WRITE_TOKEN,
});
console.log('DB URL:', blob.url);