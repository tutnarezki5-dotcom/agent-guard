//! AgentGuard vault — pure rule logic.
//!
//! The NEAR contract in `contracts/vault` is a thin wrapper around this crate:
//! it supplies the caller, the block time, the account balance and an
//! ed25519 verifier, and turns `PaymentOutcome::Transfer` into a real
//! `Promise::transfer`. Keeping the rules here means they are unit-tested
//! with plain `cargo test`, and the TypeScript simulator in
//! `packages/vault-sim` mirrors exactly this file (same checks, same order,
//! same error codes).
//!
//! What the vault guarantees, even if AgentGuard itself is compromised:
//! - only the registered agent account can request payments;
//! - every payment carries a fresh, unexpired AgentGuard signature over its
//!   exact terms (contract, mandate, receiver, amount, nonce, expiry);
//! - a mandate never pays more than its budget, counted exactly, because
//!   NEAR executes calls to one contract one at a time;
//! - the owner can freeze everything instantly.

use std::collections::{BTreeMap, BTreeSet};

pub type AccountId = String;
pub type Amount = u128;

#[cfg_attr(feature = "near", near_sdk::near(serializers = [borsh]))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mandate {
    pub budget: Amount,
    pub per_tx_max: Amount,
    pub expires_at_ms: u64,
    pub allowed_receivers: Vec<AccountId>,
    /// Payments at or above this amount wait for `approve` by the owner. 0 = never.
    pub onchain_approval_threshold: Amount,
    /// Paid out, plus held for pending requests and in-flight transfers.
    pub committed: Amount,
    pub revoked: bool,
}

#[cfg_attr(feature = "near", near_sdk::near(serializers = [borsh]))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingRequest {
    pub mandate_id: String,
    pub receiver: AccountId,
    pub amount: Amount,
    pub input_hash: String,
}

#[cfg_attr(feature = "near", near_sdk::near(serializers = [borsh]))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultState {
    pub owner: AccountId,
    pub agent: AccountId,
    pub guard_public_key: [u8; 32],
    pub frozen: bool,
    pub mandates: BTreeMap<String, Mandate>,
    pub used_nonces: BTreeSet<u64>,
    pub pending: BTreeMap<u64, PendingRequest>,
    pub next_request_id: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentRequest {
    pub mandate_id: String,
    pub receiver: AccountId,
    pub amount: Amount,
    pub nonce: u64,
    pub expires_at_ms: u64,
    pub input_hash: String,
    pub signature: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PaymentOutcome {
    /// Send `amount` to `receiver` now. The amount is already committed;
    /// if the transfer fails the contract calls `release`.
    Transfer { receiver: AccountId, amount: Amount },
    /// Waiting for the owner (`approve` / `reject`).
    Pending { request_id: u64 },
}

/// Error codes. Identical strings are used by the TypeScript simulator.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VaultError {
    NotOwner,
    NotAgent,
    Frozen,
    NoMandate,
    MandateExists,
    MandateRevoked,
    MandateExpired,
    AuthorizationExpired,
    NonceUsed,
    BadSignature,
    ReceiverNotAllowed,
    PerTxLimit,
    BudgetExceeded,
    InsufficientBalance,
    InvalidMandate,
    NoPendingRequest,
}

impl VaultError {
    pub fn code(&self) -> &'static str {
        match self {
            VaultError::NotOwner => "ERR_NOT_OWNER",
            VaultError::NotAgent => "ERR_NOT_AGENT",
            VaultError::Frozen => "ERR_FROZEN",
            VaultError::NoMandate => "ERR_NO_MANDATE",
            VaultError::MandateExists => "ERR_MANDATE_EXISTS",
            VaultError::MandateRevoked => "ERR_MANDATE_REVOKED",
            VaultError::MandateExpired => "ERR_MANDATE_EXPIRED",
            VaultError::AuthorizationExpired => "ERR_AUTH_EXPIRED",
            VaultError::NonceUsed => "ERR_NONCE_USED",
            VaultError::BadSignature => "ERR_BAD_SIGNATURE",
            VaultError::ReceiverNotAllowed => "ERR_RECEIVER_NOT_ALLOWED",
            VaultError::PerTxLimit => "ERR_PER_TX_LIMIT",
            VaultError::BudgetExceeded => "ERR_BUDGET_EXCEEDED",
            VaultError::InsufficientBalance => "ERR_INSUFFICIENT_BALANCE",
            VaultError::InvalidMandate => "ERR_INVALID_MANDATE",
            VaultError::NoPendingRequest => "ERR_NO_PENDING_REQUEST",
        }
    }
}

/// The exact bytes AgentGuard signs. Must match
/// `packages/guard/src/signer.ts → authorizationMessage`.
pub fn authorization_message(contract_id: &str, r: &PaymentRequest) -> String {
    format!(
        "agentguard:v1|{}|{}|{}|{}|{}|{}|{}",
        contract_id, r.mandate_id, r.receiver, r.amount, r.nonce, r.expires_at_ms, r.input_hash
    )
}

/// Environment the rules need from the chain.
pub struct Env<'a> {
    pub caller: &'a str,
    pub contract_id: &'a str,
    pub now_ms: u64,
    /// Balance the vault can pay out (after storage costs).
    pub available_balance: Amount,
    /// ed25519 verification: (signature 64 bytes, message, public key 32 bytes).
    pub verify: &'a dyn Fn(&[u8], &[u8], &[u8; 32]) -> bool,
}

