using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;
using Signalr.Models;

namespace Signalr.Services;

public sealed class CallSessionService(IHubContext<VideoHub> hub, IOptions<CallOptions> settings)
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly Dictionary<string, Room> rooms = new();
    private readonly Dictionary<string, Client> clients = new();
    private readonly CallOptions options = settings.Value;

    private sealed class Client
    {
        public string? RoomId;
        public DateTimeOffset Window = DateTimeOffset.UtcNow;
        public int Messages;
        public readonly Queue<DateTimeOffset> Creations = new();
    }

    private sealed class Room(string id, string host, byte[] secretHash, DateTimeOffset expires)
    {
        public string Id = id;
        public string Host = host;
        public string? Guest;
        public byte[]? SecretHash = secretHash;
        public DateTimeOffset Expires = expires;
        public long Version = 1;
        public Call? Call;
        public DateTimeOffset Window = DateTimeOffset.UtcNow;
        public int Messages;
    }

    private sealed class Call(string id, string initiator, string mode)
    {
        public string Id = id;
        public string Initiator = initiator;
        public string Mode = mode;
        public string State = "ringing";
        public DateTimeOffset Started = DateTimeOffset.UtcNow;
        public bool OfferSent;
        public bool AnswerSent;
    }

    private async Task<T> Locked<T>(Func<Task<T>> action)
    {
        await gate.WaitAsync();
        try { return await action(); }
        finally { gate.Release(); }
    }

    public Task<bool> Register(string connection) => Locked(() =>
    {
        if (clients.Count >= 2000) throw new HubException("capacity");
        clients[connection] = new Client();
        return Task.FromResult(true);
    });

    private Client CheckClient(string connection)
    {
        if (!clients.TryGetValue(connection, out var client)) throw new HubException("session-lost");
        var now = DateTimeOffset.UtcNow;
        if (now - client.Window > TimeSpan.FromSeconds(10)) { client.Window = now; client.Messages = 0; }
        if (++client.Messages > 160) throw new HubException("rate-limited");
        return client;
    }

    private Room Member(string connection, string roomId)
    {
        var client = CheckClient(connection);
        if (string.IsNullOrEmpty(roomId) || roomId.Length > 64 || client.RoomId != roomId ||
            !rooms.TryGetValue(roomId, out var room) || (room.Host != connection && room.Guest != connection))
            throw new HubException("invalid-session");
        var now = DateTimeOffset.UtcNow;
        if (now - room.Window > TimeSpan.FromSeconds(10)) { room.Window = now; room.Messages = 0; }
        if (++room.Messages > 320) throw new HubException("rate-limited");
        return room;
    }

    private static string RandomId() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
    private static string Peer(Room room, string connection) =>
        (connection == room.Host ? room.Guest : room.Host) ?? throw new HubException("peer-unavailable");

    private static RoomSnapshot Snapshot(Room room, string connection, string? reason = null, bool closed = false) =>
        new(room.Id, room.Version, room.Host == connection ? "host" : "guest", !closed && room.Guest != null,
            closed ? "closed" : room.Call?.State ?? (room.Guest == null ? "waiting" : "ready"),
            closed || room.Call == null ? null : new CallInfo(room.Call.Id, room.Call.Mode, room.Call.State,
                room.Call.Initiator == connection), reason);

    private async Task Notify(Room room, string eventName, string? reason = null, bool closed = false)
    {
        await hub.Clients.Client(room.Host).SendAsync(eventName, Snapshot(room, room.Host, reason, closed));
        if (room.Guest != null)
            await hub.Clients.Client(room.Guest).SendAsync(eventName, Snapshot(room, room.Guest, reason, closed));
    }

    private RoomAdmission Admission(Room room, string connection, string? secret = null) =>
        new(Snapshot(room, connection), secret, options.StunUrls, options.NegotiationTimeoutSeconds);

    public Task<RoomAdmission> Create(string connection) => Locked(() =>
    {
        var client = CheckClient(connection);
        if (client.RoomId != null) throw new HubException("already-joined");
        if (rooms.Count >= options.MaxRooms) throw new HubException("capacity");
        var now = DateTimeOffset.UtcNow;
        while (client.Creations.TryPeek(out var oldest) && now - oldest > TimeSpan.FromMinutes(1)) client.Creations.Dequeue();
        if (client.Creations.Count >= 3) throw new HubException("rate-limited");
        client.Creations.Enqueue(now);
        var secret = RandomId();
        var room = new Room(RandomId(), connection, SHA256.HashData(Encoding.UTF8.GetBytes(secret)),
            now.AddSeconds(options.InviteLifetimeSeconds));
        rooms.Add(room.Id, room);
        client.RoomId = room.Id;
        return Task.FromResult(Admission(room, connection, secret));
    });

    public Task<RoomAdmission> Join(string connection, string roomId, string secret) => Locked(async () =>
    {
        var client = CheckClient(connection);
        if (client.RoomId != null) throw new HubException("already-joined");
        if (string.IsNullOrEmpty(roomId) || roomId.Length != 64 || string.IsNullOrEmpty(secret) || secret.Length != 64 ||
            !rooms.TryGetValue(roomId, out var room) || room.Guest != null || room.SecretHash == null ||
            DateTimeOffset.UtcNow >= room.Expires ||
            !CryptographicOperations.FixedTimeEquals(room.SecretHash, SHA256.HashData(Encoding.UTF8.GetBytes(secret))))
            throw new HubException("invite-unavailable");
        room.Guest = connection;
        room.SecretHash = null;
        client.RoomId = room.Id;
        room.Version++;
        await Notify(room, "PeerJoined");
        return Admission(room, connection);
    });

    public Task<RoomSnapshot> Request(string connection, string roomId, string mode) => Locked(async () =>
    {
        var room = Member(connection, roomId);
        if (mode is not ("audio" or "video")) throw new HubException("invalid-mode");
        _ = Peer(room, connection);
        if (room.Call != null) throw new HubException("busy");
        room.Call = new Call(RandomId(), connection, mode);
        room.Version++;
        await Notify(room, "IncomingCall");
        return Snapshot(room, connection);
    });

    private static Call Current(Room room, string callId)
    {
        if (room.Call == null || room.Call.Id != callId) throw new HubException("stale-call");
        return room.Call;
    }

    public Task<RoomSnapshot> Accept(string connection, string roomId, string callId) => Locked(async () =>
    {
        var room = Member(connection, roomId);
        var call = Current(room, callId);
        if (call.Initiator == connection || call.State != "ringing") throw new HubException("invalid-state");
        if (DateTimeOffset.UtcNow - call.Started >= TimeSpan.FromSeconds(options.RingTimeoutSeconds))
            throw new HubException("call-expired");
        call.State = "negotiating";
        call.Started = DateTimeOffset.UtcNow;
        room.Version++;
        await Notify(room, "CallAccepted");
        return Snapshot(room, connection);
    });

    public Task<RoomSnapshot> End(string connection, string roomId, string callId, string action, string reason) => Locked(async () =>
    {
        var room = Member(connection, roomId);
        if (room.Call == null) return Snapshot(room, connection);
        var call = Current(room, callId);
        if (action == "decline" && (call.Initiator == connection || call.State != "ringing")) throw new HubException("invalid-state");
        if (action == "cancel" && (call.Initiator != connection || call.State != "ringing")) throw new HubException("invalid-state");
        if (reason is not ("hangup" or "declined" or "cancelled" or "failed" or "timeout" or "device-error"))
            throw new HubException("invalid-reason");
        room.Call = null;
        room.Version++;
        await Notify(room, action == "decline" ? "CallDeclined" : action == "cancel" ? "CallCancelled" : "CallEnded", reason);
        return Snapshot(room, connection, reason);
    });

    public Task<bool> Description(string connection, string roomId, string callId, SessionDescription description, bool offer) => Locked(async () =>
    {
        var room = Member(connection, roomId);
        var call = Current(room, callId);
        if (description == null || description.Type != (offer ? "offer" : "answer") ||
            string.IsNullOrWhiteSpace(description.Sdp) || description.Sdp.Length > 48000)
            throw new HubException("invalid-description");
        if (call.State != "negotiating" || (call.Initiator == connection) != offer ||
            (offer ? call.OfferSent : !call.OfferSent || call.AnswerSent)) throw new HubException("invalid-state");
        if (offer) call.OfferSent = true;
        else call.AnswerSent = true;
        await hub.Clients.Client(Peer(room, connection)).SendAsync(offer ? "ReceiveOffer" : "ReceiveAnswer",
            new SignalEnvelope<SessionDescription>(room.Id, room.Version, call.Id, description));
        return true;
    });

    public Task<bool> Candidate(string connection, string roomId, string callId, IceCandidate candidate) => Locked(async () =>
    {
        var room = Member(connection, roomId);
        var call = Current(room, callId);
        if (call.State is not ("negotiating" or "active")) throw new HubException("invalid-state");
        if (candidate == null || string.IsNullOrWhiteSpace(candidate.Candidate) || candidate.Candidate.Length > 2048 ||
            candidate.SdpMid?.Length > 256 || candidate.UsernameFragment?.Length > 256 ||
            candidate.SdpMLineIndex is < 0 or > 32 || (candidate.SdpMid == null && candidate.SdpMLineIndex == null))
            throw new HubException("invalid-candidate");
        await hub.Clients.Client(Peer(room, connection)).SendAsync("ReceiveIceCandidate",
            new SignalEnvelope<IceCandidate>(room.Id, room.Version, call.Id, candidate));
        return true;
    });

    public Task<RoomSnapshot> Connected(string connection, string roomId, string callId) => Locked(async () =>
    {
        var room = Member(connection, roomId);
        var call = Current(room, callId);
        if (!call.AnswerSent || call.State is not ("negotiating" or "active")) throw new HubException("invalid-state");
        if (call.State != "active")
        {
            call.State = "active";
            room.Version++;
            await Notify(room, "CallActive");
        }
        return Snapshot(room, connection);
    });

    public Task<RoomSnapshot> GetState(string connection, string roomId) => Locked(() =>
        Task.FromResult(Snapshot(Member(connection, roomId), connection)));

    private async Task Close(Room room, string reason)
    {
        rooms.Remove(room.Id);
        if (clients.TryGetValue(room.Host, out var host)) host.RoomId = null;
        if (room.Guest != null && clients.TryGetValue(room.Guest, out var guest)) guest.RoomId = null;
        room.Version++;
        await Notify(room, "PeerLeft", reason, true);
    }

    public Task<bool> Leave(string connection, string? roomId = null, bool disconnected = false) => Locked(async () =>
    {
        if (!clients.TryGetValue(connection, out var client)) return true;
        if (!disconnected) CheckClient(connection);
        if (client.RoomId != null && (disconnected || client.RoomId == roomId) && rooms.TryGetValue(client.RoomId, out var room))
            await Close(room, "peer-left");
        if (disconnected) clients.Remove(connection);
        return true;
    });

    public Task<bool> Sweep() => Locked(async () =>
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var room in rooms.Values.ToArray())
        {
            if (room.Guest == null && now >= room.Expires) { await Close(room, "invite-expired"); continue; }
            if (room.Call is not { } call) continue;
            var timeout = call.State == "ringing" ? options.RingTimeoutSeconds : options.NegotiationTimeoutSeconds;
            if (call.State != "active" && now - call.Started >= TimeSpan.FromSeconds(timeout))
            {
                room.Call = null;
                room.Version++;
                await Notify(room, "CallEnded", "timeout");
            }
        }
        return true;
    });
}