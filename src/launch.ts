// Launch switches of the app, separate from the on-chain features.
// The Vault is open on chain since 26 September 2026 (activate(1)). Set VAULT_PUBLIC to false to show it as "coming
// soon": accounts that already staked then keep their position with Claim, Compound and Withdraw, and `/vault?preview`
// shows the full page.
export const VAULT_PUBLIC = true;

// The launchpad page where the launcher chooses the token's fees (buy → team, sell → team, sell → walls, within the
// Forge's bounds). Published on 30 September 2026: /launchpad itself lets the launcher choose, and /launchpad-custom
// leads there. Set back to false to launch with CUBIT's rates
// again (/launchpad-custom then sends visitors to /launchpad, and `/launchpad-custom?preview` shows the page).
export const CUSTOM_TAXES_PUBLIC = true;
