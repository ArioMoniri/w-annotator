# Rooms on a full-size scan

Date: 2026-11-22. Branch `fix/rooms-hardening`.

Until now every room test used a cube of 48 voxels. This page records what rooms do with a scan of ordinary size, what was wrong at that size, what was fixed, and where the limits are.

## How it was measured

`e2e/room-scale.spec.ts`, run with:

```bash
W_SCALE=1 pnpm e2e e2e/room-scale.spec.ts
```

It is left out of the normal suite (about two minutes and two gigabytes of memory) and runs in CI in the "Real data" job. It writes its numbers to `test-results/room-scale.json`.

- **Scan:** 512 x 512 x 300, 16-bit (150 MiB), made from a formula in the test: a body of soft tissue in air, two lungs, a spine, and noise so that it compresses about as a CT does. No patient data.
- **Mask:** 8-bit (75 MiB), three segments: 2.1 million, 4.4 million and 0.6 million voxels.
- **Machine:** a 4-core virtual machine (Intel Xeon, 2.1 GHz), 16 GB, Linux. Chromium from Playwright, headless, drawing with **software GL** (SwiftShader), not a graphics card. Host, guest and relay (debug build) all on this one machine, over loopback. Other work was running on the machine at the same time.

Read the numbers with that in mind. There is no network in them: over the internet the transfer time is the size on the wire divided by the slower of the two connections. Drawing is far slower here than on any computer with a graphics card, and drawing is most of what the "large edit" times are. Not measured: macOS, Windows, WebKit, the built desktop app.

## Results

| What | Measured |
| --- | --- |
| **Shared copy, joining:** image and mask to a guest with nothing open | 20 to 24 s in three runs, of which about 13 s sending and 4 s opening the image at the end |
| Size on the wire | 57.7 MB for 225 MiB of voxels (70 image frames, 21 mask frames) |
| Rate while sending | 3.4 to 3.7 MB/s on the wire, about 13 MiB/s of voxels. The pace would allow 10 MiB/s; compressing, sealing, unpacking and drawing are what limit it here |
| Progress | 39 steps of the bar |
| Host's screen while sending | longest gap between frames 205 to 250 ms; 33 to 36 gaps over 100 ms in 13 s |
| Guest's screen while receiving | longest gap 360 to 460 ms |
| Guest memory | 950 to 1030 MB at the peak of the transfer, 955 MB afterwards with the scan open: at most 76 MB above what the open scan takes |
| **Cut in the middle** (connection cut at 25 %, back after 2 s) | finished in 26 to 30 s; 37 image frames before the cut, 33 after: nothing that had arrived was sent again |
| **View through host:** from pressing Join to the first slice with its labels | 3.3 s |
| Scroll to a slice not yet fetched, until it is there | median 0.63 s, fastest 0.14 s, slowest 1.9 s, over ten jumps |
| Sent to that guest in all | 2.1 MB in 40 slice frames; no image or mask slab |
| Host's screen while serving slices | longest gap 132 ms |
| **Large edit, host to guest:** a segment of 2.1 million voxels cleared | 0.3 to 0.5 s to make; the guest has all of it 4.3 to 4.8 s after; 2.2 MB in 3 frames |
| **Large edit, guest to host:** 4.4 million voxels cleared | 0.5 to 0.6 s to make; the host has all of it 9.9 to 11.3 s after |
| Screens during a large edit | longest gap 0.7 to 1.3 s on both sides, three to eleven gaps over 100 ms |
| Connection during large edits | kept by both; nothing had to start again |
| **Sealing and opening** a 1 MiB frame (pure JavaScript AES-GCM, in Chromium, development build) | 18 MiB/s to seal, 32 MiB/s to open. In Node on the same machine: 31 to 44 and 38 to 50. WebCrypto, for comparison, in Node: 450 MiB/s |
| **Relay memory** | 7 MB idle; 16 MB at the peak of the join; 21 MB after the large edits (its replay log holds up to 8 MiB) |

## What was wrong at this size, and is fixed

1. **A large edit closed the connection, for good.** An edit goes out in pieces of 1 MiB, all at once. More than about 20 MiB at once is over the relay's limit, the relay closes the connection (4429), the app reconnects, merges, sends the same edit again, and is closed again. Now everything a connection sends goes through one pace of half the relay's limits. (`Pace`, `client.test.ts`.)
2. **Confirming a large edit of one's own cost the square of its size.** Each confirmed piece made the app write every later piece to the screen again: for an edit of 75 pieces, about 2800 writes of a megabyte each and as many redraws. A confirmation of one's own oldest waiting edit now changes nothing on screen. (`oplog.test.ts`: 100 pieces, 100 confirmations, no rewrites; before, 4950.)
3. **A joiner on a slow connection could never finish.** The sender paced itself by its own connection only. A receiver slower than 8 MiB/s had its queue on the relay filled, was closed as "too slow", and started again from nothing. Now the receiver reports what has arrived and the sender keeps at most 4 MiB on the way. Not measured on a slow link: only the mechanism is tested.
4. **A cut transfer started again from nothing.** Image slabs that arrived are now kept, and the next attempt asks only for the rest. The mask is sent again, since it may have changed.
5. **A transfer with a slab missing was opened anyway**, as an image with blank slices. It must now be complete.
6. **A member away for more than about a thousand small edits was closed on every return.** The relay's replay did not fit its queue. (`relay/tests/v2_hardening.rs`.)
7. **Unpacking happened without a size limit.** It is now bounded to the slab's size. This moved unpacking of slabs from a worker to the main thread, one slab (8 MiB) at a time with the screen allowed to draw in between; that is part of the guest's 360 to 460 ms gaps above.

## Limits, stated plainly

- **Encryption is not what limits a room, but it is not free.** At the measured 3.7 MB/s on the wire, sealing takes about a fifth of the sending side's main thread and opening about a tenth of the receiving side's, in blocks of 30 to 55 ms per megabyte. WebCrypto would be some twenty times faster where it exists, but it is asynchronous and missing on plain `http` pages, so both the sending queue and the receiving order would have to be rebuilt around it with the pure JavaScript code kept as the fallback. That was not done here. It is worth doing if hosts report stutter while a guest joins.
- **A large edit is slow to appear on the other side because of drawing, not the network.** 2.2 MB arrives at once; what takes four seconds here is redrawing some 200 slices of the mask three times over on software GL. On a graphics card this should be a fraction of it. Not verified.
- **The screen is not smooth during a large edit.** The longest gap was 0.7 to 1.3 s on each side: making the edit (a pass over 78 million voxels) on one side, redrawing on the other. A solo edit of the same size has the same gap; rooms do not add to it.
- **Scrolling as a guest of a view-through-host room takes about half a second per new slice here**, more when several are asked for at once. The slice on each side of the one on screen is fetched ahead, so stepping one slice at a time is immediate; jumping is not.
- **A scan much larger than this** has not been tried. The room limit is 2 GB for the image. Memory on the receiving side stays at the scan plus one slab, so the limit there is what the device can open at all.
- **Edits that arrive while someone is joining** are kept until the mask is there, up to 64 MiB or 4096 edits; past that the transfer starts again from a newer mask. A room under constant heavy editing can keep a newcomer waiting.
- **A member who falls more than 8 MiB of edits behind** (one large edit is enough) cannot be caught up from the relay's log and gets the mask from another member instead (21 frames for this mask).
- **The relay's worst case** is unchanged: 8 MiB of log per room plus up to 16 MiB of queue for each connected member who is not reading. In the runs here it stayed at 21 MB.
