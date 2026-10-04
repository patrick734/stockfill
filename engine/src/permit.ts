import { erc20Abi, hashDomain, type Address, type Hex, type PublicClient } from "viem";
import { permitAbi } from "./abi.js";

/** Uniswap Permit2, at the same address on every chain it is deployed to. */
export const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

export type PermitDomain = { name: string; version: string; chainId: number; verifyingContract: Address };

/**
 * EIP-2612 support of `token`: its EIP-712 domain and `owner`'s next nonce, or null when the token
 * has no usable permit. The domain comes from ERC-5267 when the token implements it; otherwise the
 * version is found by matching DOMAIN_SEPARATOR against the usual candidates.
 */
export async function readPermitDomain(
  client: PublicClient,
  token: Address,
  owner: Address,
  chainId: number,
): Promise<{ domain: PermitDomain; nonce: bigint } | null> {
  const call = <T>(functionName: string, args: unknown[] = []) =>
    client.readContract({ address: token, abi: permitAbi, functionName, args } as never).then(
      (v) => v as T,
      () => null,
    );
  const [separator, nonce] = await Promise.all([call<Hex>("DOMAIN_SEPARATOR"), call<bigint>("nonces", [owner])]);
  if (!separator || nonce === null) return null;

  const eip5267 = await call<readonly [Hex, string, string, bigint, Address, Hex, readonly bigint[]]>("eip712Domain");
  const name = eip5267?.[1] ?? (await client.readContract({ address: token, abi: erc20Abi, functionName: "name" }).catch(() => null));
  if (!name) return null;
  const versions = [eip5267?.[2], await call<string>("version"), "1", "2"].filter((v): v is string => typeof v === "string");
  for (const version of [...new Set(versions)]) {
    const domain = { name, version, chainId, verifyingContract: token };
    const hash = hashDomain({ domain: { ...domain, chainId: BigInt(chainId) }, types: { EIP712Domain: EIP712_DOMAIN } });
    if (hash.toLowerCase() === separator.toLowerCase()) {
      return { domain, nonce };
    }
  }
  return null;
}

const EIP712_DOMAIN = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

/** Typed data for an EIP-2612 permit. Sign it with the wallet's eth_signTypedData_v4. */
export function permitTypedData(p: { domain: PermitDomain; owner: Address; spender: Address; value: bigint; nonce: bigint; deadline: bigint }) {
  return {
    domain: p.domain,
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit" as const,
    message: { owner: p.owner, spender: p.spender, value: p.value, nonce: p.nonce, deadline: p.deadline },
  };
}

/** Typed data for a Permit2 signature transfer of `amount` of `token` to `spender`. */
export function permit2TypedData(p: { chainId: number; token: Address; amount: bigint; spender: Address; nonce: bigint; deadline: bigint; permit2?: Address }) {
  return {
    domain: { name: "Permit2", chainId: p.chainId, verifyingContract: p.permit2 ?? PERMIT2 },
    types: {
      PermitTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
    },
    primaryType: "PermitTransferFrom" as const,
    message: { permitted: { token: p.token, amount: p.amount }, spender: p.spender, nonce: p.nonce, deadline: p.deadline },
  };
}

/** A Permit2 nonce. Permit2 nonces are unordered, so a random one is as good as any. */
export function randomPermit2Nonce(): bigint {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return bytes.reduce((n, b) => (n << 8n) | BigInt(b), 0n);
}

/** Splits a 65-byte signature into the v, r, s that `permit` takes. */
export function splitSignature(sig: Hex) {
  const r = `0x${sig.slice(2, 66)}` as Hex;
  const s = `0x${sig.slice(66, 130)}` as Hex;
  let v = parseInt(sig.slice(130, 132), 16);
  if (v < 27) v += 27;
  return { r, s, v };
}
