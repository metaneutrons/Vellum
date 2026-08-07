# Changelog

> Firmware history before the `firmware-v1.2.0` release-please anchor — including Improv/USB-serial provisioning and the E1001/E1003/D1001 panel drivers — is recorded in the root [`CHANGELOG.md`](../CHANGELOG.md); this file baselines at the anchor, so the sparse early history here is expected release-please behavior, not "firmware-v1.2.x shipped no features".

## [1.2.6](https://github.com/metaneutrons/Vellum/compare/firmware-v1.2.5...firmware-v1.2.6) (2026-08-07)


### Bug Fixes

* **firmware:** support E1003 USB-C provisioning ([#119](https://github.com/metaneutrons/Vellum/issues/119)) ([2994990](https://github.com/metaneutrons/Vellum/commit/2994990dcdeb36156411dbba8fe900d2afdaba15))

## [1.2.5](https://github.com/metaneutrons/Vellum/compare/firmware-v1.2.4...firmware-v1.2.5) (2026-07-22)


### Bug Fixes

* **firmware:** unbreak E1003 USB serial provisioning ([#111](https://github.com/metaneutrons/Vellum/issues/111)) ([2e3aab3](https://github.com/metaneutrons/Vellum/commit/2e3aab3e6704bcb37a7ad6386100c66b0d6b5e86))

## [1.2.4](https://github.com/metaneutrons/Vellum/compare/firmware-v1.2.3...firmware-v1.2.4) (2026-07-21)


### Bug Fixes

* **firmware:** recover E1003 from false low battery ([#109](https://github.com/metaneutrons/Vellum/issues/109)) ([3dd8039](https://github.com/metaneutrons/Vellum/commit/3dd8039c824cade546c81da324ffff819399b7d3))

## [1.2.3](https://github.com/metaneutrons/Vellum/compare/firmware-v1.2.2...firmware-v1.2.3) (2026-07-17)


### Bug Fixes

* avoid LCD reboot loop while battery is critical ([2979d6d](https://github.com/metaneutrons/Vellum/commit/2979d6d2b80e93f3802c4f5e2daec5d903c8bd4a))
* clear stale low-battery screen after charging ([847a235](https://github.com/metaneutrons/Vellum/commit/847a235d4ec91ba5f392f858d9e202ea0cf817b7))
* **firmware:** route S3 console to USB-Serial-JTAG so Improv provisioning works ([4a6a5b2](https://github.com/metaneutrons/Vellum/commit/4a6a5b2802ed3f9591744cf198503c5b48af8cb2))
* **firmware:** route S3 console to USB-Serial-JTAG so Improv provisioning works ([5b20ab1](https://github.com/metaneutrons/Vellum/commit/5b20ab1d645d68780a13aab8a8b2223b17d424ff))
* hide empty visit-device redirect ([5efc516](https://github.com/metaneutrons/Vellum/commit/5efc516d3e4adf3dbc4f14554332d0ddb93420d7))
* omit empty device redirect after provisioning ([d696e14](https://github.com/metaneutrons/Vellum/commit/d696e14b82de1e184887d9ac89c6a3b454be7a0a))
* preserve stored redirect after reprovisioning ([fcdcdce](https://github.com/metaneutrons/Vellum/commit/fcdcdce5fa6687055f1a2586d36852a89cf13dbc))
* recheck critically low battery after sleep ([1250704](https://github.com/metaneutrons/Vellum/commit/1250704510c161fddd226f3b771160be8502a8ca))

## [1.2.2](https://github.com/metaneutrons/Vellum/compare/firmware-v1.2.1...firmware-v1.2.2) (2026-07-15)


### Bug Fixes

* **firmware:** D1001 (ESP32-P4) boots past the battery gate; add P4 CI coverage ([#95](https://github.com/metaneutrons/Vellum/issues/95)) ([a40ab71](https://github.com/metaneutrons/Vellum/commit/a40ab7140a1169caff3c2fc866ba230e2a800b44))

## [1.2.1](https://github.com/metaneutrons/Vellum/compare/firmware-v1.2.0...firmware-v1.2.1) (2026-07-14)


### Bug Fixes

* **firmware:** drop always-false url_len clamp that broke the release build ([#82](https://github.com/metaneutrons/Vellum/issues/82)) ([da26c8c](https://github.com/metaneutrons/Vellum/commit/da26c8cf617cad678eccc8a020e7de0303d36d9b))
