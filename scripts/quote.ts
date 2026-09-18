import 'dotenv/config';
import { pub, ADDR, ABI, units, deriveApiKey } from '../src/chain.js';
const j = (v: any) => JSON.stringify(v, (_k, x) => typeof x === 'bigint' ? x.toString() : x);
const maxFills = await pub.readContract({ address: ADDR.EXCHANGE, abi: ABI.exchange, functionName: 'MAX_FILLS' });
const feeBps = await pub.readContract({ address: ADDR.EXCHANGE, abi: ABI.exchange, functionName: 'feeBps' });
console.log('MAX_FILLS', String(maxFills), 'feeBps', String(feeBps));
for (const amt of [1, 2.1, 3]) {
  try { const q = await pub.readContract({ address: ADDR.EXCHANGE, abi: ABI.exchange, functionName: 'getQuote', args: [units(amt), maxFills] }); console.log('quote', amt, '->', j(q)); }
  catch (e: any) { console.log('quote', amt, 'failed:', e.shortMessage || e.message); }
}
const key = await deriveApiKey(); console.log('derived key prefix', key.slice(0, 12));
const r = await fetch('https://api.orbio.so/api/v1/key', { headers: { authorization: 'Bearer ' + key } });
console.log('gateway for derived key:', r.status, (await r.text()).slice(0, 300));
