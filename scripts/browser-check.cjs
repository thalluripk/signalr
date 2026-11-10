const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const baseUrl = process.env.DIRECT_URL || "https://localhost:7248";
const executablePath = process.env.BROWSER_PATH || [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe"
].find(candidate => fs.existsSync(candidate));
const artifacts = path.join(__dirname, ".artifacts");
fs.mkdirSync(artifacts, { recursive: true });
const checks = [];
const pass = name => { checks.push(name); console.log(`PASS ${name}`); };

(async () => {
    const browser = await chromium.launch({ executablePath, headless: true,
        args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
    try {
        const hostContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
        const guestContext = await browser.newContext({ ignoreHTTPSErrors: true });
        for (const context of [hostContext, guestContext]) {
            await context.addInitScript(() => {
                window.__testTracks = [];
                navigator.mediaDevices.getUserMedia = async constraints => {
                    const tracks = [];
                    if (constraints.audio) {
                        const audio = new AudioContext();
                        const oscillator = audio.createOscillator();
                        const destination = audio.createMediaStreamDestination();
                        oscillator.connect(destination);
                        oscillator.start();
                        const track = destination.stream.getAudioTracks()[0];
                        const stop = track.stop.bind(track);
                        track.stop = () => { stop(); oscillator.stop(); void audio.close(); };
                        tracks.push(track);
                    }
                    if (constraints.video) {
                        const canvas = document.createElement("canvas");
                        canvas.width = 640;
                        canvas.height = 360;
                        const drawing = canvas.getContext("2d");
                        const draw = () => {
                            drawing.fillStyle = "#176645";
                            drawing.fillRect(0, 0, 640, 360);
                            drawing.fillStyle = "#f4fff8";
                            drawing.font = "32px sans-serif";
                            drawing.fillText("Direct / media check", 70, 170);
                            drawing.fillText(new Date().toLocaleTimeString(), 70, 220);
                        };
                        draw();
                        const timer = setInterval(draw, 100);
                        const track = canvas.captureStream(10).getVideoTracks()[0];
                        const stop = track.stop.bind(track);
                        track.stop = () => { clearInterval(timer); stop(); };
                        tracks.push(track);
                    }
                    window.__testTracks.push(...tracks);
                    return new MediaStream(tracks);
                };
            });
        }
        const host = await hostContext.newPage();
        const guest = await guestContext.newPage();
        const pageErrors = [];
        host.on("pageerror", error => pageErrors.push(error.message));
        guest.on("pageerror", error => pageErrors.push(error.message));
        const status = (page, text) => page.waitForFunction(value => document.getElementById("callStatus").textContent === value, text, { polling: 100, timeout: 20000 }).catch(async () => {
            const observed = await page.evaluate(async () => ({ status: document.getElementById("callStatus").textContent,
                notice: document.getElementById("notice").textContent, diagnostics: await window.directApp.diagnostics() }));
            throw new Error(`Expected ${text}; observed ${JSON.stringify(observed)}`);
        });
        const online = page => page.waitForFunction(() => document.getElementById("networkStatus").textContent === "Online", null, { polling: 100 });
        const ring = () => guest.waitForFunction(() => document.getElementById("incomingDialog").open, null, { polling: 100 });
        const stats = page => page.evaluate(() => window.directApp.diagnostics());
        await host.goto(baseUrl);
        await online(host);
        await host.locator("#createBtn").click();
        await host.waitForFunction(() => document.getElementById("shareLink").value.length > 0);
        const invitation = await host.locator("#shareLink").inputValue();
        await guest.goto(invitation);
        await online(guest);
        await guest.locator("#joinBtn").click();
        await status(host, "Ready to call");
        assert.equal(await guest.evaluate(() => location.hash), "");
        await host.locator("#callBtn").click();
        await ring();
        await guest.locator("#acceptBtn").click();
        await Promise.all([status(host, "In conversation"), status(guest, "In conversation")]);
        await host.waitForFunction(async () => {
            const data = await window.directApp.diagnostics();
            return data.selectedPair?.bytesReceived > 0 && document.getElementById("remoteVideo").videoWidth > 0;
        });
        for (const participant of [host, guest]) {
            const data = await stats(participant);
            assert.equal(data.connection, "connected");
            assert.notEqual(data.selectedPair.local, "relay");
            assert.notEqual(data.selectedPair.remote, "relay");
            assert.equal(data.remoteTracks.length, 2);
        }
        pass("bidirectional WebRTC video/audio and non-relay ICE pair");
        await host.locator("#muteBtn").click();
        await host.locator("#cameraBtn").click();
        assert((await stats(host)).localTracks.every(track => !track.enabled));
        await host.locator("#muteBtn").click();
        await host.locator("#cameraBtn").click();
        await host.locator("#themeSelect").selectOption("dark");
        assert.equal((await stats(host)).connection, "connected");
        await host.screenshot({ path: path.join(artifacts, "desktop-dark.png"), fullPage: true, animations: "disabled" });
        for (const width of [320, 375, 768, 1024, 1440]) {
            await host.setViewportSize({ width, height: 900 });
            const geometry = await host.evaluate(() => ({
                width: innerWidth, content: document.documentElement.scrollWidth,
                targets: [...document.querySelectorAll("button")].filter(button => button.getClientRects().length).every(button => {
                    const box = button.getBoundingClientRect();
                    return box.width >= 44 && box.height >= 44;
                })
            }));
            assert(geometry.content <= geometry.width, `Overflow at ${width}`);
            assert(geometry.targets, `Touch target too small at ${width}`);
        }
        await host.setViewportSize({ width: 844, height: 390 });
        assert.equal((await stats(host)).connection, "connected");
        await host.setViewportSize({ width: 375, height: 812 });
        await host.locator("#themeSelect").selectOption("light");
        await host.screenshot({ path: path.join(artifacts, "mobile-light.png"), fullPage: true, animations: "disabled" });
        pass("mute/camera controls, themes during a call, rotation and five responsive widths");
        await host.locator("#endBtn").click();
        await Promise.all([status(host, "Ready to call"), status(guest, "Ready to call")]);
        for (const participant of [host, guest]) {
            assert(await participant.evaluate(() => window.__testTracks.every(track => track.readyState === "ended")));
            assert.equal((await stats(participant)).localTracks.length, 0);
        }
        pass("hang-up releases both participants' tracks");
        await host.locator('input[name="mode"][value="audio"]').check({ force: true });
        await host.locator("#callBtn").click();
        await ring();
        await guest.locator("#acceptBtn").click();
        await Promise.all([status(host, "In conversation"), status(guest, "In conversation")]);
        assert((await stats(host)).localTracks.every(track => track.kind === "audio"));
        await guest.locator("#endBtn").click();
        await Promise.all([status(host, "Ready to call"), status(guest, "Ready to call")]);
        pass("audio-only call and guest hang-up");
        await host.locator("#callBtn").click();
        await ring();
        await guest.locator("#declineBtn").click();
        await Promise.all([status(host, "Ready to call"), status(guest, "Ready to call")]);
        assert.equal(await host.locator("#notice").textContent(), "Call declined.");
        await host.locator("#callBtn").click();
        await ring();
        await host.locator("#endBtn").click();
        await Promise.all([status(host, "Ready to call"), status(guest, "Ready to call")]);
        pass("decline and cancel call requests");
        await host.evaluate(() => {
            const original = signalR.HubConnection.prototype.invoke;
            signalR.HubConnection.prototype.invoke = function(method, ...args) {
                if (method === "RequestCall") return new Promise((resolve, reject) => {
                    window.__releaseRequest = () => original.call(this, method, ...args).then(resolve, reject);
                });
                return original.call(this, method, ...args);
            };
            window.__restoreInvoke = () => { signalR.HubConnection.prototype.invoke = original; };
        });
        await host.locator("#callBtn").click();
        await host.waitForFunction(() => typeof window.__releaseRequest === "function");
        await host.locator("#endBtn").click();
        await host.evaluate(() => { window.__releaseRequest(); window.__restoreInvoke(); });
        await host.waitForFunction(() => document.getElementById("notice").textContent === "Call cancelled.");
        await Promise.all([status(host, "Ready to call"), status(guest, "Ready to call")]);
        assert(await host.evaluate(() => window.__testTracks.every(track => track.readyState === "ended")));
        pass("cancel while RequestCall is in flight");
        await host.evaluate(() => {
            const original = navigator.mediaDevices.getUserMedia;
            navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Denied", "NotAllowedError"));
            window.__restoreCapture = () => { navigator.mediaDevices.getUserMedia = original; };
        });
        await host.locator("#callBtn").click();
        await host.waitForFunction(() => document.getElementById("notice").textContent.includes("permission was denied"));
        assert.equal((await stats(host)).localTracks.length, 0);
        await host.evaluate(() => window.__restoreCapture());
        pass("permission denial has a clear error and no leaked tracks");
        const security = await host.evaluate(async () => {
            const make = () => new signalR.HubConnectionBuilder().withUrl("/videohub").configureLogging(signalR.LogLevel.None).build();
            const first = make(), second = make(), outsider = make();
            const denied = async action => { try { await action(); return false; } catch { return true; } };
            await Promise.all([first.start(), second.start(), outsider.start()]);
            try {
                const admission = await first.invoke("CreateRoom");
                const roomId = admission.room.roomId;
                const result = {};
                result.wrongSecret = await denied(() => outsider.invoke("JoinRoom", roomId, "0".repeat(64)));
                await second.invoke("JoinRoom", roomId, admission.inviteSecret);
                result.thirdMember = await denied(() => outsider.invoke("JoinRoom", roomId, admission.inviteSecret));
                result.nonMember = await denied(() => outsider.invoke("RequestCall", roomId, "video"));
                result.badMode = await denied(() => first.invoke("RequestCall", roomId, "invalid"));
                const outcomes = await Promise.allSettled([first.invoke("RequestCall", roomId, "audio"), second.invoke("RequestCall", roomId, "audio")]);
                result.oneWinner = outcomes.filter(outcome => outcome.status === "fulfilled").length === 1;
                const index = outcomes.findIndex(outcome => outcome.status === "fulfilled");
                const initiator = index === 0 ? first : second;
                const recipient = index === 0 ? second : first;
                const callId = outcomes[index].value.call.id;
                result.wrongRole = await denied(() => initiator.invoke("AcceptCall", roomId, callId));
                result.earlyOffer = await denied(() => initiator.invoke("SendOffer", roomId, callId, { type: "offer", sdp: "v=0" }));
                await recipient.invoke("AcceptCall", roomId, callId);
                result.crossRoom = await denied(() => outsider.invoke("SendIceCandidate", roomId, callId, { candidate: "candidate:test", sdpMid: "0", sdpMLineIndex: 0 }));
                result.oversize = await denied(() => initiator.invoke("SendIceCandidate", roomId, callId, { candidate: "x".repeat(2049), sdpMid: "0", sdpMLineIndex: 0 }));
                await initiator.invoke("EndCall", roomId, callId, "hangup");
                await initiator.invoke("EndCall", roomId, callId, "hangup");
                result.idempotentEnd = true;
                await first.invoke("LeaveRoom", roomId);
                result.closedRoom = await denied(() => second.invoke("GetState", roomId));
                return result;
            } finally { await Promise.all([first.stop(), second.stop(), outsider.stop()]); }
        });
        assert(Object.values(security).every(Boolean), JSON.stringify(security));
        pass("11 membership, role, payload, concurrency and idempotence checks");
        const originResponse = await hostContext.request.post(`${baseUrl}/videohub/negotiate?negotiateVersion=1`, { headers: { Origin: "https://untrusted.example" } });
        assert.equal(originResponse.status(), 403);
        pass("foreign signaling Origin rejected");
        await host.locator("#themeSelect").selectOption("dark");
        await host.reload();
        await online(host);
        assert.equal(await host.evaluate(() => document.documentElement.dataset.theme), "dark");
        await guest.waitForFunction(() => document.getElementById("roomLabel").textContent === "No room joined");
        await host.emulateMedia({ colorScheme: "light" });
        await host.locator("#themeSelect").selectOption("system");
        assert.equal(await host.evaluate(() => document.documentElement.dataset.theme), "light");
        await host.emulateMedia({ colorScheme: "dark" });
        await host.waitForFunction(() => document.documentElement.dataset.theme === "dark");
        pass("theme persistence, system preference and peer-disconnect cleanup");
        await host.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
        const pwa = await host.evaluate(async () => {
            const manifest = await (await fetch("/manifest.webmanifest")).json();
            const names = (await caches.keys()).filter(name => name.startsWith("direct-shell-"));
            const cache = await caches.open(names[0]);
            const requests = await cache.keys();
            const icons = await Promise.all(["/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png", "/icons/apple-touch-icon.png"].map(async url => {
                const image = await createImageBitmap(await (await fetch(url)).blob());
                return image.width;
            }));
            return { display: manifest.display, start: manifest.start_url, paths: requests.map(request => new URL(request.url).pathname), icons };
        });
        assert.equal(pwa.display, "standalone");
        assert.equal(pwa.start, "/");
        assert.equal(pwa.paths.length, 13);
        assert(pwa.paths.every(asset => !asset.includes("videohub")));
        assert.deepEqual(pwa.icons, [192, 512, 512, 180]);
        await hostContext.setOffline(true);
        await host.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
        await host.waitForFunction(() => document.getElementById("networkStatus").textContent === "Offline");
        for (const id of ["createBtn", "joinBtn", "callBtn"]) assert(await host.locator(`#${id}`).isDisabled());
        await hostContext.setOffline(false);
        await online(host);
        assert.equal((await stats(host)).state, "idle");
        pass("PWA manifest/icons, public-only cache, offline launch and fresh reconnect");
        const noStorage = await browser.newContext({ ignoreHTTPSErrors: true });
        await noStorage.addInitScript(() => Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Blocked", "SecurityError"); } }));
        const storagePage = await noStorage.newPage();
        await storagePage.goto(baseUrl);
        await online(storagePage);
        await storagePage.locator("#themeSelect").selectOption("dark");
        assert.equal(await storagePage.evaluate(() => document.documentElement.dataset.theme), "dark");
        pass("theme works when local storage is unavailable");
        assert.deepEqual(pageErrors, []);
        console.log(`\n${checks.length} check groups passed. Fake media only; physical mobile installation, real device audio, and restrictive networks remain manual checks.`);
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });