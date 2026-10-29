//! AgentGuard vault — NEAR contract.
//!
//! A thin wrapper around `agentguard-vault-core`: all rules live there and
//! are unit-tested. This file only connects them to the chain:
//! caller, block time, balance, `env::ed25519_verify`, transfers, events.
//!
//! The agent account holds ONE function-call key: receiver = this contract,
//! methods = ["request_payment"]. It cannot transfer NEAR, add keys or
//! attach a deposit. See docs/key-limits.md.
//!
//! NOTE: written against near-sdk 5.x. Verify method signatures (notably
//! `env::ed25519_verify` and `env::promise_result`) against the version you
//! install, and run `cargo near build` before deploying.

use agentguard_vault_core::{self as core, Mandate, PaymentOutcome, PaymentRequest, VaultError, VaultState};
use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{env, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseResult, PublicKey};

const CALLBACK_GAS: Gas = Gas::from_tgas(10);

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    state: VaultState,
    /// The init argument as given ("ed25519:…"), for the config view.
    guard_public_key: String,
}

#[near(serializers = [json])]
pub struct MandateView {
    pub id: String,
    pub budget: U128,
    pub per_tx_max: U128,
    pub committed: U128,
    pub remaining: U128,
    pub expires_at_ms: U64,
    pub allowed_receivers: Vec<String>,
    pub onchain_approval_threshold: U128,
    pub revoked: bool,
}

#[near(serializers = [json])]
pub struct PendingView {
    pub request_id: U64,
    pub mandate_id: String,
    pub receiver: String,
    pub amount: U128,
    pub input_hash: String,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub owner: String,
    pub agent: String,
    pub guard_public_key: String,
    pub frozen: bool,
}

fn fail(e: VaultError) -> ! {
    env::panic_str(e.code())
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    let ev = json!({ "standard": "agentguard", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{ev}"));
}

fn verify(sig: &[u8], msg: &[u8], pk: &[u8; 32]) -> bool {
    match <&[u8; 64]>::try_from(sig) {
        Ok(sig) => env::ed25519_verify(sig, msg, pk),
        Err(_) => false,
    }
}

#[near]
impl Vault {
    /// `guard_public_key` is AgentGuard's key, e.g. "ed25519:6E8s…" (see `pnpm keys:guard`).
    #[init]
    pub fn new(owner: AccountId, agent: AccountId, guard_public_key: PublicKey) -> Self {
        let bytes = guard_public_key.as_bytes();
        // First byte is the curve type (0 = ed25519), then 32 bytes of key.
        if bytes.len() != 33 || bytes[0] != 0 {
            env::panic_str("guard_public_key must be an ed25519 key");
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(&bytes[1..]);
        Self { state: VaultState::new(owner.to_string(), agent.to_string(), key), guard_public_key: String::from(&guard_public_key) }
    }

    /// Top up the vault. Anyone may fund it; only mandates decide how it is spent.
    #[payable]
    pub fn deposit(&mut self) {
        emit("deposit", json!({ "from": env::predecessor_account_id(), "amount": U128(env::attached_deposit().as_yoctonear()) }));
    }

    // ---- Owner ---------------------------------------------------------

    pub fn create_mandate(
        &mut self,
        id: String,
        budget: U128,
        per_tx_max: U128,
        expires_at_ms: U64,
        allowed_receivers: Vec<AccountId>,
        onchain_approval_threshold: U128,
    ) {
        let m = Mandate {
            budget: budget.0,
            per_tx_max: per_tx_max.0,
            expires_at_ms: expires_at_ms.0,
            allowed_receivers: allowed_receivers.iter().map(|a| a.to_string()).collect(),
            onchain_approval_threshold: onchain_approval_threshold.0,
            committed: 0,
            revoked: false,
        };
        let caller = env::predecessor_account_id();
        self.state.create_mandate(caller.as_str(), id.clone(), m).unwrap_or_else(|e| fail(e));
        emit("mandate_created", json!({ "id": id, "budget": budget, "per_tx_max": per_tx_max }));
    }

    pub fn revoke_mandate(&mut self, id: String) {
        self.state.revoke_mandate(env::predecessor_account_id().as_str(), &id).unwrap_or_else(|e| fail(e));
        emit("mandate_revoked", json!({ "id": id }));
    }

    pub fn freeze(&mut self) {
        self.state.set_frozen(env::predecessor_account_id().as_str(), true).unwrap_or_else(|e| fail(e));
        emit("frozen", json!({}));
    }

    pub fn unfreeze(&mut self) {
        self.state.set_frozen(env::predecessor_account_id().as_str(), false).unwrap_or_else(|e| fail(e));
        emit("unfrozen", json!({}));
    }

    pub fn approve(&mut self, request_id: U64) -> Promise {
        let pending = self.state.pending.get(&request_id.0).cloned();
        match self.state.approve(env::predecessor_account_id().as_str(), request_id.0).unwrap_or_else(|e| fail(e)) {
            PaymentOutcome::Transfer { receiver, amount } => {
                let mandate_id = pending.map(|p| p.mandate_id).unwrap_or_default();
                emit("approved", json!({ "request_id": request_id, "receiver": receiver, "amount": U128(amount) }));
                self.transfer(mandate_id, receiver, amount)
            }
            PaymentOutcome::Pending { .. } => env::panic_str("unexpected pending outcome"),
        }
    }

    pub fn reject(&mut self, request_id: U64) {
        self.state.reject(env::predecessor_account_id().as_str(), request_id.0).unwrap_or_else(|e| fail(e));
        emit("rejected", json!({ "request_id": request_id }));
    }

    // ---- Agent (function-call key) -------------------------------------

    /// Pay `amount` to `receiver` under `mandate_id`. Requires AgentGuard's
    /// ed25519 signature over the exact terms. Returns the request id when
    /// the payment waits for the owner, otherwise schedules the transfer.
    #[allow(clippy::too_many_arguments)]
    pub fn request_payment(
        &mut self,
        mandate_id: String,
        receiver: AccountId,
        amount: U128,
        nonce: U64,
        expires_at_ms: U64,
        input_hash: String,
        signature: Base64VecU8,
    ) -> Option<U64> {
        let caller = env::predecessor_account_id();
        let contract_id = env::current_account_id();
        let locked = env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128;
        let available = env::account_balance().as_yoctonear().saturating_sub(locked);
        let core_env = core::Env {
            caller: caller.as_str(),
            contract_id: contract_id.as_str(),
            now_ms: env::block_timestamp_ms(),
            available_balance: available,
            verify: &verify,
        };
        let req = PaymentRequest {
            mandate_id: mandate_id.clone(),
            receiver: receiver.to_string(),
            amount: amount.0,
            nonce: nonce.0,
            expires_at_ms: expires_at_ms.0,
            input_hash: input_hash.clone(),
            signature: signature.0,
        };
        match self.state.request_payment(&core_env, req).unwrap_or_else(|e| fail(e)) {
            PaymentOutcome::Transfer { receiver, amount } => {
                emit("payment", json!({ "mandate_id": mandate_id, "receiver": receiver, "amount": U128(amount), "nonce": nonce, "input_hash": input_hash }));
                // Dropping a Promise schedules it (near-sdk). We don't `as_return` it
                // because this method returns its own value.
                let _ = self.transfer(mandate_id, receiver, amount);
                None
            }
            PaymentOutcome::Pending { request_id } => {
                emit("pending", json!({ "request_id": U64(request_id), "mandate_id": mandate_id, "amount": amount, "input_hash": input_hash }));
                Some(U64(request_id))
            }
        }
    }

    // ---- Internal --------------------------------------------------------

    fn transfer(&self, mandate_id: String, receiver: String, amount: u128) -> Promise {
        let to: AccountId = receiver.parse().unwrap_or_else(|_| env::panic_str("invalid receiver"));
        Promise::new(to)
            .transfer(NearToken::from_yoctonear(amount))
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_transfer(mandate_id, U128(amount)))
    }

    /// If the transfer failed, its amount goes back to the mandate budget.
    #[private]
    pub fn on_transfer(&mut self, mandate_id: String, amount: U128) -> bool {
        let ok = matches!(env::promise_result(0), PromiseResult::Successful(_));
        if !ok {
            self.state.release(&mandate_id, amount.0);
            emit("transfer_failed", json!({ "mandate_id": mandate_id, "amount": amount }));
        }
        ok
    }

    // ---- Views -----------------------------------------------------------

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner: self.state.owner.clone(),
            agent: self.state.agent.clone(),
            guard_public_key: self.guard_public_key.clone(),
            frozen: self.state.frozen,
        }
    }

    pub fn get_mandate(&self, id: String) -> Option<MandateView> {
        self.state.mandates.get(&id).map(|m| MandateView {
            id: id.clone(),
            budget: U128(m.budget),
            per_tx_max: U128(m.per_tx_max),
            committed: U128(m.committed),
            remaining: U128(m.budget.saturating_sub(m.committed)),
            expires_at_ms: U64(m.expires_at_ms),
            allowed_receivers: m.allowed_receivers.clone(),
            onchain_approval_threshold: U128(m.onchain_approval_threshold),
            revoked: m.revoked,
        })
    }

    pub fn get_pending(&self) -> Vec<PendingView> {
        self.state
            .pending
            .iter()
            .map(|(id, p)| PendingView { request_id: U64(*id), mandate_id: p.mandate_id.clone(), receiver: p.receiver.clone(), amount: U128(p.amount), input_hash: p.input_hash.clone() })
            .collect()
    }

    pub fn is_nonce_used(&self, nonce: U64) -> bool {
        self.state.used_nonces.contains(&nonce.0)
    }
}
