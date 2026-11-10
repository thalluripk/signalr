namespace Signalr.Models;

public sealed class CallOptions
{
    public string[] StunUrls { get; set; } = ["stun:stun.l.google.com:19302"];
    public int InviteLifetimeSeconds { get; set; } = 600;
    public int RingTimeoutSeconds { get; set; } = 30;
    public int NegotiationTimeoutSeconds { get; set; } = 45;
    public int MaxRooms { get; set; } = 500;
}

public sealed record CallInfo(string Id, string Mode, string State, bool Initiator);
public sealed record RoomSnapshot(string RoomId, long Version, string Role, bool PeerPresent,
    string State, CallInfo? Call, string? Reason);
public sealed record RoomAdmission(RoomSnapshot Room, string? InviteSecret, string[] StunUrls,
    int NegotiationTimeoutSeconds);
public sealed record SessionDescription(string Type, string Sdp);
public sealed record IceCandidate(string Candidate, string? SdpMid, int? SdpMLineIndex, string? UsernameFragment);
public sealed record SignalEnvelope<T>(string RoomId, long Version, string CallId, T Payload);