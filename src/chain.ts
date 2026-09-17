// Robinhood Chain (4663) + Orbio contracts. Only used when WALLET_PRIVATE_KEY is set.
import { createPublicClient, createWalletClient, http, defineChain, parseUnits, formatUnits, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';

export const robinhood = defineChain({
  id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
});
export const ADDR = {
  CREDIT: '0xe33322da1380e61e5ae5dfb21e7f62924c73004c' as Address,
  EXCHANGE: '0x6951ffd32630b05e06f50062aea801625a58ebc0' as Address,
  USDG: '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as Address,
};
const abi = (f: string) => { const j = JSON.parse(readFileSync(`abi/${f}.json`, 'utf8')); return Array.isArray(j) ? j : j.abi; };
export const ABI = { exchange: abi('exchange'), credit: abi('credit'), erc20: abi('erc20') };

const pk = process.env.WALLET_PRIVATE_KEY as Hex | undefined;
export const account = pk ? privateKeyToAccount(pk) : null;
export const pub = createPublicClient({ chain: robinhood, transport: http() });
export const wallet = account ? createWalletClient({ account, chain: robinhood, transport: http() }) : null;

export const units = (usd: number) => parseUnits(usd.toFixed(6), 6);   // USDG and CREDIT: 6 decimals
export const usd = (u: bigint) => Number(formatUnits(u, 6));

// One signature, no transaction: the key is the signature.
export async function deriveApiKey(epoch = Number(process.env.ORBIO_KEY_EPOCH || 0)) {
  if (!wallet || !account) throw new Error('no wallet');
  const signature = await wallet.signMessage({ account, message: `Orbio API key · chain 4663 · epoch ${epoch}` });
  return `sk-orb-${epoch}-${Buffer.from(signature.slice(2), 'hex').toString('base64')}`;
}

export async function balances() {
  if (!account) return null;
  const [usdg, credit, eth] = await Promise.all([
    pub.readContract({ address: ADDR.USDG, abi: ABI.erc20, functionName: 'balanceOf', args: [account.address] }) as Promise<bigint>,
    pub.readContract({ address: ADDR.CREDIT, abi: ABI.credit, functionName: 'balanceOf', args: [account.address] }) as Promise<bigint>,
    pub.getBalance({ address: account.address }),
  ]);
  return { address: account.address, usdg: usd(usdg), credit: usd(credit), eth: Number(formatUnits(eth, 18)) };
}

// Buy from the order book and burn straight into the wallet's own API balance.
export async function buyAndActivate(usdIn: number) {
  if (!wallet || !account) throw new Error('no wallet');
  const usdgIn = units(usdIn);
  const maxFills = (await pub.readContract({ address: ADDR.EXCHANGE, abi: ABI.exchange, functionName: 'MAX_FILLS' })) as bigint;
  const q = (await pub.readContract({ address: ADDR.EXCHANGE, abi: ABI.exchange, functionName: 'getQuote', args: [usdgIn, maxFills] })) as any;
  const creditOut: bigint = q.creditOut ?? q[0];
  const usdgSpent: bigint = q.usdgSpent ?? q[1];
  const feeAtoms: bigint = q.feeAtoms ?? q[2] ?? 0n;
  if (creditOut === 0n) throw new Error('order book gave no fill for this size');
  const minCreditOut = (creditOut * 99n) / 100n;
  const allowance = usdgSpent + feeAtoms + units(0.01);
  const h1 = await wallet.writeContract({ address: ADDR.USDG, abi: ABI.erc20, functionName: 'approve', args: [ADDR.EXCHANGE, allowance] });
  await pub.waitForTransactionReceipt({ hash: h1 });
  const beneficiary = ('0x' + account.address.slice(2).toLowerCase().padStart(64, '0')) as Hex; // bytes32(uint256(uint160(addr)))
  const h2 = await wallet.writeContract({ address: ADDR.EXCHANGE, abi: ABI.exchange, functionName: 'buyAndActivate', args: [usdgIn, minCreditOut, beneficiary, maxFills] });
  const rc = await pub.waitForTransactionReceipt({ hash: h2 });
  return { tx: h2, status: rc.status, quoted_credit: usd(creditOut), quoted_usdg: usd(usdgSpent + feeAtoms), explorer: `${robinhood.blockExplorers!.default.url}/tx/${h2}` };
}
