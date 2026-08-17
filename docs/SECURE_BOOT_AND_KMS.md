# Secure Boot v2 & KMS Signing — Provisioning & Key-Management Runbook

This is the operator runbook for Vellum's Phase 3 hardening: moving firmware
signing to a cloud KMS/HSM (keyless from CI) and enabling ESP32-S3 Secure Boot v2

- Flash Encryption on production units. **The code is in the tree and inert until
  you provision the infrastructure and set the CI variables described here.**

> ⚠️ **This runbook contains one-way operations that permanently alter or brick
> hardware** (eFuse burns) and fleet-wide operations that can lock out devices
> (key rotation/revocation). Read a whole section before running any of it. Every
> irreversible step is marked **⚠️ IRREVERSIBLE**.

---

## 0. Two independent trust chains

Do not conflate them — they use different algorithms, keys, and verifiers.

|              | **① OTA app signature**                                             | **② Secure Boot v2**                             |
| ------------ | ------------------------------------------------------------------- | ------------------------------------------------ |
| Protects     | firmware delivered over the air                                     | what the ROM will boot at all                    |
| Algorithm    | Ed25519 (PureEdDSA) over the 32-byte app digest                     | RSA-3072-PSS over the image                      |
| Private key  | KMS (Ed25519)                                                       | KMS/HSM (RSA-3072)                               |
| Public half  | embedded `CONFIG_VELLUM_OTA_SIGNING_PUBKEY` + trust store           | digest burned to eFuse `SECURE_BOOT_DIGEST0/1/2` |
| Verified by  | `ota_manager.c` in software, before an image is made bootable       | ROM + bootloader at every boot                   |
| Failure mode | a bad key ⇒ fleet rejects updates (recoverable via the trust store) | a bad key ⇒ **bricked**, no recovery             |
| Status today | **live** (Ed25519 required, fail-closed)                            | **off** until you provision                      |

Chain ① is already enforced. Chain ② is opt-in and gated behind `SECURE=1`
builds; the default `make build` is unchanged (unsigned, reflashable). The
`testsecure` rung uses a local disposable RSA-3072 key (generated once under
`firmware/keys/` and ignored by Git), burns no eFuse, and must never establish
production trust.

---

## 1. Decisions you must make first

These are the open questions the code cannot answer for you. Decide them before
provisioning; they change the commands below.

1. **KMS provider.** Recommended: **Google Cloud KMS** — it natively supports both
   `EC_SIGN_ED25519` (pure EdDSA, raw 64-byte signature — exactly what the device
   verifies) and `RSA_SIGN_PSS_3072_SHA256` (Secure Boot), and ships an
   officially-maintained PKCS#11 module (`libkmsp11`). **AWS KMS** is an equally
   valid alternative (EdDSA via `ECC_NIST_EDWARDS25519` + `ED25519_SHA_512`/
   `MessageType=RAW` since Nov 2025; RSA-PSS for Secure Boot), but its Secure Boot
   PKCS#11 bridge is community-maintained. **Azure Key Vault is ruled out** — no
   Ed25519. Pick one; you set up GitHub OIDC once and it drives both keys.
2. **Import vs. mint the OTA key.** _Strongly prefer importing_ the existing
   Ed25519 key (`vellum-firmware-signing.key`) so the embedded pubkey stays valid
   and the migration is invisible to the fleet. Minting a fresh key forces a
   firmware rollout carrying the new pubkey _first_ (use the rotation runbook, §4).
3. **Flash Encryption?** Secure Boot v2 alone is one workstream; Flash Encryption
   RELEASE (the `prod` overlay) is a further, harsher one-way step that also gates
   NVS-at-rest encryption for the Wi-Fi PSK / device token / X25519 key. Decide
   whether production needs it, or Secure Boot only.
4. **Digest-slot allocation.** The SoC has **3** Secure Boot key-digest slots. How
   many do you provision at the factory (for rotation headroom) vs. revoke
   immediately? You can only _revoke_ in the field, never _add_.
