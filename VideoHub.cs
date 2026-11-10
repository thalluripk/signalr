using Microsoft.AspNetCore.SignalR;
using Signalr.Models;
using Signalr.Services;

public sealed class VideoHub(CallSessionService sessions) : Hub
{
    public override async Task OnConnectedAsync()
    {
        try { await sessions.Register(Context.ConnectionId); }
        catch { Context.Abort(); throw; }
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        await sessions.Leave(Context.ConnectionId, disconnected: true);
        await base.OnDisconnectedAsync(exception);
    }

    public Task<RoomAdmission> CreateRoom() => sessions.Create(Context.ConnectionId);
    public Task<RoomAdmission> JoinRoom(string roomId, string inviteSecret) => sessions.Join(Context.ConnectionId, roomId, inviteSecret);
    public Task<RoomSnapshot> RequestCall(string roomId, string mode) => sessions.Request(Context.ConnectionId, roomId, mode);
    public Task<RoomSnapshot> AcceptCall(string roomId, string callId) => sessions.Accept(Context.ConnectionId, roomId, callId);
    public Task<RoomSnapshot> DeclineCall(string roomId, string callId) => sessions.End(Context.ConnectionId, roomId, callId, "decline", "declined");
    public Task<RoomSnapshot> CancelCall(string roomId, string callId) => sessions.End(Context.ConnectionId, roomId, callId, "cancel", "cancelled");
    public Task<RoomSnapshot> EndCall(string roomId, string callId, string reason) => sessions.End(Context.ConnectionId, roomId, callId, "end", reason);
    public Task<bool> SendOffer(string roomId, string callId, SessionDescription description) => sessions.Description(Context.ConnectionId, roomId, callId, description, true);
    public Task<bool> SendAnswer(string roomId, string callId, SessionDescription description) => sessions.Description(Context.ConnectionId, roomId, callId, description, false);
    public Task<bool> SendIceCandidate(string roomId, string callId, IceCandidate candidate) => sessions.Candidate(Context.ConnectionId, roomId, callId, candidate);
    public Task<RoomSnapshot> CallConnected(string roomId, string callId) => sessions.Connected(Context.ConnectionId, roomId, callId);
    public Task<RoomSnapshot> GetState(string roomId) => sessions.GetState(Context.ConnectionId, roomId);
    public Task<bool> LeaveRoom(string roomId) => sessions.Leave(Context.ConnectionId, roomId);
}