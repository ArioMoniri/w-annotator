# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: on the repository's [Security tab](https://github.com/ArioMoniri/w-annotator/security/advisories/new), choose "Report a vulnerability". This opens a private advisory that only you and the maintainer can see.

Include what you found, the app version and operating system, and the steps to reproduce it. Do not include patient data. Use synthetic files.

This is a small project with one maintainer. You should get a reply as soon as the maintainer can manage, and you will be told when a fix is released. Please allow time for a fix before publishing details.

## Supported versions

Only the latest release receives fixes. The app updates itself from GitHub Releases, and updates are verified against a signing key built into the app.

## In scope

- The desktop app: file parsing (NIfTI, MetaImage, NRRD, DICOM), file access, the Tauri commands and the updater.
- The room relay in `relay/`, and room hosting on the local network.
- The release workflow and the files it publishes.

Problems in third-party components, such as Cornerstone3D or Tauri, should be reported to those projects. If the problem is in how this project uses them, report it here.

## What to know about rooms

- Rooms are not end-to-end encrypted. Whoever runs the relay, or hosts the room, can read what passes through it.
- A room is joined with a display name only. There are no accounts. Anyone who has the details needed to join a room can join and edit it.
- A room carries display names and mask edits. It does not carry file names or the image file.
- Run the relay behind TLS, for example behind a reverse proxy that terminates HTTPS, so that clients connect over `wss://`. Without TLS, traffic can be read and changed on the network.
- Hosting on the local network is not encrypted. Use it only on a network you trust.

## Not a medical device

W Annotator is not a medical device and must not be relied on for clinical decisions. Remove identifying information from data before sharing it with anyone.