5. **P4 (d1001).** The overlays here are S3/RSA-3072-specific. The ESP32-P4 has a
   different Secure Boot key scheme and is currently excluded from `SECURE=1`.
   Decide if/when it gets its own profile.

---

## 2. The build profiles (opt-in `SECURE=1`)

Three overlays chain on top of the per-model base, climbing a ladder. **Prove
each rung on a spare board before the next.** The default build is untouched.

| Profile      | `make` invocation                                             | What it enables                                                                      | Reversible?                                   |
| ------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------- |
| `testsecure` | `make build MODEL=<model> SECURE=1 SECURE_PROFILE=testsecure` | Software signature verification (`SECURE_SIGNED_APPS_NO_SECURE_BOOT`). **No eFuse.** | ✅ fully                                      |
| `secureboot` | `… SECURE_PROFILE=secureboot`                                 | Secure Boot v2 (RSA-3072). Flash-Enc OFF, ROM-DL open.                               | ⚠️ first eFuse burns; board stays reflashable |
| `prod`       | `… SECURE_PROFILE=prod`                                       | + Flash Encryption RELEASE + anti-rollback + NVS-enc.                                | ⚠️ **point of no return**                     |

All overlays set `CONFIG_SECURE_BOOT_BUILD_SIGNED_BINARIES=n` — **no private key
on the build host**; images are signed out-of-band by KMS. A `SECURE=1` build
produces an _unsigned_ image and prints a reminder to sign it before flashing.

**Partition layout.** A signed SB v2 bootloader measured **0x9000 bytes**, which
overflows the default 0x8000 partition-table offset. The `secureboot`/`prod`
overlays therefore switch to `partitions.secure.csv` (table at `0x10000`; `ota_0`
/ `ota_1` keep their original offsets, so the OTA image budget is unchanged).
**Changing partition offsets is factory-flash-only — it cannot be delivered by
OTA.** Re-measure with `idf.py bootloader` for your IDF/key and raise the offset
further if it still overflows. Fix this before provisioning any secure unit.

---

## 3. Part I — Migrate OTA (Ed25519) signing to KMS

Goal: CI signs OTA images with a KMS-held key via GitHub OIDC, with **no
long-lived secret**. Device-side verification is unchanged and byte-compatible.

### 3.1 Create/import the key (GCP shown; AWS notes inline)

**Preferred — import the existing key (invisible migration):**

```bash
# 1. keyring + import-only Ed25519 key
gcloud kms keyrings create fw --location global
gcloud kms keys create ota-ed25519 --keyring fw --location global \
  --purpose asymmetric-signing --default-algorithm ec-sign-ed25519 \
  --protection-level hsm --import-only
# 2. import job, wrap vellum-firmware-signing.key with its pubkey, import as v1
gcloud kms import-jobs create ota-import --keyring fw --location global \
  --import-method rsa-oaep-3072-sha256-aes-256 --protection-level hsm
gcloud kms keys versions import --key ota-ed25519 --keyring fw --location global \
  --import-job ota-import --algorithm ec-sign-ed25519 \
  --pem-to-wrap vellum-firmware-signing.key    # (wrap per gcloud import docs)
```

**Verify parity — this MUST match the embedded pubkey or the fleet rejects everything:**

```bash
gcloud kms keys versions get-public-key 1 --key ota-ed25519 --keyring fw \
  --location global --output-file kms_pub.pem
openssl pkey -pubin -in kms_pub.pem -pubout -outform DER | tail -c 32 | base64
# → must equal CONFIG_VELLUM_OTA_SIGNING_PUBKEY = sdY80/jyxvaEuXOHjs8qb5hyDdf3petsG+JjlSYZJmc=
```

**Alternative — mint a fresh key:** only if import is impossible. Then you must
ship firmware carrying the new pubkey in `VELLUM_OTA_SIGNING_PUBKEY_NEXT` _first_
(follow §4, not this section).

