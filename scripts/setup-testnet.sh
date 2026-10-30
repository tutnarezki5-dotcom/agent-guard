#!/usr/bin/env bash
# Deploy AgentGuard on NEAR testnet.
#
#   OWNER_ACCOUNT=yourname.testnet bash scripts/setup-testnet.sh
#
# Needs: near CLI (near-cli-rs), cargo-near, Node 22 + pnpm (after `pnpm i`).
# The owner account must exist and be in your near CLI keychain
# (create one: `near account create-account sponsor-by-faucet-service yourname.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create`).
#
# NOTE: near CLI subcommand syntax changes between versions. Every command
# below is printed before it runs; if one fails, check `near <cmd> --help`
# and the NEAR docs, then rerun from that step with STEP=<n>.
set -euo pipefail

: "${OWNER_ACCOUNT:?set OWNER_ACCOUNT=yourname.testnet}"
NET=testnet
VAULT="vault.${OWNER_ACCOUNT}"
AGENT="agent.${OWNER_ACCOUNT}"
RECEIVER="${RECEIVER:-weather.${OWNER_ACCOUNT}}"
STEP="${STEP:-1}"
PNPM="${PNPM:-pnpm}"
cd "$(dirname "$0")/.."

run() { echo; echo "+ $*"; "$@"; }
step() { [ "$STEP" -le "$1" ]; }

command -v near >/dev/null || { echo "near CLI not found: https://docs.near.org/tools/near-cli"; exit 1; }

if step 1; then
  echo "== 1. Build the vault contract"
  (cd contracts/vault && run cargo near build non-reproducible-wasm)
fi
WASM="contracts/vault/target/near/agentguard_vault.wasm"

if step 2; then
  echo "== 2. AgentGuard signing key"
  if ! grep -q '^GUARD_SECRET_KEY=' .env 2>/dev/null; then
    $PNPM -s keys:guard | grep -E '^(GUARD_SECRET_KEY|GUARD_PUBLIC_KEY)=' >> .env
    echo "   written to .env"
  fi
fi
GUARD_PUBLIC_KEY="$(grep '^GUARD_PUBLIC_KEY=' .env | cut -d= -f2-)"

if step 3; then
  echo "== 3. Create vault and agent sub-accounts (funded by the owner)"
  run near account create-account fund-myself "$VAULT" '4 NEAR' autogenerate-new-keypair save-to-legacy-keychain sign-as "$OWNER_ACCOUNT" network-config "$NET" sign-with-legacy-keychain send
  run near account create-account fund-myself "$AGENT" '0.5 NEAR' autogenerate-new-keypair save-to-legacy-keychain sign-as "$OWNER_ACCOUNT" network-config "$NET" sign-with-legacy-keychain send
  # A receiver we control, so a real payment has somewhere to land.
  if [ "$RECEIVER" = "weather.${OWNER_ACCOUNT}" ]; then
    run near account create-account fund-myself "$RECEIVER" '0.1 NEAR' autogenerate-new-keypair save-to-legacy-keychain sign-as "$OWNER_ACCOUNT" network-config "$NET" sign-with-legacy-keychain send
  fi
fi

if step 4; then
  echo "== 4. Deploy the vault and initialise it"
  ARGS=$(printf '{"owner":"%s","agent":"%s","guard_public_key":"%s"}' "$OWNER_ACCOUNT" "$AGENT" "$GUARD_PUBLIC_KEY")
  run near contract deploy "$VAULT" use-file "$WASM" with-init-call new json-args "$ARGS" prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config "$NET" sign-with-legacy-keychain send
fi

if step 5; then
  echo "== 5. Give the agent ONE function-call key: vault.request_payment only"
  if ! grep -q '^AGENT_FC_PRIVATE_KEY=' .env 2>/dev/null; then
    $PNPM -s exec tsx scripts/gen-agent-key.ts >> .env
  fi
  FC_PUB="$(grep '^AGENT_FC_PUBLIC_KEY=' .env | cut -d= -f2-)"
  run near account add-key "$AGENT" grant-function-call-access --allowance '0.5 NEAR' --contract-account-id "$VAULT" --function-names 'request_payment' use-manually-provided-public-key "$FC_PUB" network-config "$NET" sign-with-legacy-keychain send
  # Remove the agent's full-access key from step 3, so the agent can ONLY
  # call vault.request_payment (see docs/key-limits.md).
  CRED="$HOME/.near-credentials/$NET/$AGENT.json"
  if [ -f "$CRED" ]; then
    FULL_PK="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).public_key)' "$CRED")"
    run near account delete-keys "$AGENT" public-keys "$FULL_PK" network-config "$NET" sign-with-legacy-keychain send
    mv "$CRED" "$CRED.deleted"
  fi
fi

if step 6; then
  echo "== 6. Create the demo mandate on chain (3 NEAR budget, 1 NEAR per payment, 7 days)"
  EXP=$(( ($(date +%s) + 7*86400) * 1000 ))
  ARGS=$(printf '{"id":"m_api_access_01","budget":"3000000000000000000000000","per_tx_max":"1000000000000000000000000","expires_at_ms":"%s","allowed_receivers":["%s"],"onchain_approval_threshold":"0"}' "$EXP" "$RECEIVER")
  run near contract call-function as-transaction "$VAULT" create_mandate json-args "$ARGS" prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as "$OWNER_ACCOUNT" network-config "$NET" sign-with-legacy-keychain send
fi

if step 7; then
  echo "== 7. Write the rest of .env"
  grep -q '^EXECUTOR=' .env || cat >> .env <<EOF
EXECUTOR=testnet
VAULT_CONTRACT_ID=$VAULT
AGENT_ACCOUNT_ID=$AGENT

OWNER_TOKEN=$(node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')
NEAR_RPC_URL=https://rpc.testnet.near.org
EOF
  echo
  echo "Done. Next:"
  echo "  1. Create the same mandate in AgentGuard (README, 'Testnet' section)."
  echo "  2. pnpm dev        # API + dashboard"
  echo "  3. pnpm agent      # agent pays through AgentGuard → vault"
  echo "  4. Explorer: https://testnet.nearblocks.io/address/$VAULT"
fi
