# Direct

Private one-to-one audio and video calls using ASP.NET Core 10, SignalR signaling, and browser WebRTC. The application server does not receive or relay media. The interface supports mobile/desktop layouts, System/Light/Dark themes, and mobile home-screen installation as a Progressive Web App.

## Run Locally

Install the .NET 10 SDK. From the project directory:

```powershell
dotnet dev-certs https --trust
dotnet restore
dotnet build
dotnet run --launch-profile https
```

Complete the operating system's certificate trust prompt yourself if shown. The HTTPS launch profile uses **https://localhost:7171**. If that port is occupied, choose a free port:

```powershell
dotnet run --no-launch-profile --urls https://localhost:7248
```

Use the listening URL printed by the server. No database, Node.js, npm installation, or asset build is needed to run the application: client libraries and PNG icons are included locally.

## Make a Call

1. Open the app and create an invitation. Copy or share the private link through a trusted channel.
2. Open that link in another browser session or on another device and select Join room. The invitation expires after ten minutes and can admit only one guest once.
3. Choose Video or Audio and select Call. Device permission is requested only when calling or accepting, not when joining a room.
4. The other participant accepts or declines. Either participant can mute, toggle an existing camera track, or end the call. Audio-only calls do not acquire a camera.
5. After hanging up, the same two participants can call again. Leaving, reloading, losing signaling, or restarting the server closes the room; create a fresh invitation. A browser reconnect does not restore an old call.

Use headphones or separate physical devices to avoid feedback. Guest sessions are not verified identities. Anyone with an unused invitation can join, so treat the full link as a credential. The secret is transported in the fragment and hub invocation, not the query string; it is not stored in local storage, the manifest, or service-worker caches.

## Mobile and Appearance

Select System, Light, or Dark in Appearance. System follows the operating system. Only this preference is persisted; blocked local storage does not prevent theme switching.

- Android Chrome: use the Install action if the browser offers it, or the browser's installation menu. The browser controls installation eligibility and may withhold the prompt.
- iPhone/iPad Safari: open the app over trusted HTTPS, then use **Share > Add to Home Screen**. Choose Open as Web App if offered. There is no Safari programmatic installation prompt.
- Launch the Direct icon/tile to open a fresh standalone session. Normal browser calling remains available without installation. Browser invitation links are not guaranteed to open in the installed app automatically.
- Loading the app online once caches its public shell. Offline launch shows Offline and disables calls; it does not cache, queue, or replay invitations/signaling/media.
- A home-screen icon is not a native background calling service. Locking the phone, changing apps, or operating-system suspension may end the call. There are no push notifications, offline ringing, or guaranteed background calls.

## Network and Hosting

SignalR exchanges invitations, SDP descriptions, and ICE candidates. WebRTC transports encrypted audio/video between the two browsers. STUN helps discover candidate addresses and does not relay media. The default Google STUN endpoint is an external dependency, even though it does not carry the call.

**No TURN relay is configured.** Symmetric NAT, VPNs, corporate firewalls, or blocked UDP can prevent calls from connecting. A direct-connection failure is shown and devices are released. Try another network. Do not promise universal connectivity; adding TURN later would be an explicit change to the no-relay policy.

Phones cannot reach the development machine using `localhost`. Remote/LAN testing requires a reachable hostname, a certificate trusted by each device and valid for that hostname, an HTTPS listener, and an appropriate firewall rule. Plain HTTP on a LAN IP is not a substitute for trusted HTTPS. Never deploy with certificate validation disabled.

The app validates hub request origins, including WebSocket upgrades, and keeps browser requests same-origin. For reverse-proxy hosting, explicitly configure trusted forwarded headers, TLS, allowed hosts, WebSocket support, and relevant timeouts before exposing the app; do not blindly trust forwarded headers from the internet. Deployment provisioning is outside this project.

## Configuration

