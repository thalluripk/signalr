(() => {
    "use strict";
    const element = id => document.getElementById(id);
    const ui = Object.fromEntries(["sessionControls", "sessionHeading", "networkStatus", "createBtn", "joinBtn", "joinForm", "inviteInput", "shareLink", "invitationPanel", "copyBtn", "shareBtn", "roomLabel", "leaveBtn", "notice", "audioRetryBtn", "callStatus", "duration", "remoteVideo", "localVideo", "remoteEmpty", "localEmpty", "remoteLabel", "localLabel", "mutedBadge", "playBtn", "modeControl", "muteBtn", "cameraBtn", "callBtn", "endBtn", "endLabel", "transportStatus", "peerStatus", "incomingDialog", "incomingMode", "acceptBtn", "declineBtn"].map(id => [id, element(id)]));
    window.lucide?.createIcons();
    const connection = new signalR.HubConnectionBuilder().withUrl("/videohub")
        .configureLogging(signalR.LogLevel.None).withAutomaticReconnect([0, 2000, 5000, 10000]).build();
    let room = null;
    let joiningRoom = null;
    let config = { iceServers: [] };
    let negotiationSeconds = 45;
    let stream = null;
    let peer = null;
    let generation = 0;
    let pendingMedia = false;
    let dialIntent = null;
    let pendingRoom = false;
    let ending = false;
    let connected = false;
    let queue = Promise.resolve();
    let candidates = [];
    let negotiationTimer;
    let disconnectTimer;
    let startedAt = null;
    let retryTimer;
    let offerFor = null;
    let shareUrl = "";

    function notice(message, error = false) {
        ui.notice.textContent = message;
        ui.notice.hidden = !message;
        ui.notice.dataset.error = String(error);
    }

    function errorMessage(error) {
        const messages = {
            "invite-unavailable": "This invitation is expired, already used, or unavailable. Ask for a new invitation.",
            "already-joined": "Leave your current room before joining another.",
            "busy": "The other participant started a call. Respond to the incoming call instead.",
            "rate-limited": "Too many requests. Wait a minute before trying again.",
            "capacity": "The service is busy. Please try again later.",
            "peer-unavailable": "The other participant is not here yet.",
            "call-expired": "The call request has expired. Try calling again.",
            "stale-call": "This call has already ended.",
            "invalid-session": "This session ended. Create or request a new invitation.",
            "session-lost": "The connection changed. Create or request a new invitation."
        };
        const code = Object.keys(messages).find(key => String(error?.message).includes(key));
        if (code) return messages[code];
        if (error?.name === "NotAllowedError") return "Microphone or camera permission was denied. Allow access in your browser settings and retry.";
        if (error?.name === "NotFoundError") return "The requested microphone or camera is not available.";
        if (error?.name === "NotReadableError") return "A device is in use or unavailable. Close other camera applications and retry.";
        return "The operation could not complete. Check your connection and try again.";
    }

    function render() {
        const call = room?.call;
        const inCall = Boolean(call);
        const ready = connected && !pendingRoom;
        ui.sessionControls.hidden = Boolean(room);
        ui.sessionHeading.textContent = room ? "Your session" : "A little closer.";
        ui.networkStatus.textContent = connected ? "Online" : navigator.onLine ? "Disconnected" : "Offline";
        ui.networkStatus.dataset.online = String(connected);
        ui.createBtn.disabled = !ready || Boolean(room);
        ui.joinBtn.disabled = !ready || Boolean(room) || !ui.inviteInput.value.trim();
        ui.inviteInput.disabled = Boolean(room) || pendingRoom;
        ui.leaveBtn.hidden = !room;
        ui.invitationPanel.hidden = !shareUrl || Boolean(room?.peerPresent);
        ui.roomLabel.textContent = room ? (room.peerPresent ? "2 of 2 present" : "1 of 2 present") : "No room joined";
        ui.callBtn.hidden = inCall || pendingMedia;
        ui.callBtn.disabled = !connected || !room?.peerPresent || pendingMedia || Boolean(dialIntent) || pendingRoom;
        ui.endBtn.hidden = !inCall && !pendingMedia;
        ui.endBtn.disabled = ending;
        ui.endLabel.textContent = pendingMedia && !call ? "Cancel" : call?.state === "ringing" ? "Cancel call" : "End call";
        ui.modeControl.disabled = inCall || pendingMedia;
        ui.muteBtn.disabled = !stream || ending;
        const audio = stream?.getAudioTracks()[0];
        const video = stream?.getVideoTracks()[0];
        ui.cameraBtn.disabled = !video || ending;
        ui.muteBtn.setAttribute("aria-pressed", String(Boolean(audio && !audio.enabled)));
        ui.muteBtn.setAttribute("aria-label", audio?.enabled === false ? "Unmute microphone" : "Mute microphone");
        ui.muteBtn.title = ui.muteBtn.getAttribute("aria-label");
        ui.cameraBtn.setAttribute("aria-pressed", String(Boolean(video && !video.enabled)));
        ui.cameraBtn.setAttribute("aria-label", video?.enabled === false ? "Turn camera on" : "Turn camera off");
        ui.cameraBtn.title = ui.cameraBtn.getAttribute("aria-label");
        ui.mutedBadge.hidden = !audio || audio.enabled;
        ui.localEmpty.hidden = Boolean(video?.enabled);
        ui.localLabel.textContent = stream && !video ? "Audio only" : "Camera off";
        ui.localVideo.dataset.live = String(Boolean(video?.enabled));
        const remoteTracks = ui.remoteVideo.srcObject?.getVideoTracks() || [];
        const remoteVideo = remoteTracks.some(track => track.readyState === "live" && !track.muted);
        ui.remoteVideo.dataset.live = String(remoteVideo);
        ui.remoteEmpty.hidden = remoteVideo;
        ui.remoteLabel.textContent = call?.mode === "audio" ? "Audio call" : room?.peerPresent ? "Guest is here" : "No one here yet";
        const localState = peer?.connectionState;
        ui.callStatus.textContent = pendingMedia ? "Waiting for device permission" : localState === "disconnected" ? "Connection interrupted" : call?.state === "active" && localState === "connected" ? "In conversation" : call?.state === "ringing" ? (call.initiator ? "Calling guest" : "Incoming call") : call ? "Connecting call" : room?.peerPresent ? "Ready to call" : room ? "Waiting for guest" : "No active call";
        ui.peerStatus.textContent = room?.peerPresent ? "Guest present" : room ? "Invitation pending" : "Waiting for a session";
        ui.transportStatus.textContent = localState === "connected" ? "Encrypted peer connection" : call ? "Establishing peer connection" : "Not connected";
        ui.acceptBtn.disabled = pendingMedia || ending || pendingRoom;
        const incoming = call?.state === "ringing" && !call.initiator && !ending;
        if (incoming && !ui.incomingDialog.open) ui.incomingDialog.showModal();
        if (!incoming && ui.incomingDialog.open) ui.incomingDialog.close();
        ui.incomingMode.textContent = call?.mode === "audio" ? "Audio call" : "Video call";
        window.dispatchEvent(new Event("direct-state"));
    }

    function destroyMedia() {
        generation++;
        if (dialIntent) dialIntent.cancelled = true;
        pendingMedia = false;
        ending = false;
        clearTimeout(negotiationTimer);
        clearTimeout(disconnectTimer);
        candidates = [];
        offerFor = null;
        if (peer) {
            peer.onicecandidate = null;
            peer.ontrack = null;
            peer.onconnectionstatechange = null;
            peer.close();
            peer = null;
        }
        stream?.getTracks().forEach(track => track.stop());
        stream = null;
        ui.localVideo.srcObject = null;
        ui.remoteVideo.srcObject = null;
        ui.playBtn.hidden = true;
        startedAt = null;
        ui.duration.textContent = "00:00";
    }

    const reasons = { "hangup": "Call ended.", "declined": "Call declined.", "cancelled": "Call cancelled.", "timeout": "The call timed out. If a direct connection could not be established, try another network; this app does not relay media.", "failed": "The direct connection failed. Try another network; this app does not relay media.", "device-error": "The call ended because a device became unavailable.", "peer-left": "The session ended. Create or request a new invitation.", "invite-expired": "The invitation expired. Create a new invitation." };

    function apply(snapshot) {
        if (!snapshot || (room && snapshot.roomId !== room.roomId) || (!room && joiningRoom !== snapshot.roomId)) return;
        if (room && snapshot.version < room.version) return;
        const previous = room?.call?.id;
        if ((previous && previous !== snapshot.call?.id) || (!previous && snapshot.call && !snapshot.call.initiator)) destroyMedia();
        room = snapshot;
        if (snapshot.reason) notice(reasons[snapshot.reason] || "Session updated.", snapshot.reason === "failed" || snapshot.reason === "timeout");
        if (snapshot.state === "closed") {
            destroyMedia();
            room = null;
            joiningRoom = null;
            shareUrl = "";
            ui.shareLink.value = "";
        }
        if (room?.peerPresent) { shareUrl = ""; ui.shareLink.value = ""; }
        render();
        if (room?.call?.initiator && dialIntent?.cancelled && room.roomId === dialIntent.roomId) {
            if (!ending) void finish("cancelled", room.call.state === "ringing" ? "CancelCall" : "EndCall");
            return;
        }
        if (room?.call && room.call.state === "negotiating" && room.call.initiator && offerFor !== room.call.id) {
            const callId = room.call.id;
            offerFor = callId;
            enqueue(async () => {
                if (room?.call?.id !== callId) return;
                const context = preparePeer();
                const offer = await context.peer.createOffer();
                if (!valid(context)) return;
                await context.peer.setLocalDescription(offer);
                if (valid(context)) await connection.invoke("SendOffer", context.roomId, context.callId, { type: "offer", sdp: context.peer.localDescription.sdp });
            });
        }
    }

    function enqueue(action) {
        const currentCall = room?.call?.id;
        queue = queue.then(action).catch(async () => {
            if (currentCall && room?.call?.id === currentCall) {
                notice("The direct connection failed. Try another network; this app does not relay media.", true);
                await finish("failed");
            }
        });
    }

    function valid(context) {
        return generation === context.generation && peer === context.peer && room?.roomId === context.roomId && room?.call?.id === context.callId && !ending;
    }

    function preparePeer() {
        if (!room?.call || room.call.state === "ringing" || !stream) throw new Error("Media not ready");
        if (peer) return { peer, roomId: room.roomId, callId: room.call.id, generation };
        peer = new RTCPeerConnection(config);
        const context = { peer, roomId: room.roomId, callId: room.call.id, generation };
        const remote = new MediaStream();
        ui.remoteVideo.srcObject = remote;
        stream.getTracks().forEach(track => context.peer.addTrack(track, stream));
        context.peer.onicecandidate = event => {
            if (event.candidate && valid(context)) {
                connection.invoke("SendIceCandidate", context.roomId, context.callId, event.candidate.toJSON()).catch(() => {
                    if (valid(context)) void finish("failed");
                });
            }
        };
        context.peer.ontrack = event => {
            if (!valid(context)) return;
            if (!remote.getTracks().some(track => track.id === event.track.id)) remote.addTrack(event.track);
            event.track.onunmute = render;
            event.track.onmute = render;
            event.track.onended = render;
            ui.remoteVideo.play().catch(() => { if (valid(context)) ui.playBtn.hidden = false; });
            render();
        };
        context.peer.onconnectionstatechange = () => {
            if (!valid(context)) return;
            render();
            if (context.peer.connectionState === "connected") {
                clearTimeout(negotiationTimer);
                clearTimeout(disconnectTimer);
                startedAt ??= Date.now();
                enqueue(async () => {
                    if (valid(context)) apply(await connection.invoke("CallConnected", context.roomId, context.callId));
                });
            } else if (context.peer.connectionState === "failed") void finish("failed");
            else if (context.peer.connectionState === "disconnected") {
                clearTimeout(disconnectTimer);
                disconnectTimer = setTimeout(() => { if (valid(context)) void finish("failed"); }, 8000);
            }
        };
        negotiationTimer = setTimeout(() => { if (valid(context)) void finish("timeout"); }, negotiationSeconds * 1000);
        return context;
    }

    async function flushCandidates(context) {
        while (candidates.length && valid(context)) await context.peer.addIceCandidate(candidates.shift());
    }

    for (const event of ["PeerJoined", "PeerLeft", "IncomingCall", "CallAccepted", "CallDeclined", "CallCancelled", "CallEnded", "CallActive"]) connection.on(event, apply);
    for (const event of ["ReceiveOffer", "ReceiveAnswer", "ReceiveIceCandidate"]) {
        connection.on(event, envelope => enqueue(async () => {
            if (!room?.call || envelope.roomId !== room.roomId || envelope.callId !== room.call.id || envelope.version > room.version || room.call.state === "ringing") return;
            const context = preparePeer();
            if (event === "ReceiveIceCandidate") {
                if (!context.peer.remoteDescription) {
                    if (candidates.length >= 256) throw new Error("Candidate limit");
                    candidates.push(envelope.payload);
                } else await context.peer.addIceCandidate(envelope.payload);
                return;
            }
            await context.peer.setRemoteDescription(envelope.payload);
            if (!valid(context)) return;
            await flushCandidates(context);
            if (event === "ReceiveOffer" && valid(context)) {
                const answer = await context.peer.createAnswer();
                if (!valid(context)) return;
                await context.peer.setLocalDescription(answer);
                if (valid(context)) await connection.invoke("SendAnswer", context.roomId, context.callId, { type: "answer", sdp: context.peer.localDescription.sdp });
            }
        }));
    }

    async function capture(mode) {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
            throw new Error("unsupported");
        }
        return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: mode === "video" ? { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } } : false });
    }

    function attachLocal(acquired) {
        stream = acquired;
        ui.localVideo.srcObject = acquired;
        acquired.getTracks().forEach(track => track.addEventListener("ended", () => { if (stream === acquired && room?.call) void finish("device-error"); }));
        ui.localVideo.play().catch(() => {});
        render();
    }

    async function dial(mode = document.querySelector('input[name="mode"]:checked').value) {
        if (!connected || !room?.peerPresent || room.call || pendingMedia || dialIntent || pendingRoom) return;
        notice("");
        ui.audioRetryBtn.hidden = true;
        pendingMedia = true;
        const ticket = ++generation;
        const roomId = room.roomId;
        const intent = { roomId, cancelled: false };
        dialIntent = intent;
        render();
        try {
            const acquired = await capture(mode);
            if (generation !== ticket || room?.roomId !== roomId || room?.call) { acquired.getTracks().forEach(track => track.stop()); return; }
            attachLocal(acquired);
            const snapshot = await connection.invoke("RequestCall", roomId, mode);
            apply(snapshot);
        } catch (error) {
            if (generation !== ticket) return;
            destroyMedia();
            notice(error.message === "unsupported" ? "Calling requires a supported browser and HTTPS (or localhost)." : errorMessage(error), true);
            ui.audioRetryBtn.hidden = mode !== "video" || !room?.peerPresent || Boolean(room?.call);
        } finally {
            if (generation === ticket) pendingMedia = false;
            if (dialIntent === intent) dialIntent = null;
            render();
        }
    }

    async function accept() {
        const call = room?.call;
        if (!call || call.initiator || call.state !== "ringing" || pendingMedia) return;
        pendingMedia = true;
        const ticket = ++generation;
        render();
        try {
            const acquired = await capture(call.mode);
            if (generation !== ticket || room?.call?.id !== call.id || room.call.state !== "ringing") { acquired.getTracks().forEach(track => track.stop()); return; }
            attachLocal(acquired);
            apply(await connection.invoke("AcceptCall", room.roomId, call.id));
        } catch (error) {
            if (generation !== ticket) return;
            const message = error.message === "unsupported" ? "Calling requires a supported browser and HTTPS (or localhost)." : errorMessage(error);
            await finish("device-error");
            notice(message, true);
            ui.audioRetryBtn.hidden = call.mode !== "video" || !room?.peerPresent;
        } finally {
            if (generation === ticket) pendingMedia = false;
            render();
        }
    }

    async function finish(reason = "hangup", method = "EndCall") {
        const previousRoom = room;
        const call = room?.call;
        destroyMedia();
        if (!call) { render(); return; }
        ending = true;
        render();
        try {
            if (connected) {
                const args = method === "EndCall" ? [previousRoom.roomId, call.id, reason] : [previousRoom.roomId, call.id];
                apply(await connection.invoke(method, ...args));
            }
        } catch (error) { notice(errorMessage(error), true); }
        finally { ending = false; render(); }
    }

    function lost() {
        connected = false;
        pendingRoom = false;
        joiningRoom = null;
        destroyMedia();
        room = null;
        shareUrl = "";
        ui.shareLink.value = "";
        ui.audioRetryBtn.hidden = true;
        notice(navigator.onLine ? "Signaling disconnected. The call ended; create or request a new invitation after reconnecting." : "Offline. Calls are unavailable until signaling reconnects.", true);
        render();
    }

    async function startConnection() {
        if (connection.state !== signalR.HubConnectionState.Disconnected) return;
        clearTimeout(retryTimer);
        try {
            await connection.start();
            connected = true;
            notice("");
            render();
        } catch {
            connected = false;
            notice(navigator.onLine ? "Cannot connect to signaling. Retrying shortly." : "Offline. Calls are unavailable.", true);
            render();
            retryTimer = setTimeout(startConnection, 5000);
        }
    }
    connection.onreconnecting(lost);
    connection.onreconnected(() => { connected = true; notice("Reconnected. Create or request a new invitation."); render(); });
    connection.onclose(() => { lost(); retryTimer = setTimeout(startConnection, 5000); });

    async function enter(create) {
        if (pendingRoom || room || !connected) return;
        pendingRoom = true;
        notice("");
        render();
        try {
            let admission;
            if (create) admission = await connection.invoke("CreateRoom");
            else {
                const url = new URL(ui.inviteInput.value.trim(), location.origin);
                const params = new URLSearchParams(url.hash.slice(1));
                const roomId = params.get("room");
                const secret = params.get("key");
                if (url.origin !== location.origin || !/^[a-f0-9]{64}$/.test(roomId || "") || !/^[a-f0-9]{64}$/.test(secret || "")) throw new Error("invalid-link");
                joiningRoom = roomId;
                admission = await connection.invoke("JoinRoom", roomId, secret);
            }
            config = { iceServers: admission.stunUrls.length ? [{ urls: admission.stunUrls }] : [] };
            negotiationSeconds = admission.negotiationTimeoutSeconds;
            joiningRoom = admission.room.roomId;
            apply(admission.room);
            if (admission.inviteSecret) {
                const link = new URL("/", location.origin);
                link.hash = new URLSearchParams({ room: admission.room.roomId, key: admission.inviteSecret }).toString();
                shareUrl = link.href;
                ui.shareLink.value = shareUrl;
            }
            ui.inviteInput.value = "";
            history.replaceState(null, "", location.pathname);
        } catch (error) {
            notice(error.message === "invalid-link" ? "Enter a complete invitation link from this application." : errorMessage(error), true);
        } finally { pendingRoom = false; render(); }
    }

    ui.createBtn.addEventListener("click", () => void enter(true));
    ui.joinForm.addEventListener("submit", event => { event.preventDefault(); void enter(false); });
    ui.inviteInput.addEventListener("input", render);
    ui.callBtn.addEventListener("click", () => void dial());
    ui.audioRetryBtn.addEventListener("click", () => { document.querySelector('input[name="mode"][value="audio"]').checked = true; void dial("audio"); });
    ui.acceptBtn.addEventListener("click", () => void accept());
    ui.declineBtn.addEventListener("click", () => void finish("declined", "DeclineCall"));
    ui.incomingDialog.addEventListener("cancel", event => { event.preventDefault(); void finish("declined", "DeclineCall"); });
    ui.endBtn.addEventListener("click", () => void finish("cancelled", room?.call?.state === "ringing" && room.call.initiator ? "CancelCall" : "EndCall"));
    ui.muteBtn.addEventListener("click", () => { stream?.getAudioTracks().forEach(track => { track.enabled = !track.enabled; }); render(); });
    ui.cameraBtn.addEventListener("click", () => { stream?.getVideoTracks().forEach(track => { track.enabled = !track.enabled; }); render(); });
    ui.playBtn.addEventListener("click", async () => { try { await ui.remoteVideo.play(); ui.playBtn.hidden = true; } catch { notice("Playback is blocked by the browser. Check site audio permissions.", true); } });
    ui.leaveBtn.addEventListener("click", async () => {
        if (!room) return;
        const roomId = room.roomId;
        destroyMedia();
        try { await connection.invoke("LeaveRoom", roomId); } catch (error) { notice(errorMessage(error), true); }
        room = null;
        joiningRoom = null;
        shareUrl = "";
        ui.shareLink.value = "";
        render();
    });
    ui.copyBtn.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(shareUrl); notice("Invitation copied."); }
        catch { ui.shareLink.select(); notice("Clipboard access is unavailable. The invitation is selected."); }
    });
    ui.shareBtn.hidden = !navigator.share;
    ui.shareBtn.addEventListener("click", async () => { try { await navigator.share({ title: "Direct invitation", url: shareUrl }); } catch (error) { if (error.name !== "AbortError") notice("Sharing is unavailable. Copy the invitation instead."); } });
    window.addEventListener("offline", () => { lost(); void connection.stop(); });
    window.addEventListener("online", () => void startConnection());
    document.addEventListener("visibilitychange", async () => {
        if (document.visibilityState !== "visible") return;
        if (connected && room) {
            try { apply(await connection.invoke("GetState", room.roomId)); } catch { lost(); await connection.stop(); void startConnection(); }
        } else void startConnection();
    });
    window.addEventListener("pagehide", () => { destroyMedia(); void connection.stop(); });
    window.addEventListener("pageshow", event => { if (event.persisted) { lost(); void startConnection(); } });
    setInterval(() => {
        if (!startedAt) return;
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        ui.duration.textContent = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
    }, 1000);
    function readInvitation() {
        if (!location.hash) return;
        if (room) notice("Leave the current room before opening another invitation.");
        else ui.inviteInput.value = location.href;
        history.replaceState(null, "", location.pathname);
        render();
    }
    window.addEventListener("hashchange", readInvitation);
    readInvitation();
    window.directApp = {
        isBusy: () => Boolean(room?.call) || pendingMedia || pendingRoom || Boolean(dialIntent),
        diagnostics: async () => {
            const result = { state: room?.state || "idle", connection: peer?.connectionState || "closed", mode: room?.call?.mode || null,
                localTracks: stream?.getTracks().map(track => ({ kind: track.kind, enabled: track.enabled, state: track.readyState })) || [],
                remoteTracks: ui.remoteVideo.srcObject?.getTracks().map(track => ({ kind: track.kind, state: track.readyState })) || [], selectedPair: null };
            if (peer) {
                const stats = await peer.getStats();
                const transport = [...stats.values()].find(item => item.type === "transport" && item.selectedCandidatePairId);
                const pair = transport ? stats.get(transport.selectedCandidatePairId) : [...stats.values()].find(item => item.type === "candidate-pair" && item.nominated && item.state === "succeeded");
                if (pair) result.selectedPair = { local: stats.get(pair.localCandidateId)?.candidateType, remote: stats.get(pair.remoteCandidateId)?.candidateType, bytesSent: pair.bytesSent, bytesReceived: pair.bytesReceived };
            }
            return result;
        }
    };
    render();
    void startConnection();
})();