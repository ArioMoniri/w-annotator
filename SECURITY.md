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

- A room is joined with a display name and an invite link. There are no accounts. A link works once and for 24 hours; whoever uses it first is in, so send links privately. The host sees who joined and can remove them.
- What a room sends is encrypted between the apps (AES-256-GCM) with a room key that travels only in the part of the invite link after `#`. Whoever runs the relay sees addresses, times, message sizes, member keys and roles. It does not see display names, voxels, segment names or pictures. This has not had an independent security review.
- Every member of a room holds the same room key. A member who works together with whoever runs the relay could read what other members send or pose as one of them. Removing someone stops the relay delivering to them; the key is not changed.
- A shared-copy room sends the image and the mask to everyone who joins. Removing a person does not delete the copy they already have.
- A view-through-host room sends guests 8-bit pictures of the slices they look at and the labels on them, never the file, the stored values, file names or DICOM tags, and writes nothing on a guest's device. It cannot stop a guest photographing or recording their screen, and a guest who visits every slice has seen an 8-bit version of the whole image.
- A room never carries file names, paths or DICOM tags. Voxel data can still identify a person; de-identify before sharing.
- A device keeps, for each shared-copy room it is a member of, its member key and the room key in the app's local storage until the room is forgotten, deleted, or unused for 30 days. Rely on disk encryption for a device that may be lost.
- Run the relay behind TLS, for example behind a reverse proxy that terminates HTTPS, so that clients connect over `wss://`. Without TLS the encrypted payloads still cannot be read, but who talks to whom can be seen and connections can be disturbed.
- Anyone who can reach a relay can create rooms on it. Keep a relay private or limit `--max-rooms`.

## Not a medical device

W Annotator is not a medical device and must not be relied on for clinical decisions. Remove identifying information from data before sharing it with anyone.