impl VaultState {
    pub fn new(owner: AccountId, agent: AccountId, guard_public_key: [u8; 32]) -> Self {
        Self {
            owner,
            agent,
            guard_public_key,
            frozen: false,
            mandates: BTreeMap::new(),
            used_nonces: BTreeSet::new(),
            pending: BTreeMap::new(),
            next_request_id: 1,
        }
    }

    fn only_owner(&self, caller: &str) -> Result<(), VaultError> {
        if caller == self.owner { Ok(()) } else { Err(VaultError::NotOwner) }
    }

    pub fn create_mandate(&mut self, caller: &str, id: String, m: Mandate) -> Result<(), VaultError> {
        self.only_owner(caller)?;
        if self.mandates.contains_key(&id) {
            return Err(VaultError::MandateExists);
        }
        if id.is_empty() || id.contains('|') || m.per_tx_max > m.budget || m.committed != 0 || m.revoked {
            return Err(VaultError::InvalidMandate);
        }
        self.mandates.insert(id, m);
        Ok(())
    }

    pub fn revoke_mandate(&mut self, caller: &str, id: &str) -> Result<(), VaultError> {
        self.only_owner(caller)?;
        let m = self.mandates.get_mut(id).ok_or(VaultError::NoMandate)?;
        m.revoked = true;
        Ok(())
    }

    pub fn set_frozen(&mut self, caller: &str, frozen: bool) -> Result<(), VaultError> {
        self.only_owner(caller)?;
        self.frozen = frozen;
        Ok(())
    }

    /// The only method the agent's function-call key may call.
    /// Checks run in a fixed order; the first failure is returned.
    pub fn request_payment(&mut self, env: &Env, r: PaymentRequest) -> Result<PaymentOutcome, VaultError> {
        if env.caller != self.agent {
            return Err(VaultError::NotAgent);
        }
        if self.frozen {
            return Err(VaultError::Frozen);
        }
        let m = self.mandates.get(&r.mandate_id).ok_or(VaultError::NoMandate)?;
        if m.revoked {
            return Err(VaultError::MandateRevoked);
        }
        if env.now_ms >= m.expires_at_ms {
            return Err(VaultError::MandateExpired);
        }
        if env.now_ms > r.expires_at_ms {
            return Err(VaultError::AuthorizationExpired);
        }
        if self.used_nonces.contains(&r.nonce) {
            return Err(VaultError::NonceUsed);
        }
        let msg = authorization_message(env.contract_id, &r);
        if r.signature.len() != 64 || !(env.verify)(&r.signature, msg.as_bytes(), &self.guard_public_key) {
            return Err(VaultError::BadSignature);
        }
        if !m.allowed_receivers.iter().any(|a| a == &r.receiver) {
            return Err(VaultError::ReceiverNotAllowed);
        }
        if r.amount == 0 || r.amount > m.per_tx_max {
            return Err(VaultError::PerTxLimit);
        }
        let new_committed = m.committed.checked_add(r.amount).ok_or(VaultError::BudgetExceeded)?;
        if new_committed > m.budget {
            return Err(VaultError::BudgetExceeded);
        }
        if r.amount > env.available_balance {
            return Err(VaultError::InsufficientBalance);
        }
        let needs_owner = m.onchain_approval_threshold > 0 && r.amount >= m.onchain_approval_threshold;

        // All checks passed: commit state before any transfer is scheduled.
        self.used_nonces.insert(r.nonce);
        self.mandates.get_mut(&r.mandate_id).expect("checked above").committed = new_committed;
        if needs_owner {
            let id = self.next_request_id;
            self.next_request_id += 1;
            self.pending.insert(id, PendingRequest { mandate_id: r.mandate_id, receiver: r.receiver, amount: r.amount, input_hash: r.input_hash });
            Ok(PaymentOutcome::Pending { request_id: id })
        } else {
            Ok(PaymentOutcome::Transfer { receiver: r.receiver, amount: r.amount })
        }
    }

    /// Owner approves a pending request. Freeze still applies.
    pub fn approve(&mut self, caller: &str, request_id: u64) -> Result<PaymentOutcome, VaultError> {
        self.only_owner(caller)?;
        if self.frozen {
            return Err(VaultError::Frozen);
        }
        let p = self.pending.remove(&request_id).ok_or(VaultError::NoPendingRequest)?;
        Ok(PaymentOutcome::Transfer { receiver: p.receiver, amount: p.amount })
    }

    /// Owner rejects a pending request; its amount returns to the mandate budget.
    pub fn reject(&mut self, caller: &str, request_id: u64) -> Result<(), VaultError> {
        self.only_owner(caller)?;
        let p = self.pending.remove(&request_id).ok_or(VaultError::NoPendingRequest)?;
        self.release(&p.mandate_id, p.amount);
        Ok(())
    }

    /// A scheduled transfer failed (e.g. the receiver does not exist): give the budget back.
    pub fn release(&mut self, mandate_id: &str, amount: Amount) {
        if let Some(m) = self.mandates.get_mut(mandate_id) {
            m.committed = m.committed.saturating_sub(amount);
        }
    }

    pub fn remaining(&self, mandate_id: &str) -> Option<Amount> {
        self.mandates.get(mandate_id).map(|m| m.budget.saturating_sub(m.committed))
    }
}

#[cfg(test)]
mod tests;
