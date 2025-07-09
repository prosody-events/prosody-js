# Changelog

## [1.0.6](https://github.com/cincpro/prosody-js/compare/v1.0.5...v1.0.6) (2025-07-09)


### Bug Fixes

* remove flaky/racy test ([#78](https://github.com/cincpro/prosody-js/issues/78)) ([d8957ad](https://github.com/cincpro/prosody-js/commit/d8957ad317d2d996ac930e257c0827cb8f43b2d8))

## [1.0.5](https://github.com/cincpro/prosody-js/compare/v1.0.4...v1.0.5) (2025-07-09)


### Bug Fixes

* create mock broker topics ([#76](https://github.com/cincpro/prosody-js/issues/76)) ([10b2cae](https://github.com/cincpro/prosody-js/commit/10b2cae1d9d2a69ff292724caa2cf26a489b7af8))

## [1.0.4](https://github.com/cincpro/prosody-js/compare/v1.0.3...v1.0.4) (2025-07-01)


### Bug Fixes

* improve warnings, logs, and table names ([#74](https://github.com/cincpro/prosody-js/issues/74)) ([b759925](https://github.com/cincpro/prosody-js/commit/b759925a11ed0b37ab70f1a8a065aa22a9545b42))

## [1.0.3](https://github.com/cincpro/prosody-js/compare/v1.0.2...v1.0.3) (2025-07-01)


### Bug Fixes

* test addresses ([#71](https://github.com/cincpro/prosody-js/issues/71)) ([0e70e53](https://github.com/cincpro/prosody-js/commit/0e70e5322b66077ec719b084237d8a4b4e6d37b0))

## [1.0.2](https://github.com/cincpro/prosody-js/compare/v1.0.1...v1.0.2) (2025-07-01)


### Bug Fixes

* add healthchecks to tests ([#69](https://github.com/cincpro/prosody-js/issues/69)) ([05b099e](https://github.com/cincpro/prosody-js/commit/05b099e909e26a3841118a2b5b080b40d0992411))

## [1.0.1](https://github.com/cincpro/prosody-js/compare/v1.0.0...v1.0.1) (2025-06-30)


### Bug Fixes

* remove Scylla TLS to improve build compatibility ([#67](https://github.com/cincpro/prosody-js/issues/67)) ([0089453](https://github.com/cincpro/prosody-js/commit/0089453dca35d51a7b5ef1a960011f103205c0e2))

## [1.0.0](https://github.com/cincpro/prosody-js/compare/v0.7.1...v1.0.0) (2025-06-30)


### ⚠ BREAKING CHANGES

* **timers:** persistence ([#64](https://github.com/cincpro/prosody-js/issues/64))

### Features

* **timers:** persistence ([#64](https://github.com/cincpro/prosody-js/issues/64)) ([ee27ee9](https://github.com/cincpro/prosody-js/commit/ee27ee9d81e96d84b1b2f300e3898aa21cbbeda9))

## [0.7.1](https://github.com/cincpro/prosody-js/compare/v0.7.0...v0.7.1) (2025-06-16)


### Bug Fixes

* add timer export and make EventHandler methods optional ([#61](https://github.com/cincpro/prosody-js/issues/61)) ([6ab6254](https://github.com/cincpro/prosody-js/commit/6ab6254a7d25ae977f536fdfc535a760337dc14a))

## [0.7.0](https://github.com/cincpro/prosody-js/compare/v0.6.4...v0.7.0) (2025-06-11)


### Features

* timers (non-persistent only) ([#57](https://github.com/cincpro/prosody-js/issues/57)) ([a882253](https://github.com/cincpro/prosody-js/commit/a882253a4c7565a7869cfd4da196a8dcbe90d9da))

## [0.6.4](https://github.com/cincpro/prosody-js/compare/v0.6.3...v0.6.4) (2025-04-18)


### Bug Fixes

* export non-const enums in TS type stubs ([#54](https://github.com/cincpro/prosody-js/issues/54)) ([3f8d2b4](https://github.com/cincpro/prosody-js/commit/3f8d2b439b590e168d4615846a627342154482f7))
* use JS to destructure setLogger ([#56](https://github.com/cincpro/prosody-js/issues/56)) ([f02bc80](https://github.com/cincpro/prosody-js/commit/f02bc809905d7d5df171dfdb48f72177c456fceb))

## [0.6.3](https://github.com/cincpro/prosody-js/compare/v0.6.2...v0.6.3) (2025-04-11)


### Bug Fixes

* prevent initializing the library more than once ([#50](https://github.com/cincpro/prosody-js/issues/50)) ([f3a6126](https://github.com/cincpro/prosody-js/commit/f3a6126260d7414291a545bd1078700b21c19b27))

## [0.6.2](https://github.com/cincpro/prosody-js/compare/v0.6.1...v0.6.2) (2025-03-21)


### Bug Fixes

* **consumer:** multiple prosody fixes and max concurrency parameter ([#48](https://github.com/cincpro/prosody-js/issues/48)) ([42862da](https://github.com/cincpro/prosody-js/commit/42862da950f66f11afd62573d05611086af04873))

## [0.6.1](https://github.com/cincpro/prosody-js/compare/v0.6.0...v0.6.1) (2025-03-14)


### Bug Fixes

* respect stall threshold ([#46](https://github.com/cincpro/prosody-js/issues/46)) ([7ffee4e](https://github.com/cincpro/prosody-js/commit/7ffee4e236db8da582b86bf0aae1335b0c122bf2))

## [0.6.0](https://github.com/cincpro/prosody-js/compare/v0.5.3...v0.6.0) (2025-03-13)


### Features

* **consumer:** add shutdown timeout parameter ([#44](https://github.com/cincpro/prosody-js/issues/44)) ([90f72a8](https://github.com/cincpro/prosody-js/commit/90f72a83e913da0c9181216d94309541199d5068))

## [0.5.3](https://github.com/cincpro/prosody-js/compare/v0.5.2...v0.5.3) (2025-03-12)


### Bug Fixes

* always check for shutdown before retrying ([#39](https://github.com/cincpro/prosody-js/issues/39)) ([efcac0b](https://github.com/cincpro/prosody-js/commit/efcac0b7b4fbb4ee9fc08dcba133e5076326e9f2))

## [0.5.2](https://github.com/cincpro/prosody-js/compare/v0.5.1...v0.5.2) (2025-03-07)


### Bug Fixes

* group id and source system env var fallback ([#37](https://github.com/cincpro/prosody-js/issues/37)) ([d1e0f2a](https://github.com/cincpro/prosody-js/commit/d1e0f2abf2041bc5ef697acfb93b07cdc44f4594))

## [0.5.1](https://github.com/cincpro/prosody-js/compare/v0.5.0...v0.5.1) (2025-03-04)


### Bug Fixes

* deadlock ([#35](https://github.com/cincpro/prosody-js/issues/35)) ([e44fce3](https://github.com/cincpro/prosody-js/commit/e44fce384b76fd855c53acdd862eee621f461b36))

## [0.5.0](https://github.com/cincpro/prosody-js/compare/v0.4.0...v0.5.0) (2025-03-04)


### Features

* add event filtering, source tracking, and fix backpressure deadlock ([#33](https://github.com/cincpro/prosody-js/issues/33)) ([166cffa](https://github.com/cincpro/prosody-js/commit/166cffa5aa7dd7d6dc7d09ad9522ce4fc3b74336))

## [0.4.0](https://github.com/cincpro/prosody-js/compare/v0.3.0...v0.4.0) (2025-01-08)


### Features

* Support message deduplication ([#29](https://github.com/cincpro/prosody-js/issues/29)) ([c59c7d1](https://github.com/cincpro/prosody-js/commit/c59c7d1448d221074a1b1556eaeea29a9f33860f))

## [0.3.0](https://github.com/cincpro/prosody-js/compare/v0.2.1...v0.3.0) (2024-12-19)


### Features

* best effort mode ([#25](https://github.com/cincpro/prosody-js/issues/25)) ([1b3ada0](https://github.com/cincpro/prosody-js/commit/1b3ada0ed539eda5f2826b1112cc34449769173e))

## [0.2.1](https://github.com/cincpro/prosody-js/compare/v0.2.2...v0.2.1) (2024-12-03)

### Bug Fixes

* fix ci and update deps ([#18](https://github.com/cincpro/prosody-js/issues/18))
  ([8022d82](https://github.com/cincpro/prosody-js/commit/8022d82d059369c4d95cbb0091a70809bec807d2))
* releases ([#23](https://github.com/cincpro/prosody-js/issues/23))
  ([d0547ae](https://github.com/cincpro/prosody-js/commit/d0547ae7ac07d8d8dff9ca7bda60b160db70e3b7))
* select correct zig version
  ([0914445](https://github.com/cincpro/prosody-js/commit/091444581eac9ae2a79e40d246b8a38d112af6a3))

## [0.2.0](https://github.com/cincpro/prosody-js/compare/v0.1.3...v0.2.0) (2024-10-24)

### Features

* **consumer:** add health check probes and stall
  detection ([#15](https://github.com/cincpro/prosody-js/issues/15)) ([154fc1a](https://github.com/cincpro/prosody-js/commit/154fc1adb3d656c7444dc095304267289441c828))

## [0.1.3](https://github.com/cincpro/prosody-js/compare/v0.1.2...v0.1.3) (2024-09-18)

### Miscellaneous Chores

* release 0.1.3 ([64f79dd](https://github.com/cincpro/prosody-js/commit/64f79dd8da27e9a0a1bd25ed1a6d26179e150a1b))

## [0.1.2](https://github.com/cincpro/prosody-js/compare/v0.1.1...v0.1.2) (2024-09-17)

### Bug Fixes

* gh release
  flag ([#9](https://github.com/cincpro/prosody-js/issues/9)) ([b0d7633](https://github.com/cincpro/prosody-js/commit/b0d7633742899dfe7185c315c54fb587b5856cb6))

## [0.1.1](https://github.com/cincpro/prosody-js/compare/v0.1.0...v0.1.1) (2024-09-17)

### Bug Fixes

* don’t try to create a gh release
  twice ([#6](https://github.com/cincpro/prosody-js/issues/6)) ([579dac7](https://github.com/cincpro/prosody-js/commit/579dac714d7e499db88d3cda53817fac76ed311d))
* remove access public
  flag ([#8](https://github.com/cincpro/prosody-js/issues/8)) ([2fa41df](https://github.com/cincpro/prosody-js/commit/2fa41df3c7b54146c269e510a1bf0df8745e2b0b))

## [0.1.0](https://github.com/cincpro/prosody-js/compare/v0.0.0...v0.1.0) (2024-09-17)

### Features

* add permanent error
  support ([#4](https://github.com/cincpro/prosody-js/issues/4)) ([96676d7](https://github.com/cincpro/prosody-js/commit/96676d7011d3f8cc724df0b8d39920582a111233))
