# Support

Haneoka is a pre-release community project maintained on a best-effort basis. There is no guaranteed response time, uptime commitment, compatibility window, or private end-user support service.

## Where to ask

| Request                                                  | Channel                                                                                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup, usage, or contribution question                   | [Q&A Discussions](https://github.com/haneoka-gakuen/haneoka/discussions/categories/q-a)                                                      |
| Early-stage product or design idea                       | [Ideas Discussions](https://github.com/haneoka-gakuen/haneoka/discussions/categories/ideas)                                                  |
| Reproducible application or package bug                  | [Bug report](https://github.com/haneoka-gakuen/haneoka/issues/new?template=bug_report.yml)                                                   |
| Catalog, resource, release, or resource-pipeline problem | [Catalog or resource report](https://github.com/haneoka-gakuen/haneoka/issues/new?template=resource_report.yml)                              |
| Missing, inaccurate, or unclear documentation            | [Documentation correction](https://github.com/haneoka-gakuen/haneoka/issues/new?template=documentation.yml)                                  |
| Focused feature proposal                                 | [Feature proposal](https://github.com/haneoka-gakuen/haneoka/issues/new?template=feature_request.yml)                                        |
| Security vulnerability                                   | Private process in [SECURITY.md](SECURITY.md)                                                                                                |
| License, trademark, or takedown concern                  | Contact the repository owner through the [maintainer profile](https://github.com/haneoka-gakuen); do not post confidential evidence publicly |

Search existing issues before opening a new one. Use one issue per independently actionable problem.

## Information for useful bug reports

Include the details that apply to the affected surface:

- the exact URL, route, package, or command and selected resource server when relevant;
- steps that reproduce the problem from a clean page load;
- expected and actual behavior;
- device model, operating-system version, browser name/version, viewport, and orientation;
- whether the problem occurs on a physical device, emulator, or desktop responsive mode;
- screenshots or a short recording for visible problems, and relevant console/network errors with secrets removed;
- the latest commit or deployed date tested.

For rendering problems, identify whether the affected surface is DOM, video, canvas, WebGL chart, Live2D, or ADV story playback. A macOS result does not replace an iPhone/iPad Safari reproduction when the report is device-specific.

## Unsupported requests

The project does not provide:

- game APK/APKS/XAPK files;
- CDN authorization headers, account credentials, or cloud credentials;
- instructions for bypassing access controls;
- guarantees that processed third-party material or generated media may be redistributed;
- support for modified deployments that cannot reproduce the issue on the current source;
- legal advice about third-party SDK, game-asset, copyright, or trademark terms.

Operators are responsible for using authorized inputs and reviewing [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Construction and planned features

The home page, public community feed, posts, bookmarks, notifications, and tags are implemented. Events, gacha, login campaigns, shop, exchange, circle, challenge, and several other catalog routes intentionally use construction surfaces. Community charts and stories, rankings, games, and parts of the user-directory/profile inventory remain planned. A construction page is not a malfunction unless the route is documented as implemented in the current source.