**AWS:** `aws kms create-key --key-spec ECC_NIST_EDWARDS25519 --key-usage
SIGN_VERIFY`; import via the AWS import flow; `aws kms get-public-key` returns DER
SPKI — take the last 32 bytes the same way.

### 3.2 GitHub OIDC (keyless) — no secret in the repo

```bash
# Workload Identity Federation pool + provider bound to GitHub's OIDC issuer
gcloud iam workload-identity-pools create gh --location global
gcloud iam workload-identity-pools providers create-oidc gh-oidc \
  --location global --workload-identity-pool gh \
  --issuer-uri https://token.actions.githubusercontent.com \
  --attribute-mapping 'google.subject=assertion.sub,attribute.repository=assertion.repository' \
  --attribute-condition 'assertion.repository=="metaneutrons/Vellum"'
# service account with sign-only rights on the key
gcloud iam service-accounts create fw-signer
gcloud kms keys add-iam-policy-binding ota-ed25519 --keyring fw --location global \
  --member serviceAccount:fw-signer@PROJ.iam.gserviceaccount.com \
  --role roles/cloudkms.signerVerifier
# let the GitHub repo impersonate the SA
gcloud iam service-accounts add-iam-policy-binding fw-signer@PROJ.iam.gserviceaccount.com \
  --role roles/iam.workloadIdentityUser \
  --member 'principalSet://iam.googleapis.com/projects/NUM/locations/global/workloadIdentityPools/gh/attribute.repository/metaneutrons/Vellum'
```

Scope the attribute condition to `metaneutrons/Vellum` (and, for signing jobs,
`refs/tags/*`) so no other repo/branch can mint a token that signs firmware.

### 3.3 Flip CI to KMS

The `sign-and-release` job in `.github/workflows/firmware.yml` prefers KMS when
the repo **variable** `OTA_KMS_KEY_VERSION` is set, and falls back to the legacy
`FIRMWARE_SIGNING_KEY` secret otherwise (so nothing breaks before you cut over).
All **three** KMS variables below must be set together — the OIDC auth step reads
the provider and service account, and the sign step reads the key version:

```bash
gh variable set OTA_KMS_KEY_VERSION \
  --body 'projects/PROJ/locations/global/keyRings/fw/cryptoKeys/ota-ed25519/cryptoKeyVersions/1'
gh variable set OTA_KMS_WIF_PROVIDER \
  --body 'projects/NUM/locations/global/workloadIdentityPools/gh/providers/gh-oidc'
gh variable set OTA_KMS_SERVICE_ACCOUNT \
  --body 'fw-signer@PROJ.iam.gserviceaccount.com'
```

The manifest's `otaKeyId` is **derived automatically** from whichever embedded
Kconfig key (`VELLUM_OTA_SIGNING_KEY_ID` / `…_KEY_ID_NEXT`) the signer's public
key matches — no separate variable, and it stays correct mid-rotation.

Cut over: run a **beta** release, confirm the CI "Verify signatures (pure Ed25519
roundtrip)" step passes and a real device takes the update, then delete the old
secret: `gh secret delete FIRMWARE_SIGNING_KEY`.

### 3.4 Byte-compatibility acceptance (must pass before any stable release)

- Signed message = the **32-byte appended app digest** — the "Validation hash" from
  `esptool image-info vellum-<model>-v*.bin`, identical to on-device
  `esp_partition_get_sha256`. CI reads it via `esptool image-info` (NOT `tail -c 32`)
  so the value comes from the end of the app image even when a Secure Boot signature
  block trails it. Never `sha256sum` of the whole file; never the factory image.
- KMS returns a **raw 64-byte** `r||s` signature (GCP `EC_SIGN_ED25519` and AWS
  `ED25519_SHA_512`/`RAW` both do). If a provider ever returns DER, unwrap to raw
  before base64 — the device rejects DER.
