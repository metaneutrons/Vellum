# Changelog

> Firmware history before the `firmware-v1.2.0` release-please anchor — including Improv/USB-serial provisioning and the E1001/E1003/D1001 panel drivers — is recorded in the root [`CHANGELOG.md`](../CHANGELOG.md); this file baselines at the anchor, so the sparse early history here is expected release-please behavior, not "firmware-v1.2.x shipped no features".

## [1.4.4](https://github.com/metaneutrons/Vellum/compare/firmware-v1.4.3...firmware-v1.4.4) (2026-08-15)


### Bug Fixes

* **firmware:** stabilize D1001 audio and release lifecycle ([89e8467](https://github.com/metaneutrons/Vellum/commit/89e84675e303dd0472b7439b59f32916e2a38439))
* **firmware:** stabilize D1001 audio playback ([b22e4da](https://github.com/metaneutrons/Vellum/commit/b22e4da578a1f77ef168930bf0577ab2d1e4b5ee))

## [1.4.3](https://github.com/metaneutrons/Vellum/compare/firmware-v1.4.2...firmware-v1.4.3) (2026-08-15)


### Bug Fixes

* **firmware:** prevent D1001 OTA progress underruns ([2028a59](https://github.com/metaneutrons/Vellum/commit/2028a59b8b86f5c101a03217051be9bd0039ddea))
* **firmware:** prevent D1001 OTA progress underruns ([bf52ad3](https://github.com/metaneutrons/Vellum/commit/bf52ad38f1166c12dfdf52aee7709788fd783c0b))

## [1.4.2](https://github.com/metaneutrons/Vellum/compare/firmware-v1.4.1...firmware-v1.4.2) (2026-08-14)


### Bug Fixes

* harden updater and USB provisioning UX ([b2adee4](https://github.com/metaneutrons/Vellum/commit/b2adee44f813e3074cc4b150208696574315c3bd))
* **provisioning:** keep USB sessions connected ([5fca838](https://github.com/metaneutrons/Vellum/commit/5fca838abdc18807cdccfacd913a36cf05240865))

## [1.4.1](https://github.com/metaneutrons/Vellum/compare/firmware-v1.4.0...firmware-v1.4.1) (2026-08-13)


### Bug Fixes

* **firmware:** acknowledge D1001 refresh presses ([#202](https://github.com/metaneutrons/Vellum/issues/202)) ([5e22e4c](https://github.com/metaneutrons/Vellum/commit/5e22e4cdc7cca35d80ce7b942749d8a1390c9d0c))
* **firmware:** stabilize status screens and USB Wi-Fi scans ([#199](https://github.com/metaneutrons/Vellum/issues/199)) ([87ab4c1](https://github.com/metaneutrons/Vellum/commit/87ab4c1e5395600032ad7689d1eac7ca06c091f7))

## [1.4.0](https://github.com/metaneutrons/Vellum/compare/firmware-v1.3.4...firmware-v1.4.0) (2026-08-13)


### Features

* **firmware:** give D1001 an audible confirmation chime ([#194](https://github.com/metaneutrons/Vellum/issues/194)) ([b281df8](https://github.com/metaneutrons/Vellum/commit/b281df89f54c14f9a3a2f4a3862ed83c7ea7fca7))


### Bug Fixes

* **firmware:** status screens that fit the panel and tell the truth ([#191](https://github.com/metaneutrons/Vellum/issues/191)) ([cc1528d](https://github.com/metaneutrons/Vellum/commit/cc1528d232d4fcbc00ca3edf05853940deb639ee))
* one-command install, three false README claims, and the E1002 palette ([#193](https://github.com/metaneutrons/Vellum/issues/193)) ([037f5be](https://github.com/metaneutrons/Vellum/commit/037f5bee61bea77c4aaa6f12d7a8a704fcfba30b))

## [1.3.4](https://github.com/metaneutrons/Vellum/compare/firmware-v1.3.3...firmware-v1.3.4) (2026-08-12)


### Bug Fixes

* **firmware:** put E1001 console on its CH340C UART bridge ([#180](https://github.com/metaneutrons/Vellum/issues/180)) ([c3faf51](https://github.com/metaneutrons/Vellum/commit/c3faf512b88f35c6ca6ab9c8bac69748f1404227))
* **firmware:** read USB power from the charger on E1001 too ([#184](https://github.com/metaneutrons/Vellum/issues/184)) ([680a97b](https://github.com/metaneutrons/Vellum/commit/680a97b4465a4078a4fb4b42926a7bb4cbf7769d))
* **firmware:** stop the D1001 flicker and pace retries after failures ([#186](https://github.com/metaneutrons/Vellum/issues/186)) ([a5cee2d](https://github.com/metaneutrons/Vellum/commit/a5cee2d670ff5acf83ace5877298d2a2fbaa99cd))

## [1.3.3](https://github.com/metaneutrons/Vellum/compare/firmware-v1.3.2...firmware-v1.3.3) (2026-08-12)


### Bug Fixes

* complete D1001 bring-up and native USB provisioning ([#173](https://github.com/metaneutrons/Vellum/issues/173)) ([9b80d46](https://github.com/metaneutrons/Vellum/commit/9b80d46a882def6a1990ed871c5532d74e8a1125))

## [1.3.2](https://github.com/metaneutrons/Vellum/compare/firmware-v1.3.1...firmware-v1.3.2) (2026-08-10)


### Bug Fixes

* **firmware:** prevent E1003 OTA progress corruption ([#159](https://github.com/metaneutrons/Vellum/issues/159)) ([f992c46](https://github.com/metaneutrons/Vellum/commit/f992c46d8cdff374c3ab54b9d96a14a823d1389e))

## [1.3.1](https://github.com/metaneutrons/Vellum/compare/firmware-v1.3.0...firmware-v1.3.1) (2026-08-10)


### Bug Fixes

* **firmware:** prefer PTB NTP fallbacks ([6fdeaf2](https://github.com/metaneutrons/Vellum/commit/6fdeaf26833dc034f243d90c1c25888f71c3b2b2))
* **firmware:** prefer PTB NTP fallbacks ([f41a9f7](https://github.com/metaneutrons/Vellum/commit/f41a9f77ddc90e29f809434bb815be201ee34f58))
* **firmware:** show version on system screens ([58e9da8](https://github.com/metaneutrons/Vellum/commit/58e9da8a028b8d7eaa7b46f47f3ed195733c4eed))
* **firmware:** show version on system screens ([117c6ef](https://github.com/metaneutrons/Vellum/commit/117c6ef8aa93b3f3c7d2bb80fb1d4360f9cab47d))

## [1.3.0](https://github.com/metaneutrons/Vellum/compare/firmware-v1.2.12...firmware-v1.3.0) (2026-08-10)


### Features

* **firmware:** add D1001 RTC support ([525255c](https://github.com/metaneutrons/Vellum/commit/525255c8c5587aab52fa8074a9eecffbe1a121da))
* **firmware:** add D1001 RTC support ([f77a8a6](https://github.com/metaneutrons/Vellum/commit/f77a8a66a618614ed2e9465beb0cfcf4254ef14d))
* **provisioning:** support NTP server overrides ([613ea5c](https://github.com/metaneutrons/Vellum/commit/613ea5c894c7c7b2c5b9f9f626175a43f7fb33b5))
* **provisioning:** support NTP server overrides ([0b45a08](https://github.com/metaneutrons/Vellum/commit/0b45a08be0563bd5b402c2eaca140f7148e4aaf0))


### Bug Fixes

* **firmware:** harden WPA3 station compatibility ([afb5f01](https://github.com/metaneutrons/Vellum/commit/afb5f01518a5cd9d2639295873da9e2df8acdbe6))

## [1.2.12](https://github.com/metaneutrons/Vellum/compare/firmware-v1.2.11...firmware-v1.2.12) (2026-08-10)


### Bug Fixes

* **firmware:** recover gracefully from OTA failures ([000d6ff](https://github.com/metaneutrons/Vellum/commit/000d6ffd170cd09d3fd1ec2f45b633538d509e1c))
* **firmware:** recover gracefully from OTA failures ([9a4b78b](https://github.com/metaneutrons/Vellum/commit/9a4b78b6244296acfcd55ab1e915edc7f27d3ebb))

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
