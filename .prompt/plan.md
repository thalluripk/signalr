# Implementation Plan: Peer-to-Peer Audio and Video Calls

Date: 2026-11-10
Target: Existing ASP.NET Core 10 project using SignalR and browser WebRTC.
Source of requirements: The user's request and the existing prototype in `Program.cs`, `VideoHub.cs`, and `wwwroot/index.html`.

## 1. Goal and Architecture

Build a working browser application for private, one-to-one audio and video calls. Extend this project; do not generate a replacement application.

SignalR is the signaling channel, not the media transport. Browsers exchange call invitations, SDP offers/answers, and ICE candidates through `/videohub`. WebRTC carries encrypted audio and video directly between peers when their networks permit it.

```text
Browser A -- HTTPS / SignalR signaling -- ASP.NET Core -- signaling -- Browser B
Browser A <============== WebRTC encrypted audio/video =============> Browser B
						   STUN helps discover addresses
```

### What "without a middle man" means

- The application server must never receive, record, or forward audio/video.
- A signaling server is still required for this design. SignalR alone cannot provide peer-to-peer media.
- STUN discovers possible network addresses; it does not relay media. A public STUN service is still a third-party dependency unless self-hosted.
- Default to direct-only operation: configure STUN, no TURN, and normal ICE transport policy. Some restrictive NATs, firewalls, VPNs, or corporate networks will prevent connection. Explain this honestly in the failure state.
- Optional future TURN fallback improves connectivity but relays encrypted media through a server. It must be an explicit opt-in, not silently enabled. TURN cannot decrypt WebRTC media merely by relaying it.
- Do not promise universal connectivity, anonymity, or absence of all servers. Direct calls can expose network addresses to the other participant; transport encryption does not independently verify their identity.

## 2. Scope and Assumptions

The first version uses invite links and temporary guest sessions. A user creates a private room, shares its link through an existing channel, and the second user joins. Either participant can initiate a call once both are present. This is the simplest interpretation of users calling each other without introducing accounts.

Persistent accounts, a searchable user directory, offline ringing, push notifications, group calls, recording, screen sharing, chat, and deployment provisioning are out of scope. Calling a named registered user requires a separate identity and authorization design before implementation; do not present guest sessions as verified identities.

Keep one ASP.NET Core process, in-memory room state, and plain HTML/CSS/JavaScript. Restarting the process ends all sessions. Multiple server instances require shared room state and SignalR scale-out and are not part of this version.

Deliver the same application as an installable Progressive Web App (PWA), not a separate native app. Users must be able to add an application icon/tile to a supported mobile home screen and launch it in standalone mode. Installation does not enable offline calls, background ringing, or guaranteed calls while the screen is locked; mobile operating systems can suspend media and signaling.

No upstream feature specification, constitution, or migration artifacts were supplied. This is a standalone implementation handoff, with assumptions explicitly stated here, not a modernization workflow.

## 3. Requirements

| ID | Requirement |
| --- | --- |
| REQ-001 | One-to-one browser audio/video using WebRTC; no application-server media path. |
| REQ-002 | Unguessable private invite links, at most two participants, no public room listing. |
| REQ-003 | Explicit call request, accept, decline, cancel, busy, timeout, and hang-up behavior. |
| REQ-004 | Reliable offer/answer and ICE handling, including readiness, ordering, and stale messages. |
| REQ-005 | Audio-only choice, microphone mute, camera toggle, local preview, remote media, and status. |
| REQ-006 | Deterministic cleanup after hang-up, failure, disconnect, or navigation. |
| REQ-007 | HTTPS, server-side membership checks, bounded signaling payloads, and privacy-conscious logging. |
| REQ-008 | Responsive, accessible phone/tablet/desktop UI in portrait and landscape with actionable device, permission, and connectivity errors. |
| REQ-009 | Reproducible local setup, network configuration, and acceptance checks. |
| REQ-010 | Light, dark, and system theme modes with persisted preference and accessible contrast. |
| REQ-011 | Installable mobile home-screen icon/tile, standalone launch, and a safe offline shell without offline/background calling promises. |

## 4. Technical Decisions