- **Pure** Ed25519, not Ed25519ph. AWS `MessageType=DIGEST` (`ED25519_PH_SHA_512`)
  is pre-hash and verify-**fails** on device. The CI `openssl pkeyutl -verify
-rawin` roundtrip + the 64-byte length assert are the gate.

---

## 4. Part II — OTA key rotation & revocation (Ed25519 trust store)

The device trust store (`components/ota_manager/ota_trust_keys.h`) holds a
**primary** key plus a reserved **next** slot, and honors a revocation list
(`CONFIG_VELLUM_OTA_REVOKED_KEY_IDS`). A signature is accepted if it validates
under _any_ non-revoked trusted key. This makes rotation a 3-generation overlap
with **no hard cutover**.

### 4.1 Planned rotation

1. **Gen N — introduce.** Create the successor KMS key (`ota-ed25519-v2`); export
   its raw-32 pubkey. Set `CONFIG_VELLUM_OTA_SIGNING_PUBKEY_NEXT` = that pubkey
   and `…_KEY_ID_NEXT` = its id. **Keep signing with the OLD key.** Ship N →
   devices now trust `{old, new}` but still receive old-signed images.
2. **Wait for adoption.** Let N reach effectively the whole fleet (watch
   `ota_events` / rollout). Only devices ≥ N will accept new-key signatures.
3. **Gen N+1 — switch signer.** Repoint `OTA_KMS_KEY_VERSION` to the new key
   version. Firmware N+1 is signed by it; N devices accept it (they trust both).
   The CI pubkey guard accepts a match against _either_ embedded slot, and
   `otaKeyId` auto-resolves to the `…_KEY_ID_NEXT` you set in step 1.
4. **Gen N+2 — retire.** Promote the new pubkey to `…_SIGNING_PUBKEY` (primary),
   clear `…_PUBKEY_NEXT`, add the old id to `…_REVOKED_KEY_IDS`. Ship N+2. In KMS,
   `disable` the old version (later `destroy`).

> **Golden rule:** never retire a key in the same generation you switch to its
> successor. Always keep a populated `next` slot so an emergency hotfix can be
> signed by a key every device already trusts.

### 4.2 Emergency revocation (compromised key)

1. **KMS:** `gcloud kms keys versions disable <compromised>` (AWS: `disable-key`)
   so CI can no longer sign with it.
2. **Sign a hotfix with a DIFFERENT still-trusted key** — this is why the `next`
   slot exists.
3. In that hotfix, add the compromised id to `CONFIG_VELLUM_OTA_REVOKED_KEY_IDS`
   and bump the version. Devices that install it stop accepting the bad key.
4. Publish + force rollout (operator pin / 100%). Track uptake via `ota_events`.
   There is **no server-side recovery** for a fail-closed device that only trusts
   the compromised key — which is the whole argument for always shipping
   primary + next.

---

## 5. Part III — Secure Boot v2 provisioning ladder

> ⚠️ Everything from Phase B down burns eFuses. Run `espefuse.py summary` and
> archive it before every burn. Use spare/sacrificial boards until Phase C.

### Phase A — Prove the chain with ZERO burns (spare board, reversible)

1. Build the software-verify profile: `make build MODEL=<model> SECURE=1
SECURE_PROFILE=testsecure` (`d1001`, `e1001`, `e1002`, or `e1003`). The Makefile creates a persistent, local,
   git-ignored `keys/testsecure_signing_key.pem` when absent and ESP-IDF signs
   the bootloader/app automatically. No eFuse is written.
2. Flash the complete factory image over USB. In the device detail view, verify
   the three observed gates: authenticated enrollment, `testsecure` firmware,
   and `HMAC verified`. Existing enrolled NVS is sealed on first testsecure boot;
   fresh devices are sealed as part of persisting their enrollment lock. A power
   loss during a multi-key update fails closed because ESP-IDF NVS does not offer
   multi-key transactions.
3. Confirm a deliberate protected-NVS mutation blocks networking with
   `Configuration protected`, then factory-reset and re-enroll. Confirm a normal
   full USB flash/factory reset returns the board to the development profile.
