use super::*;

const NEAR: Amount = 1_000_000_000_000_000_000_000_000;
const CONTRACT: &str = "vault.agentguard.testnet";
const KEY: [u8; 32] = [7u8; 32];

/// Test-only stand-in for ed25519: a 64-byte FNV-style digest of (key, message).
/// It checks the WIRING (the signature must cover the exact message); real
/// ed25519 is `env::ed25519_verify` in the contract.
fn mock_sign(msg: &[u8], key: &[u8; 32]) -> Vec<u8> {
    let mut out = vec![0u8; 64];
    let mut h: u64 = 0xcbf29ce484222325;
    for (i, b) in key.iter().chain(msg.iter()).enumerate() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
        out[i % 64] ^= (h >> 24) as u8;
    }
    out
}

fn mock_verify(sig: &[u8], msg: &[u8], key: &[u8; 32]) -> bool {
    sig == mock_sign(msg, key).as_slice()
}

fn vault() -> VaultState {
    let mut v = VaultState::new("owner.testnet".into(), "agent.testnet".into(), KEY);
    v.create_mandate(
        "owner.testnet",
        "m1".into(),
        Mandate {
            budget: 3 * NEAR,
            per_tx_max: NEAR,
            expires_at_ms: 2_000_000,
            allowed_receivers: vec!["weather-api.testnet".into()],
            onchain_approval_threshold: 0,
            committed: 0,
            revoked: false,
        },
    )
    .unwrap();
    v
}

fn env<'a>(caller: &'a str, verify: &'a dyn Fn(&[u8], &[u8], &[u8; 32]) -> bool) -> Env<'a> {
    Env { caller, contract_id: CONTRACT, now_ms: 1_000_000, available_balance: 100 * NEAR, verify }
}

fn signed(nonce: u64, amount: Amount, receiver: &str) -> PaymentRequest {
    let mut r = PaymentRequest {
        mandate_id: "m1".into(),
        receiver: receiver.into(),
        amount,
        nonce,
        expires_at_ms: 1_100_000,
        input_hash: format!("{:064x}", nonce),
        signature: vec![],
    };
    r.signature = mock_sign(authorization_message(CONTRACT, &r).as_bytes(), &KEY);
    r
}

#[test]
fn valid_request_transfers() {
    let mut v = vault();
    let out = v.request_payment(&env("agent.testnet", &mock_verify), signed(1, NEAR / 5, "weather-api.testnet")).unwrap();
    assert_eq!(out, PaymentOutcome::Transfer { receiver: "weather-api.testnet".into(), amount: NEAR / 5 });
    assert_eq!(v.remaining("m1"), Some(3 * NEAR - NEAR / 5));
}

#[test]
fn only_agent_can_request() {
    let mut v = vault();
    let e = v.request_payment(&env("someone.testnet", &mock_verify), signed(1, NEAR / 5, "weather-api.testnet"));
    assert_eq!(e, Err(VaultError::NotAgent));
}

#[test]
fn missing_or_forged_signature_is_rejected() {
    // Scenario 9: the agent skips AgentGuard and calls the contract directly.
    let mut v = vault();
    let mut r = signed(1, NEAR / 5, "weather-api.testnet");
    r.signature = vec![0u8; 64];
    assert_eq!(v.request_payment(&env("agent.testnet", &mock_verify), r), Err(VaultError::BadSignature));
    // A real signature for 0.2 NEAR cannot be reused for 0.9 NEAR.
    let mut r = signed(2, NEAR / 5, "weather-api.testnet");
    r.amount = NEAR * 9 / 10;
    assert_eq!(v.request_payment(&env("agent.testnet", &mock_verify), r), Err(VaultError::BadSignature));
    // ...nor redirected to another receiver.
    let mut v = vault();
    v.mandates.get_mut("m1").unwrap().allowed_receivers.push("drain.testnet".into());
    let mut r = signed(3, NEAR / 5, "weather-api.testnet");
    r.receiver = "drain.testnet".into();
    assert_eq!(v.request_payment(&env("agent.testnet", &mock_verify), r), Err(VaultError::BadSignature));
}

#[test]
fn nonce_cannot_be_replayed() {
    // Scenario 10.
    let mut v = vault();
    let e = env("agent.testnet", &mock_verify);
    v.request_payment(&e, signed(5, NEAR / 5, "weather-api.testnet")).unwrap();
    assert_eq!(v.request_payment(&e, signed(5, NEAR / 5, "weather-api.testnet")), Err(VaultError::NonceUsed));
}

#[test]
fn expired_authorization_is_rejected() {
    let mut v = vault();
    let mut e = env("agent.testnet", &mock_verify);
    e.now_ms = 1_100_001;
    assert_eq!(v.request_payment(&e, signed(1, NEAR / 5, "weather-api.testnet")), Err(VaultError::AuthorizationExpired));
}

#[test]
fn budget_is_exact_even_if_every_request_is_signed() {
    // Scenario 5: AgentGuard is compromised and signs four 0.8 NEAR payments
    // against a 3 NEAR budget. The vault pays three and refuses the fourth.
    let mut v = vault();
    let e = env("agent.testnet", &mock_verify);
    let amt = NEAR * 8 / 10;
    for n in 1..=3 {
        assert!(v.request_payment(&e, signed(n, amt, "weather-api.testnet")).is_ok());
    }
    assert_eq!(v.request_payment(&e, signed(4, amt, "weather-api.testnet")), Err(VaultError::BudgetExceeded));
    assert_eq!(v.remaining("m1"), Some(3 * NEAR - 3 * amt));
}