- Retain `net10.0`, nullable reference types, ASP.NET Core SignalR, and `/videohub`.
- Use browser `RTCPeerConnection`, `getUserMedia`, and media track APIs. Do not send media blobs or base64 frames through SignalR.
- Use a supported SignalR JavaScript client from the 10.x release line, pin its exact version, and preferably serve it locally. Replace the prototype's 8.0.7 CDN reference.
- Use strongly typed signaling DTOs instead of JSON encoded inside strings. SignalR already serializes objects.
- Keep mutable room state in a singleton `CallSessionService`, not on transient hub instances. Make admission and state transitions atomic with a small, explicit locking strategy.
- Use cryptographically random room IDs and separate high-entropy invite secrets, for example 32 random bytes for the secret. Store only secret hashes and compare safely. A room ID alone must not grant access.
- Put the invite secret in the URL fragment; read it in JavaScript, clear it from the visible address after admission, and pass it only to the same-origin hub over HTTPS. Do not put it in query strings or logs. Treat the entire invite link as a bearer credential.
- An invite admits one guest once and expires after a short configurable lifetime, initially 10 minutes. A disconnected participant cannot reclaim membership using the consumed invitation. Create a new room/invite after disconnect.
- Use a configurable unanswered-call timeout, initially 30 seconds. Expire empty/waiting rooms, pending requests, and abandoned state with a lightweight hosted cleanup service.
- Configure STUN addresses through server configuration and return only public client configuration. No TURN credentials or other server secrets belong in committed settings or static files.
- Implement themes with CSS custom properties and a small early initialization script. Implement mobile installation with a web app manifest, real PNG icons, and a same-origin service worker; no frontend framework or native wrapper is needed.

## 5. Signaling and State Contract

Finalize DTO names consistently across C# and JavaScript before implementing handlers. Return authoritative snapshots containing room ID, membership role, room version, and relevant call state, without disclosing invite secrets to the guest or other clients.

### Hub methods

| Method | Responsibility |
| --- | --- |
| `CreateRoom()` | Create room; assign current connection as host; return private invitation and public RTC configuration. |
| `JoinRoom(roomId, inviteSecret)` | Atomically validate unexpired invite and admit one guest; consume invitation. |
| `RequestCall(roomId, mode)` | Validate two present members and idle state; create server-generated call ID and ring the other participant. |
| `AcceptCall(roomId, callId)` | Only the intended recipient may accept a pending request. |
| `DeclineCall(roomId, callId)` | Only the intended recipient may decline. |
| `CancelCall(roomId, callId)` | Only the initiator may cancel a pending request. |
| `SendOffer(roomId, callId, description)` | Forward accepted-call offer only from the selected initiator. |
| `SendAnswer(roomId, callId, description)` | Forward answer only from the selected recipient. |
| `SendIceCandidate(roomId, callId, candidate)` | Forward bounded candidate DTO only between accepted-call participants. |
| `EndCall(roomId, callId, reason)` | Idempotently terminate the current call for both members. |
| `LeaveRoom(roomId)` | Remove membership, end any call, and notify peer. |

Use events such as `PeerJoined`, `PeerLeft`, `IncomingCall`, `CallAccepted`, `CallDeclined`, `CallCancelled`, `CallEnded`, `ReceiveOffer`, `ReceiveAnswer`, and `ReceiveIceCandidate`. Include room version and call ID where applicable. Return stable, non-sensitive error codes for invalid operations, full/expired rooms, and busy participants.

### State rules

- Room states: waiting for peer, ready, ringing, negotiating, active, closed. UI may additionally show connecting, disconnected, and failed.
- The server owns membership and allowed transitions. Obtain sender identity from `Context.ConnectionId`; never trust a sender ID supplied by the browser.
- A connection can belong to at most one room and one call. Reject joining another room without leaving the first.
- Resolve simultaneous call requests atomically: the first valid request wins; return busy for the other. The accepted initiator is the sole offerer. Do not build renegotiation features that require perfect negotiation in this version.
- Capture a call ID in each peer connection's handlers. Ignore events for old call IDs or older room versions; do not let an old timeout or callback terminate a newer call.
- Forward signaling directly to the other authorized connection, not to an arbitrary client-selected group. The prototype's unrestricted group broadcast methods must be replaced.
- Do not send SDP or ICE before acceptance. On disconnect, end pending/active calls and close the room so a fresh invitation is required. Do not automatically resume a call after SignalR reconnect.
- When signaling reconnects, require a fresh session; disable call controls until ready. If WebRTC media continues temporarily, close it on the local signaling-loss policy and explain that the call ended.

## 6. WebRTC Lifecycle

