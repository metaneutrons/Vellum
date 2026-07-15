# Changelog

> Firmware history before the `firmware-v1.2.0` release-please anchor — including Improv/USB-serial provisioning and the E1001/E1003/D1001 panel drivers — is recorded in the root [`CHANGELOG.md`](../CHANGELOG.md); this file baselines at the anchor, so the sparse early history here is expected release-please behavior, not "firmware-v1.2.x shipped no features".

## [1.2.2](https://github.com/metaneutrons/Vellum/compare/firmware-v1.2.1...firmware-v1.2.2) (2026-07-15)


### Bug Fixes

* **firmware:** D1001 (ESP32-P4) boots past the battery gate; add P4 CI coverage ([#95](https://github.com/metaneutrons/Vellum/issues/95)) ([a40ab71](https://github.com/metaneutrons/Vellum/commit/a40ab7140a1169caff3c2fc866ba230e2a800b44))

## [1.2.1](https://github.com/metaneutrons/Vellum/compare/firmware-v1.2.0...firmware-v1.2.1) (2026-07-14)


### Bug Fixes

* **firmware:** drop always-false url_len clamp that broke the release build ([#82](https://github.com/metaneutrons/Vellum/issues/82)) ([da26c8c](https://github.com/metaneutrons/Vellum/commit/da26c8cf617cad678eccc8a020e7de0303d36d9b))
