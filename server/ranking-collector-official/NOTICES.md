# Notices

Haneoka's tool source is MPL-2.0, as in the bundled LICENSE. The game protocol and third-party dependencies remain under their own terms.

| Component | License or source |
| --- | --- |
| protobuf 6.33.0 | BSD-3-Clause, in the wheel's `dist-info` |
| h2 4.4.1, hpack 4.2.0, hyperframe 6.1.0 | MIT, in each wheel |
| py3rijndael 0.3.3 | MIT, in [LICENSE.py3rijndael.txt](LICENSE.py3rijndael.txt) |
| setuptools 80.9.0, wheel 0.45.1 | Build dependencies, licensed in each wheel |
| `core/total-descriptors.pb` | Sirius 1.0.3 protocol subset with the JP 1.1.0 ranking response, not covered by Haneoka's MPL grant. SHA-256 `e8225c67eb066c1cdb2232a4c95f661a460d54dd88420f634ea2c8242de71adf` |
| `core/intl-descriptors.pb` | International Sirius 1.0.3 subset with the read-only `ArenaRanking` messages, not covered by Haneoka's MPL grant. SHA-256 `2c0fd5de69765a544861a6e63da43f28e679da53c50f52e612b72fee2182147a` |

Python is installed by the operator. The package builder includes only the pinned sources and verified dependencies, listed with their digests in `MANIFEST.json`. It never includes accounts, CDN secrets, decoding parameters, databases, logs or player data.
