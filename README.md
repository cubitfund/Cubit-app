# CUBIT — web app

The CUBIT web app (https://cubit.fund): React, TypeScript and viem, with EIP-6963 wallet discovery and no wagmi.
It reads the CUBIT contracts on Ethereum mainnet: the market, the walls, the staking vault and the public launchpad.

## Develop

```bash
pnpm install
pnpm dev
pnpm test
pnpm build   # VITE_RPC_URL sets the read endpoint at build time; without it, the app uses a public RPC
```

## Contract data

`src/chain/abi.ts`, `src/chain/bytecode.ts` and `src/chain/deployments/` are generated from the contracts repository
(Foundry artifacts and deployment manifests) and committed, so the app builds on its own. To regenerate them, place
the contracts repository next to this one as `../contracts`, build it, then run `pnpm gen-abi` and
`pnpm sync-deployment`.

## Reads

Reads go through a per-read endpoint policy (`src/chain/rpcPolicy.ts`): the build's endpoint first, the public RPC
as fallback. A wallet only ever receives the public RPC.