Public connectivity options live in `appsettings.json` under `Calls`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `StunUrls` | `stun:stun.l.google.com:19302` | At most five STUN URLs; use an empty array for host candidates only. TURN URLs are rejected. |
| `InviteLifetimeSeconds` | 600 | Waiting invitation lifetime, between 30 and 3600 seconds. |
| `RingTimeoutSeconds` | 30 | Unanswered-call timeout, between 5 and 120 seconds. |
| `NegotiationTimeoutSeconds` | 45 | Connection establishment deadline, between 10 and 120 seconds. |
| `MaxRooms` | 500 | Maximum process-local rooms, between 1 and 5000. |

The server validates configuration at startup. Standard ASP.NET Core environment overrides work, for example `Calls__RingTimeoutSeconds=15`. No server secrets should be committed to configuration or placed in public files.

The server supports at most 2,000 signaling connections, one room per connection, three room creations per connection per minute, 160 hub operations per connection per ten seconds, 320 operations per room per ten seconds, and 120 signaling HTTP requests per IP per minute. SDP, candidate, and hub message sizes are bounded. These are single-process resource limits, not a distributed abuse-prevention system.

Rooms and calls exist only in process memory. Multi-instance hosting needs shared state and SignalR scale-out. Persistent accounts, user directories, recording, group calls, and screen sharing are not included.

## Assets and Updates

Local distributions: Microsoft SignalR **10.0.11** and Lucide **0.468.0**, with their upstream license notices in `wwwroot/lib/`. To reproduce the downloads and generated PNG icons on Windows:

```powershell
./scripts/Prepare-Assets.ps1
```

The script needs internet access and Windows System.Drawing. Existing included assets are usable on other operating systems without running the script.

For each shell release, increment the cache version in `wwwroot/service-worker.js`. An installed update becomes available without forcing a running call to reload. The Update action asks all open app windows to confirm they are idle before activating; only the requesting idle window reloads. Unresponsive/busy windows block activation. Only obsolete caches prefixed `direct-shell-` are removed.

## Browser Checks

The repeatable check script uses Playwright and synthetic audio/canvas tracks. It tests actual WebRTC negotiation, track transport, and server authorization without accessing real devices. Node.js is needed only for these developer checks:

```powershell
Push-Location scripts
npm ci
npm test
Pop-Location
```

Start the application at https://localhost:7248 first. Override the URL with `DIRECT_URL` if needed. The script uses installed Edge/Chrome on Windows; set `BROWSER_PATH` for another Chromium executable, or run `npx playwright install chromium` from `scripts` if no supported browser is installed. Certificate validation is bypassed only inside the local test browser.

Screenshots are saved to the ignored `scripts/.artifacts/` directory. `window.directApp.diagnostics()` exposes sanitized state, track kinds, selected ICE candidate types, and byte counts for troubleshooting; it does not expose invitation secrets, SDP, or ICE addresses.

### Verification Recorded

On 2026-11-10, the backend build succeeded and **12 browser check groups passed** in headless Chromium/Edge:

- Bidirectional synthetic audio/video, rendered remote video, non-relay ICE pairs, mute/camera toggles, and audio-only calls.
- Hang-up from both sides with tracks stopped; decline, cancel, delayed outbound-request cancellation, and permission-denial cleanup.
- Eleven server checks covering wrong secrets, third participants, non-members, invalid modes, concurrent requests, role checks, early/cross-room signaling, oversized candidates, repeated end, and closed rooms.
- Foreign Origin rejected with HTTP 403; manifest served as `application/manifest+json`.
- Five responsive widths (320, 375, 768, 1024, 1440), minimum touch targets, rotation without call loss, and desktop/mobile screenshots.
- Theme persistence, live system preference changes, themes during a call, and unavailable local storage.
- Manifest/icon dimensions, 13 public-only cache entries, offline shell launch, disabled offline call actions, and fresh-session reconnect.

The integrated browser also exercised the idle-only service-worker update flow successfully. The automated test replaces device capture with generated tracks, so it does not prove real microphone/camera quality or permission UX on every browser.

**Still manual/unverified:** physical Android/iOS installation and lock/resume behavior; Safari/Firefox interoperability; real-device audio/autoplay behavior; 200% browser zoom and on-screen keyboards; separate/restrictive-network calls; relay-free failure across different NAT configurations; full accessibility and security audits. See `.prompt/plan.md` for the acceptance checklist. No claim is made that these unexecuted scenarios passed.