4. Separately create and validate the production Secure Boot RSA-3072 key in the
   HSM. Never reuse or import the disposable testsecure key.
5. **Invariant check:** confirm the OTA Ed25519 path still works after the RSA-PSS
   block is appended — do a full OTA and confirm the device `otaSha256` still equals
   the CI digest. CI derives that digest from the appended app "Validation hash"
   (`esptool image-info`), read from the end of the app image (before the SB block,
   at the dynamic `image_len − 32` offset), so the
   Ed25519/otaSha256 contract holds whether the block is appended before or after
   signing — no ordering dependency. When `OTA_SECURE_BOOT=1` (opt-in; **OFF in
   dev**), `firmware.yml` performs this RSA-PSS append itself (gated on
   `firmware/hsm_config.ini`) and the partition-fit guard switches to
   `partitions.secure.csv`; otherwise CI publishes the app-only image and never
   RSA-signs. This CI leg is unexercised while SB is off — validate it on a
   `secureboot` board (Phase B.5) before enabling it for a fleet.
6. **Bootloader fit:** `idf.py bootloader` with the `secureboot` overlay — confirm
   it is below the `partitions.secure.csv` table offset (0x10000). If it overflows,
   raise `CONFIG_PARTITION_TABLE_OFFSET` **now** (factory-flash-only later).

### Phase B — Reflashable Secure Boot (⚠️ first burns; sacrificial board)

1. **Pre-sign the factory bootloader with ALL keys the fleet will ever trust**
   (up to 3): `espsecure.py sign_data --version 2 --hsm …` then
   `--append_signatures` for keys 2 and 3. You can never add a key to a fielded
   unit — only revoke. With Secure Boot on (non-insecure), the app also **revokes
   unused digest slots at startup**, so provisioning all intended keys up front is
   mandatory for any future rotation headroom.
2. **⚠️ IRREVERSIBLE — burn the digest(s):** `espefuse.py burn_key_digest …
SECURE_BOOT_DIGEST0/1/2`. **Never read-protect these blocks** — the digest must
   stay software-readable or the device is permanently unbootable.
3. Build + flash the `secureboot` profile (Flash-Enc OFF, ROM-DL open → still
   reflashable): `make build MODEL=e1002 SECURE=1 SECURE_PROFILE=secureboot`, sign,
   flash.
4. **⚠️ IRREVERSIBLE:** on first boot the bootloader burns `SECURE_BOOT_EN`. Do
   **not** interrupt power. Confirm with `espefuse.py summary`.
5. Run a **full OTA cycle end-to-end** (config → download → SHA → Ed25519 → SB
   RSA-PSS → `mark_valid`) and a rollback on this board before Phase C.

### Phase C — Production seal (⚠️ POINT OF NO RETURN)

1. `SECURE_PROFILE=prod` (adds Flash Encryption RELEASE + NVS-enc + anti-rollback).
   Final units only, after A/B pass. No undo, no UART recovery afterward.
2. **⚠️ IRREVERSIBLE cluster on first prod boot:** `SPI_BOOT_CRYPT_CNT` (flash-enc),
   the XTS-AES key block, `DIS_DOWNLOAD_MANUAL_ENCRYPT`, and (if configured)
   `SECURE_DISABLE_ROM_DL_MODE`. **Do not power-interrupt the first-boot encryption
   pass** — it corrupts flash and bricks the unit.
3. **⚠️ IRREVERSIBLE:** burn `SECURE_BOOT_KEY_REVOKE` for every unused digest slot
   you are _not_ reserving for rotation. Keep at least one slot reserved if you
   want in-field rotation headroom.
4. **Anti-rollback:** advance `CONFIG_BOOTLOADER_APP_SECURE_VERSION` in lockstep
   with releases (coordinate with the release-please version anchor). A signed-but-
   older image is then refused by the eFuse secure-version counter. An over-eager
   bump blocks/bricks devices.
5. Archive `espefuse.py summary` per unit/serial. Ship.