1. Register all SignalR handlers before starting the connection. Creating or joining a room must not request microphone/camera access.
2. Let the initiator choose audio-only or video. On Call, acquire the requested devices before ringing; on failure, release partially acquired tracks and show a useful error.
3. Present an incoming-call dialog with caller session label, requested mode, Accept, and Decline. Session labels are not authenticated identities. On Accept, acquire devices before invoking `AcceptCall`; handle cancellation or timeout while a permission prompt is open.
4. Both sides create a peer connection for the accepted call and attach local tracks. Every signaling handler must safely await idempotent peer initialization for that call; do not rely on notification timing.
5. The designated initiator creates and sets its local offer, then sends it. The recipient sets the remote offer, creates and sets its answer, then sends it. The initiator sets the remote answer.
6. Trickle ICE with `onicecandidate`. Queue incoming candidates until both peer initialization and `setRemoteDescription` finish; flush in order and discard queues on teardown. Bound queue size.
7. Attach remote tracks to a stable `MediaStream`; support streamless track events. Local video is muted and both elements use `playsinline`. Handle rejected autoplay with an explicit play action.
8. Use connection/ICE state events for UI and a bounded negotiation timeout. A brief `disconnected` state can have a short grace period; `failed` or timeout terminates the call. Initial version requires redial instead of automatic ICE restart.
9. Mute by setting audio track `enabled`; toggle an existing camera track similarly. In an audio-only call, disable camera controls rather than adding a new media kind mid-call. Stop all tracks when ending a call; disabled tracks alone do not release devices.
10. Teardown must be idempotent: invalidate the active call generation, detach handlers, close peer connection, stop tracks, clear ICE queues/timers, dismiss ringing, and clear video `srcObject`. Late `getUserMedia` results must have their tracks stopped if the call was cancelled.

## 7. UI and Error Handling

Use one responsive call screen with create/share invitation, join state, waiting status, local preview, large remote media area, audio/video mode selection, and a compact call toolbar. Use accessible icon buttons with labels/tooltips for mute, camera, and hang-up; use Lucide or another established icon library, not hand-drawn icons. Keep media regions dimensionally stable across state changes and small screens.

Provide incoming-call Accept/Decline controls and visible ringing/cancel states. Disable invalid actions and prevent repeated clicks from creating duplicate connections or streams. Indicate actual local mute/camera state; do not imply that disabling a local UI control changes the remote participant's devices.

Handle denied permission, missing device, device in use, unavailable `mediaDevices`, unsupported browser, expired/full invitation, peer departure, signaling failure, and direct-connection failure. Offer an explicit audio-only retry when camera acquisition fails. Do not silently downgrade an accepted video call's mode. Do not claim a peer rejected a call when the actual cause is timeout or network failure.

### Responsive layout

- Design mobile-first and verify widths of 320, 375, 768, 1024, and 1440 CSS pixels, plus short landscape viewports. No horizontal scrolling, clipped labels, or overlapping videos, dialogs, status, or controls.
- Include viewport metadata with `width=device-width, initial-scale=1, viewport-fit=cover`; do not disable zoom. Account for notches and home indicators using safe-area insets and dynamic viewport height (`100dvh` with a fallback).
- Stack media regions on narrow screens and use a side-by-side layout when space allows. Preserve video aspect ratios; keep the local preview from covering remote content or call controls.
- Keep call actions reachable with touch targets of at least 44 by 44 CSS pixels. Allow toolbar wrapping or an accessible overflow menu rather than shrinking buttons. Ensure dialogs fit and scroll with the on-screen keyboard open.
- Support portrait/landscape changes without recreating the peer connection or restarting device capture. Respect reduced motion, visible keyboard focus, and 200% zoom.

### Light and dark themes

- Provide an accessible System / Light / Dark segmented control or settings menu. Default to System and follow `prefers-color-scheme`; react to OS changes only while System is selected.
- Persist only the theme preference in `localStorage`, with graceful fallback if storage is unavailable. Apply the resolved theme before first paint to avoid a bright/dark flash; set CSS `color-scheme` for native controls.
- Define semantic CSS tokens for background, surface, text, muted text, borders, focus, success, warning, danger, and disabled states. Cover dialogs, toolbars, empty/loading/error states, and video overlays in both themes.
- Meet WCAG AA contrast: at least 4.5:1 for normal text and 3:1 for large text and meaningful controls/focus indicators. Never use color alone to convey call or mute status.
- Update the document's `theme-color` metadata to match the resolved theme where supported. Switching themes must not interrupt an active call or reset controls.

### Mobile installation and app lifecycle

