# Changelog

> Firmware history before the `firmware-v1.2.0` release-please anchor — including Improv/USB-serial provisioning and the E1001/E1003/D1001 panel drivers — is recorded in the root [`CHANGELOG.md`](../CHANGELOG.md); this file baselines at the anchor, so the sparse early history here is expected release-please behavior, not "firmware-v1.2.x shipped no features".

## [1.2.11](https://github.com/metaneutrons/Vellum/compare/firmware-v1.2.10...firmware-v1.2.11) (2026-08-10)


### Bug Fixes

* **firmware:** restore D1001 release builds ([#144](https://github.com/metaneutrons/Vellum/issues/144)) ([17a0e0e](https://github.com/metaneutrons/Vellum/commit/17a0e0e82daf8a2ef8be29e27238e0e4e9c011f2))

## [1.2.10](https://github.com/metaneutrons/Vellum/compare/firmware-v1.2.9...firmware-v1.2.10) (2026-08-10)


### Bug Fixes

* harden firmware connectivity and USB refresh ([#142](https://github.com/metaneutrons/Vellum/issues/142)) ([d049f0f](https://github.com/metaneutrons/Vellum/commit/d049f0f4a3d87edb215d3a44dba8302d968350e1))

## [1.2.9](https://github.com/metaneutrons/Vellum/compare/firmware-v1.2.8...firmware-v1.2.9) (2026-08-10)


### Bug Fixes

* keep USB-powered displays awake ([4c6e3c7](https://github.com/metaneutrons/Vellum/commit/4c6e3c7fc4226b5c7facd9dd8b80fc6b698e85ec))
* keep USB-powered displays awake ([f7820f9](https://github.com/metaneutrons/Vellum/commit/f7820f99636d464ea8b7c88feb4cc20077bc3a1f))

## [1.2.8](https://github.com/metaneutrons/Vellum/compare/firmware-v1.2.7...firmware-v1.2.8) (2026-08-09)


### Bug Fixes

* **firmware:** make E1002 USB provisioning reliable ([#126](https://github.com/metaneutrons/Vellum/issues/126)) ([4a3ccef](https://github.com/metaneutrons/Vellum/commit/4a3ccefaf116f1fcb639719900ce55b0851d6280))
* wake sleeping displays during USB provisioning ([#135](https://github.com/metaneutrons/Vellum/issues/135)) ([aee7b04](https://github.com/metaneutrons/Vellum/commit/aee7b046e0cb17d5a65bcba323f92a96f4b2ead3))

## [1.2.7](https://github.com/metaneutrons/Vellum/compare/firmware-v1.2.6...firmware-v1.2.7) (2026-08-07)


### Bug Fixes

* **firmware:** make E1003 OTA updates reliable ([#122](https://github.com/metaneutrons/Vellum/issues/122)) ([72f7552](https://github.com/metaneutrons/Vellum/commit/72f7552b1e967ccec8468eedb8adbb7056c99518))

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
