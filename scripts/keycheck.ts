import 'dotenv/config';
import { deriveApiKey } from '../src/chain.js';
const key = await deriveApiKey();
const r = await fetch('https://api.orbio.so/api/v1/key', { headers: { authorization: 'Bearer ' + key } });
console.log(r.status, (await r.text()).slice(0, 300));