- Add `wwwroot/manifest.webmanifest` with a stable application `id`, name/short name, `start_url: "/"`, `scope: "/"`, `display: "standalone"`, and sensible `theme_color` / `background_color` defaults. Never embed room IDs or invitation fragments in the manifest or start URL. Runtime theme switching remains a document feature; manifest/splash colors may remain static on some platforms.
- Supply real PNG icons: 192x192 and 512x512 standard icons, a separate 512x512 maskable icon with safe-zone padding, and a 180x180 Apple touch icon under `wwwroot/icons/`. Link the manifest and Apple touch icon from `wwwroot/index.html`.
- Add `wwwroot/js/pwa.js` to register `/service-worker.js` and handle installation. On supporting Android Chromium browsers, show an Install action only after receiving `beforeinstallprompt`; invoke it from a user gesture and handle dismissal/`appinstalled`. Do not assume this API exists on every browser.
- For iPhone/iPad Safari, document Share > Add to Home Screen; do not show a nonfunctional programmatic install button. Detect standalone mode where supported and hide redundant install actions. Installation remains optional; the ordinary browser experience must work.
- Add `wwwroot/service-worker.js` with versioned, bounded caching of an explicit allowlist of public same-origin shell assets. Serve known shell navigation from the network with an offline fallback. Bypass `/videohub` and all signaling requests; never cache SDP, ICE, invitation data, dynamic configuration, room state, or media. Keep invite secrets in page memory, never Cache Storage or browser persistence.
- The offline shell must clearly show Offline and disable create/join/call actions. Re-check actual SignalR readiness before enabling controls; `navigator.onLine` alone is not proof of connectivity. Do not queue or replay invitations or signaling after reconnection.
- Do not force service-worker activation or reload an active/ringing call. Offer an update only when idle; clean up only this app's obsolete named caches during activation. Document cache-version updates for releases.
- A tile launch opens a fresh session; do not restore consumed invites or an old call. An invite opened in the browser must still work even when installation exists; do not assume installed-app deep-link capture.
- On resume from background/lock, verify current signaling and call state, show termination if the session was lost, and clean up stale tracks. Do not promise native incoming-call integration, push notifications, or background availability.

## 8. Security and Privacy

- Use HTTPS for deployed access and secure-context media APIs. HTTP localhost can be used where browser rules allow it; remote LAN devices need trusted HTTPS, not plain HTTP to a LAN IP.
- Keep clients same-origin; do not enable permissive CORS. Validate browser origin for hub transport requests, including WebSocket upgrades; CORS alone does not protect WebSockets.
- Require validated membership, role, call ID, and state on every hub method. Reject unknown rooms and cross-room signaling without disclosing private state.
- Validate SDP type/size, candidate fields/size, IDs, enums, and allowed reason values. Keep a bounded hub message limit appropriate to SDP and add per-connection/per-room limits for signaling and outstanding requests. Also rate-limit connection/room creation; HTTP handshake limits alone do not limit hub messages.
- Limit room count and pending state. Clear room, invitation, and call state on expiry/disconnect. Document that in-memory controls are single-process only.
- Avoid logging SDP, ICE addresses, invite secrets, complete invite URLs, or media. Log sanitized correlation IDs, lifecycle events, and error categories only.
- Use safe DOM APIs such as `textContent` for external values. Avoid `innerHTML` for signaling data.
- WebRTC uses encrypted media transport, but this MVP trusts its signaling server and out-of-band invite sharing. Verified identities or protection against a malicious signaling service need a separate authentication/key-verification design.

## 9. Ordered Implementation Tasks

### Phase 1: Foundation

Plan P1.1: Preserve the existing host and establish typed signaling and public configuration. Requirements: REQ-001, REQ-007, REQ-009.

- [x] T001 [Plan:P1.1] Update `Program.cs` for HTTPS, same-origin hub origin protection, bounded SignalR messages, and service registration. Retain static files and `/videohub`.
- [x] T002 [Plan:P1.1] Add `Models/CallContracts.cs` with typed request/event payloads, enums, public RTC configuration, and stable errors; add non-secret STUN/timeout options in `appsettings.json`.

### Phase 2: Private Rooms and Call Control

Plan P2.1: Implement atomic membership, invitations, and call state. Requirements: REQ-002, REQ-003, REQ-006, REQ-007.

- [x] T003 [Plan:P2.1] Add `Services/CallSessionService.cs` for private rooms, hashed single-use invites, membership limits, atomic transitions, call IDs, versions, and bounded state.
- [x] T004 [Plan:P2.1] Add `Services/CallSessionCleanupService.cs` for room expiry and unanswered-call timeout; make timeout transitions conditional on the still-current call ID.
- [x] T005 [Plan:P2.1] Replace unrestricted methods in `VideoHub.cs` with the contract in section 5, authorized peer targeting, disconnect cleanup, validation, and hub-message rate limits. Wire remaining registrations in `Program.cs`.