#[test]
fn per_tx_limit_and_receiver_list_hold_with_valid_signature() {
    let mut v = vault();
    let e = env("agent.testnet", &mock_verify);
    assert_eq!(v.request_payment(&e, signed(1, NEAR + 1, "weather-api.testnet")), Err(VaultError::PerTxLimit));
    assert_eq!(v.request_payment(&e, signed(2, NEAR / 5, "drain.testnet")), Err(VaultError::ReceiverNotAllowed));
}

#[test]
fn freeze_stops_everything_including_approvals() {
    // Scenario 12.
    let mut v = vault();
    v.mandates.get_mut("m1").unwrap().onchain_approval_threshold = NEAR / 2;
    let e = env("agent.testnet", &mock_verify);
    let pending = v.request_payment(&e, signed(1, NEAR * 6 / 10, "weather-api.testnet")).unwrap();
    let PaymentOutcome::Pending { request_id } = pending else { panic!("expected pending") };
    v.set_frozen("owner.testnet", true).unwrap();
    assert_eq!(v.request_payment(&e, signed(2, NEAR / 5, "weather-api.testnet")), Err(VaultError::Frozen));
    assert_eq!(v.approve("owner.testnet", request_id), Err(VaultError::Frozen));
    assert_eq!(v.set_frozen("agent.testnet", false), Err(VaultError::NotOwner));
}

#[test]
fn pending_approval_and_rejection_restore_budget() {
    let mut v = vault();
    v.mandates.get_mut("m1").unwrap().onchain_approval_threshold = NEAR / 2;
    let e = env("agent.testnet", &mock_verify);
    let PaymentOutcome::Pending { request_id } = v.request_payment(&e, signed(1, NEAR, "weather-api.testnet")).unwrap() else { panic!() };
    assert_eq!(v.remaining("m1"), Some(2 * NEAR), "pending amount is held");
    v.reject("owner.testnet", request_id).unwrap();
    assert_eq!(v.remaining("m1"), Some(3 * NEAR));
    let PaymentOutcome::Pending { request_id } = v.request_payment(&e, signed(2, NEAR, "weather-api.testnet")).unwrap() else { panic!() };
    assert_eq!(v.approve("agent.testnet", request_id), Err(VaultError::NotOwner));
    assert!(matches!(v.approve("owner.testnet", request_id), Ok(PaymentOutcome::Transfer { .. })));
    assert_eq!(v.approve("owner.testnet", request_id), Err(VaultError::NoPendingRequest));
}

#[test]
fn failed_transfer_releases_budget() {
    let mut v = vault();
    let e = env("agent.testnet", &mock_verify);
    v.request_payment(&e, signed(1, NEAR, "weather-api.testnet")).unwrap();
    v.release("m1", NEAR);
    assert_eq!(v.remaining("m1"), Some(3 * NEAR));
}

#[test]
fn revoked_and_expired_mandates() {
    let mut v = vault();
    let mut e = env("agent.testnet", &mock_verify);
    e.now_ms = 2_000_000;
    assert_eq!(v.request_payment(&e, signed(1, NEAR / 5, "weather-api.testnet")), Err(VaultError::MandateExpired));
    v.revoke_mandate("owner.testnet", "m1").unwrap();
    assert_eq!(v.request_payment(&env("agent.testnet", &mock_verify), signed(2, NEAR / 5, "weather-api.testnet")), Err(VaultError::MandateRevoked));
}

#[test]
fn insufficient_balance() {
    let mut v = vault();
    let mut e = env("agent.testnet", &mock_verify);
    e.available_balance = NEAR / 10;
    assert_eq!(v.request_payment(&e, signed(1, NEAR / 5, "weather-api.testnet")), Err(VaultError::InsufficientBalance));
}

#[test]
fn invalid_mandates_are_refused() {
    let mut v = vault();
    let bad = Mandate { budget: NEAR, per_tx_max: 2 * NEAR, expires_at_ms: 1, allowed_receivers: vec![], onchain_approval_threshold: 0, committed: 0, revoked: false };
    assert_eq!(v.create_mandate("owner.testnet", "m2".into(), bad.clone()), Err(VaultError::InvalidMandate));
    assert_eq!(v.create_mandate("agent.testnet", "m2".into(), bad), Err(VaultError::NotOwner));
}

/// The message format is shared with TypeScript. These vectors are produced
/// by `packages/guard` (see contracts/test-vectors.json) and must match.
#[test]
fn message_format_matches_typescript_vectors() {
    // Minimal field extraction so this crate stays dependency-free.
    fn field<'a>(block: &'a str, key: &str) -> &'a str {
        let pat = format!("\"{key}\":");
        let rest = block.split(&pat).nth(1).unwrap_or_else(|| panic!("missing {key}")).trim_start();
        let rest = rest.strip_prefix('"').unwrap_or(rest);
        rest.split(|c| c == '"' || c == ',' || c == '\n' || c == '}').next().unwrap().trim()
    }
    let raw = include_str!("../../test-vectors.json");
    let mut checked = 0;
    for block in raw.split("\"contract_id\":").skip(1) {
        let block = format!("\"contract_id\":{block}");
        let r = PaymentRequest {
            mandate_id: field(&block, "mandate_id").into(),
            receiver: field(&block, "receiver").into(),
            amount: field(&block, "amount_yocto").parse().unwrap(),
            nonce: field(&block, "nonce").parse().unwrap(),
            expires_at_ms: field(&block, "expires_at_ms").parse().unwrap(),
            input_hash: field(&block, "input_hash").into(),
            signature: vec![],
        };
        assert_eq!(authorization_message(field(&block, "contract_id"), &r), field(&block, "message"));
        checked += 1;
    }
    assert!(checked >= 2, "expected test vectors, found {checked}");
}
