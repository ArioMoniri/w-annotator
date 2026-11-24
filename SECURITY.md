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

- A room is joined with a display name and an invite link. There are no accounts. A link works once and for 24 hours; whoever uses it first is in, so send links privately. The host sees who joined and can remove them. The host's app lets a person in itself, so nobody can join while the host is offline.
- Everyone in a room needs W Annotator 0.1.4 or later, and so does the room server. An older app is told to update.
- What a room sends is encrypted between the apps (AES-256-GCM). What one person sends another (the image and the mask on joining, slice pictures, keys) is sealed with a key only those two can make (X25519). What goes to everyone (edits, names, cursors) is sealed with a room key and signed by its sender (Ed25519). The invite link carries no key; the part after `#` lets the newcomer and the host recognise each other, and the host then hands over the room key. Whoever runs the relay sees addresses, times, message sizes, public keys and roles. It does not see display names, voxels, segment names or pictures.
- Whoever runs the relay decides the order of edits made at the same moment, and can delay edits or stop delivering to someone; that looks like a bad connection and cannot be told from one. It cannot make up an edit, change one, repeat one, or pass one member's edit off as another's. If it leaves an edit out for somebody, swaps two, or shows two people different edits, their apps notice as soon as anything passes between them: both say "This room's server delivered different edits to different people", keep their own copy and take nothing more from the room. A relay that keeps people wholly apart, so that nothing passes between them, is not noticed. An app does not take the relay's word for what kind of room it is in, who its host is, or who its members are: the host signs the list of members.
- A member can read what is sent to everyone, and what is sent to them. A member who works together with whoever runs the relay cannot read what another person was sent alone, and cannot pose as someone else. A current member can still pass on anything they can read, change any voxel, and raise a false alarm about the room server.
- Removing someone stops the relay delivering to them, and the host makes a new room key that only the people who stay are given. What is sent after that a removed person cannot read, even when they see the traffic. For the moment between the removal and each remaining app receiving the new key, a removed person who sees the traffic (with the relay operator's help, or on a network without TLS) can still read what is sent to everyone. They keep what they already received.
- Trust in a room starts with the invite link. Whoever holds a valid link is who the host's app lets in, and the host's app is believed about who the members are. Someone who gets hold of the host's device or its stored keys can do what the host can.
- The project has reviewed rooms itself: [`docs/reviews/rooms-security.md`](docs/reviews/rooms-security.md) lists what was found, what was fixed and what is accepted. There has been no independent security review.
- A shared-copy room sends the image and the mask to everyone who joins. Removing a person does not delete the copy they already have.
- A view-through-host room sends guests 8-bit pictures of the slices they look at and the labels on them, never the file, the stored values, file names or DICOM tags, and writes nothing on a guest's device. It cannot stop a guest photographing or recording their screen, and a guest who visits every slice has seen an 8-bit version of the whole image.
- A room never carries file names, paths or DICOM tags. Voxel data can still identify a person; de-identify before sharing.
- A device keeps, for each shared-copy room it is a member of, its member key and the room's keys in the app's local storage, not encrypted, until the room is forgotten or deleted, the member is removed, or the room is unused for 30 days. The desktop app does not use the system keychain: Tauri offers no maintained first-party way to. Rely on disk encryption for a device that may be lost.
- The desktop app sets a content security policy: scripts only from the app itself, none inline and none evaluated from text; connections only to room servers (`ws:`, `wss:`) and to the app's own Rust side. Inline styles are allowed, because the imaging library needs them.
- Run the relay behind TLS, for example behind a reverse proxy that terminates HTTPS, so that clients connect over `wss://`. Without TLS the encrypted payloads still cannot be read by anyone who was not given the keys, but who talks to whom can be seen, connections can be disturbed, and someone on the network path can do what the relay operator can.
- Anyone who can reach a relay can create rooms on it. Keep a relay private or limit `--max-rooms`. After a relay restart, whoever first asks to make a room id again gets it; the real host and members are then turned away and need a new room.
- A room hosted by the desktop app listens on every network the computer is connected to for as long as the room is open (on this computer only when it has no network address). People on those networks cannot read or join the room without a link; they can connect to the relay and use up its 8 rooms and 128 connections.

## Not a medical device

W Annotator is not a medical device and must not be relied on for clinical decisions. Remove identifying information from data before sharing it with anyone.