### Phase 3: Working Browser Call

Plan P3.1: Implement ordered signaling and WebRTC lifecycle. Requirements: REQ-001, REQ-004, REQ-005, REQ-006.

- [x] T006 [Plan:P3.1] Extract prototype inline JavaScript into `wwwroot/js/call.js`; serve a pinned compatible SignalR client at `wwwroot/lib/signalr/signalr.min.js` with its required license notices preserved.
- [x] T007 [Plan:P3.1] Implement handler registration, private invite creation/admission, authoritative state handling, ring/accept/decline/cancel, and generation-safe event dispatch in `wwwroot/js/call.js`.
- [x] T008 [Plan:P3.1] Implement device capture, sole-offerer SDP exchange, queued ICE, remote tracks, audio-only mode, track toggles, connection timeout, and idempotent teardown in `wwwroot/js/call.js`.

### Phase 4: Usable Interface and Handoff

Plan P4.1: Add the responsive call screen, themes, and failure states. Requirements: REQ-003, REQ-005, REQ-008, REQ-010.

- [x] T009 [Plan:P4.1] Update `wwwroot/index.html` and add `wwwroot/css/site.css` for mobile-first media layout, safe-area spacing, invitation controls, mode choice, accessible toolbar/dialog, and semantic light/dark theme tokens. Add `wwwroot/js/theme.js` for pre-paint theme resolution, persisted System/Light/Dark selection, OS changes, and theme-color updates.
- [ ] T010 [Plan:P4.1] Wire control states and device/permission/network errors in `wwwroot/js/call.js`; verify keyboard operation, touch targets, rotation, zoom, both themes, and autoplay recovery without interrupting calls. Implemented; automated theme/layout/rotation/device-error checks pass. Full keyboard/zoom and real-device autoplay checks remain manual.

Plan P4.3: Make the application installable on mobile with safe offline behavior. Requirements: REQ-006, REQ-007, REQ-008, REQ-011.

- [x] T011 [Plan:P4.3] Add `wwwroot/manifest.webmanifest` and the four icon variants under `wwwroot/icons/` specified in section 7; wire manifest/icon metadata in `wwwroot/index.html`. Verify manifest MIME type and worker scope with the existing static-file host; adjust `Program.cs` only if required.
- [x] T012 [Plan:P4.3] Add `wwwroot/js/pwa.js` and `wwwroot/service-worker.js` for supported install prompts, standalone detection, allowlisted public-shell caching, offline controls, idle-only update flow, and lifecycle recovery integrated with `wwwroot/js/call.js`.

Plan P4.2: Document operation and verify the acceptance criteria. Requirements: REQ-001 through REQ-011.

- [x] T013 [Plan:P4.2] Add `README.md` covering `dotnet dev-certs https --trust`, `dotnet restore`, `dotnet build`, `dotnet run`, actual listening URL, two-browser operation, trusted HTTPS for remote devices, STUN configuration, direct-only limitations, process-local state, theme settings, Android/iOS home-screen installation, service-worker updates, and offline/background limitations.
- [x] T014 [Plan:P4.2] Run the build and the available checks in section 10; report observed results and unverified environments without claiming unexecuted checks passed. Build and 12 automated browser check groups passed; remaining physical-device/network/accessibility checks are recorded in `README.md`.

## 10. Acceptance Checks

Use manual browser checks for this first version; an automated test suite is not required by this request. A successful build alone does not verify WebRTC behavior.