---

## 6. Part IV — Secure Boot key rotation & revocation (3-slot hardware)

- Rotation is only possible if the factory bootloader was **pre-signed** with the
  incoming key (Phase B.1). You cannot add a trusted key to a fielded unit.
- To rotate: create the new KMS RSA key/version, sign new app images with it (CI
  KMS leg), ship via normal OTA (devices already trust the pre-burned digest).
- Once the fleet runs images signed by the new key, **⚠️ IRREVERSIBLY** revoke the
  old slot on-device: `esp_ota_revoke_secure_boot_public_key()` from the running
  app (preferred, controlled) or `espefuse.py burn_efuse SECURE_BOOT_KEY_REVOKE<n>`.
  **Never revoke the slot the device is currently booting from.**
- Keep `SECURE_BOOT_ENABLE_AGGRESSIVE_KEY_REVOKE` **off** in production unless
  physical-attack resistance outweighs brick risk — it revokes on _any_ verify
  failure and can burn through all 3 slots.
- **RSA-PSS parameters:** confirm the KMS/PKCS#11 provider does `CKM_RSA_PKCS_PSS`
  with SHA-256 and salt length 32. A mismatch produces a signature the ROM rejects
  → a secure device that won't boot with no UART recovery. Always `espsecure.py
verify_signature` before flashing; validate the `--hsm` flow with a local YubiKey
  first to isolate provider bugs.

---

## 7. Point-of-no-return checklist

Before any eFuse burn on a unit you care about, confirm **all**:

- [ ] `testsecure` proven: signed image boots, corrupted signature rejected.
- [ ] OTA Ed25519 invariant holds after the SB block is appended (Phase A.4).
- [ ] Signed bootloader fits `partitions.secure.csv` (Phase A.5).
- [ ] Bootloader pre-signed with **all** intended rotation keys (Phase B.1).
- [ ] Digest blocks burned **without** read-protection.
- [ ] Full OTA + rollback survived on a `secureboot` board (Phase B.5).
- [ ] Flash-encryption decision made deliberately (§1.3).
- [ ] Anti-rollback secure-version plan aligned with release versioning.
- [ ] Public keys + eFuse digests exported and committed (`keys/*.pub`,
      `keys/*digest*.bin`) — a KMS key deletion must not orphan the fleet.
- [ ] Per-unit `espefuse.py summary` archived.

---

## 8. Reference — files & symbols

| Path                                               | Role                                                    |
| -------------------------------------------------- | ------------------------------------------------------- |
| `firmware/components/ota_manager/ota_trust_keys.h` | on-device Ed25519 trust store (primary + next)          |
| `firmware/components/ota_manager/ota_manager.c`    | `verify_ota_signature()` — multi-key verify             |
| `firmware/main/Kconfig.projbuild`                  | `VELLUM_OTA_SIGNING_*` / `…_NEXT` / `…_REVOKED_KEY_IDS` |
| `firmware/sdkconfig.defaults.testsecure`           | rung 1 — software verify, no eFuse                      |
| `firmware/sdkconfig.defaults.secureboot`           | rung 2 — Secure Boot v2, reflashable                    |
| `firmware/sdkconfig.defaults.prod`                 | rung 3 — + Flash-Enc RELEASE + anti-rollback            |
| `firmware/partitions.secure.csv`                   | secure partition layout (table @ 0x10000)               |
| `firmware/keys/README.md`                          | key-custody rules; committed = public only              |
| `firmware/hsm_config.ini.example`                  | PKCS#11 template for `espsecure --hsm`                  |
| `.github/workflows/firmware.yml`                   | `sign-and-release` — KMS-preferred, secret fallback     |

CI variables (set all three together to activate KMS): `OTA_KMS_KEY_VERSION`,
`OTA_KMS_WIF_PROVIDER`, `OTA_KMS_SERVICE_ACCOUNT`. The manifest `otaKeyId` is
derived from the embedded Kconfig key id — no variable for it.
