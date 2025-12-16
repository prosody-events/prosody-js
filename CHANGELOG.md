# Changelog

## [2.0.2](https://github.com/cincpro/prosody-js/compare/v2.0.1...v2.0.2) (2025-12-16)


### Bug Fixes

* **deps:** update prosody to prevent cross-topic key collisions ([#114](https://github.com/cincpro/prosody-js/issues/114)) ([83cf6cf](https://github.com/cincpro/prosody-js/commit/83cf6cf6f619f8dbe92933cc978e9c94ddccd162))

## [2.0.1](https://github.com/cincpro/prosody-js/compare/v2.0.0...v2.0.1) (2025-12-15)


### Bug Fixes

* **ci:** use git CLI for Cargo on Windows ([#112](https://github.com/cincpro/prosody-js/issues/112)) ([e5f3c9b](https://github.com/cincpro/prosody-js/commit/e5f3c9ba3e46ba91f079260f4e25d7ec203dcf11))

## [2.0.0](https://github.com/cincpro/prosody-js/compare/v1.2.2...v2.0.0) (2025-12-13)


### ⚠ BREAKING CHANGES

* add QoS middleware and rename shutdown to cancel ([#110](https://github.com/cincpro/prosody-js/issues/110))

### Features

* add QoS middleware and rename shutdown to cancel ([#110](https://github.com/cincpro/prosody-js/issues/110)) ([efd1fc1](https://github.com/cincpro/prosody-js/commit/efd1fc15ad21eea5a20817602163b916c468ac58))

## [1.2.2](https://github.com/cincpro/prosody-js/compare/v1.2.1...v1.2.2) (2025-10-10)


### Bug Fixes

* promise heap growth until topic revocation ([#108](https://github.com/cincpro/prosody-js/issues/108)) ([238349a](https://github.com/cincpro/prosody-js/commit/238349adbd6265c7af2dd8e1f90bac5b54b04995))
* span names ([#106](https://github.com/cincpro/prosody-js/issues/106)) ([d396e17](https://github.com/cincpro/prosody-js/commit/d396e173c8afe982ee4b0606646f860f5b586972))

## [1.2.1](https://github.com/cincpro/prosody-js/compare/v1.2.0...v1.2.1) (2025-09-19)


### Bug Fixes

* invalidate contexts and flush spans ([#104](https://github.com/cincpro/prosody-js/issues/104)) ([8e432c1](https://github.com/cincpro/prosody-js/commit/8e432c10bc47dba8897bac41a3a6cf479d54b38b))

## [1.2.0](https://github.com/cincpro/prosody-js/compare/v1.1.5...v1.2.0) (2025-09-16)


### Features

* add source system to client ([#101](https://github.com/cincpro/prosody-js/issues/101)) ([2ee499b](https://github.com/cincpro/prosody-js/commit/2ee499be8100aac44e4af632aa46bf7db7be084c))


### Bug Fixes

* propagate span traces through context methods ([#103](https://github.com/cincpro/prosody-js/issues/103)) ([366e5bc](https://github.com/cincpro/prosody-js/commit/366e5bc2c3f5d5eee1c670e3c32ef86d26d83d44))

## [1.1.5](https://github.com/cincpro/prosody-js/compare/v1.1.4...v1.1.5) (2025-09-12)


### Performance Improvements

* bound message buffering ([#99](https://github.com/cincpro/prosody-js/issues/99)) ([c57ce52](https://github.com/cincpro/prosody-js/commit/c57ce5253d7acd5c42abea484c0fc8e9e5d4fa87))

## [1.1.4](https://github.com/cincpro/prosody-js/compare/v1.1.3...v1.1.4) (2025-08-22)


### Bug Fixes

* add migration lock and add jitter to timer slab loads ([#97](https://github.com/cincpro/prosody-js/issues/97)) ([beea11c](https://github.com/cincpro/prosody-js/commit/beea11c3f40ba6078d440e467e9a83981d08ca06))

## [1.1.3](https://github.com/cincpro/prosody-js/compare/v1.1.2...v1.1.3) (2025-08-15)


### Bug Fixes

* make abort signal explicitly optional ([#93](https://github.com/cincpro/prosody-js/issues/93)) ([da7e5e1](https://github.com/cincpro/prosody-js/commit/da7e5e1f9edffdb0d55501bdb4e09594f6c61488))


### Performance Improvements

* don’t select if we don’t need to in send ([#96](https://github.com/cincpro/prosody-js/issues/96)) ([9297d85](https://github.com/cincpro/prosody-js/commit/9297d853cbb7d56eaff4c6153faaaa8760265d15))

## [1.1.2](https://github.com/cincpro/prosody-js/compare/v1.1.1...v1.1.2) (2025-08-11)


### Bug Fixes

* disable OTEL TLS ([#91](https://github.com/cincpro/prosody-js/issues/91)) ([5d55924](https://github.com/cincpro/prosody-js/commit/5d55924203293e2b52b5210a1f987afc0e0bc268))

## [1.1.1](https://github.com/cincpro/prosody-js/compare/v1.1.0...v1.1.1) (2025-08-08)


### Bug Fixes

* prepublish release argument ([#89](https://github.com/cincpro/prosody-js/issues/89)) ([e814ceb](https://github.com/cincpro/prosody-js/commit/e814cebb700bbb190086b9e42becf3aa52915c6b))

## [1.1.0](https://github.com/cincpro/prosody-js/compare/v1.0.9...v1.1.0) (2025-08-07)


### Features

* upgrade to NAPI version 3 ([#87](https://github.com/cincpro/prosody-js/issues/87)) ([763fbda](https://github.com/cincpro/prosody-js/commit/763fbda469e4576a36d42fbbc3b3f2f79751cedc))

## [1.0.9](https://github.com/cincpro/prosody-js/compare/v1.0.8...v1.0.9) (2025-07-28)


### Bug Fixes

* support all OTEL OTLP protocols and to add OTEL error logging ([#85](https://github.com/cincpro/prosody-js/issues/85)) ([67dbdb9](https://github.com/cincpro/prosody-js/commit/67dbdb9d22c512815f01cc2aea552b3869700c3c))

## [1.0.8](https://github.com/cincpro/prosody-js/compare/v1.0.7...v1.0.8) (2025-07-23)


### Bug Fixes

* don’t execute timer commands while shutting down the partition ([#83](https://github.com/cincpro/prosody-js/issues/83)) ([8516bac](https://github.com/cincpro/prosody-js/commit/8516bacf40bd9243a35edfd15a395322bb920d77))

## [1.0.7](https://github.com/cincpro/prosody-js/compare/v1.0.6...v1.0.7) (2025-07-16)


### Bug Fixes

* **deps:** update prosody and librdkafka ([#80](https://github.com/cincpro/prosody-js/issues/80)) ([15faecc](https://github.com/cincpro/prosody-js/commit/15faecc7fa52f3a562084d397383b79dbe9b87e0))

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