1. Build on .NET 10. Open two independent browser sessions with working or simulated devices, create an invite, join, accept, and confirm bidirectional video and audible audio. Avoid speaker feedback using separate devices or headphones.
2. Inspect `RTCPeerConnection.getStats()` after connection, resolve the selected candidate pair and candidate records, and confirm neither candidate is `relay`. Correlate with observed remote media; do not infer direct connectivity merely from the presence of a video element.
3. Verify audio-only, mute/unmute, camera off/on, decline, cancel, unanswered timeout, and hang-up from either side. Device indicators must stop after teardown.
4. Reject a third participant, an expired/consumed invite, arbitrary room joins, and cross-room or unauthorized SDP/ICE. Invalid actions must not affect another session.
5. Exercise simultaneous Call clicks, ICE arriving before remote description, immediate hang-up during permissions, repeated hang-up, and old-call events after a new call. No unhandled errors, duplicate calls, or leaked tracks.
6. Reload/close either browser and interrupt SignalR. The peer receives a bounded termination outcome, room state is removed, and reconnect does not silently rejoin or resume.
7. Deny camera/microphone permissions and try unavailable devices. Verify clear errors, cleanup, and an explicit audio-only retry where appropriate.
8. Check current desktop Chrome/Edge and Firefox, plus Safari/iOS when available. Verify narrow-screen layout, keyboard focus, readable status, and inline playback. Report browsers not exercised.
9. Check same-LAN and separate-network calls using trusted HTTPS. On a restrictive network where direct ICE fails, show a clear direct-connection failure, release devices, and do not silently relay media. Report network scenarios not exercised.
10. Inspect logs, URLs, and browser network traffic for accidental secret/media leakage. Confirm signaling carries control data only, no audio/video payloads.
11. At the viewport sizes in section 7, check portrait/landscape, 200% zoom, keyboard/dialog behavior, safe areas, and minimum touch targets. Verify no horizontal overflow or obscured call actions. Emulation is useful but does not replace physical-device installation and media checks.
12. Check System/Light/Dark on first visit, after reload, and with OS theme changes and unavailable local storage. Verify contrast and focus visibility in both themes, no theme flash, and no active-call interruption when switching.
13. Over trusted HTTPS on physical Android Chrome and iOS Safari where available, install/add to home screen, verify the correct icon/title, and launch from the tile into standalone mode. Check install dismissal, already-installed behavior, and normal browser use. Report unavailable devices/platforms rather than claiming installation passed.
14. After one online load, launch the shell offline: show Offline, disable call operations, and verify no signaling/invite/media state exists in caches. Reconnect and require a fresh session. Publish a new cache version during a call and verify no forced reload; apply the update once idle.
15. Background/lock and resume the installed app on mobile. Verify it reflects the actual live or ended session and releases stale devices; do not interpret a home-screen installation as guaranteed background calling. Verify a fresh tile launch and a browser invite link each follow the session rules.

## 11. Requirement Mapping

| Requirement | Plan Items | Planned Implementation Evidence |
| --- | --- | --- |
| REQ-001 | P1.1, P3.1, P4.2 | `Program.cs`, `wwwroot/js/call.js`, selected-candidate inspection |
| REQ-002 | P2.1, P4.2 | `Services/CallSessionService.cs`, invite/admission checks |
| REQ-003 | P2.1, P4.1, P4.2 | `VideoHub.cs`, call state transitions, incoming-call controls |
| REQ-004 | P3.1, P4.2 | `wwwroot/js/call.js`, candidate queue and stale-event checks |
| REQ-005 | P3.1, P4.1, P4.2 | `wwwroot/index.html`, track controls and audio-only checks |
| REQ-006 | P2.1, P3.1, P4.3, P4.2 | cleanup service, disconnect handling, browser teardown and mobile resume |
| REQ-007 | P1.1, P2.1, P4.3, P4.2 | HTTPS/origin limits, validated DTOs, membership, log and cache privacy checks |
| REQ-008 | P4.1, P4.3, P4.2 | `wwwroot/css/site.css`, accessible controls, offline states and responsive checks |
| REQ-009 | P1.1, P4.2 | configuration, `README.md`, recorded verification results |
| REQ-010 | P4.1, P4.2 | `wwwroot/js/theme.js`, semantic CSS tokens, persistence and contrast checks |
| REQ-011 | P4.3, P4.2 | manifest, PNG icons, `wwwroot/js/pwa.js`, service worker and device installation checks |

## 12. Prompt to Give GitHub Copilot

> Implement the plan in `.prompt/plan.md` in this existing ASP.NET Core 10 repository. Read the plan and current files first. Keep `/videohub`, use SignalR only for signaling and WebRTC for direct audio/video, and use private invite-based guest sessions as specified. Deliver a mobile-first responsive interface with persisted System/Light/Dark themes and an installable PWA home-screen icon/tile, standalone mode, and privacy-safe offline shell. Do not promise offline or guaranteed background calls. Do not introduce cloud services, a database, persistent accounts, media relay, a native wrapper, or a frontend framework. Follow the ordered tasks and mark each complete only after implementation and relevant verification. Preserve unrelated work. Build incrementally, then perform the available acceptance checks. Document network/browser/mobile installation checks that cannot be executed. End with the local run URL, completed tasks, limitations, and verification results. Do not claim calls work across all networks without TURN.
