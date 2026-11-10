using Microsoft.AspNetCore.SignalR;

public class VideoHub : Hub
{
    public async Task JoinRoom(string roomId)
    {
        await Groups.AddToGroupAsync(
            Context.ConnectionId,
            roomId);
    }

    public async Task SendOffer(
        string roomId,
        string offer)
    {
        await Clients.OthersInGroup(roomId)
            .SendAsync("ReceiveOffer", offer);
    }

    public async Task SendAnswer(
        string roomId,
        string answer)
    {
        await Clients.OthersInGroup(roomId)
            .SendAsync("ReceiveAnswer", answer);
    }

    public async Task SendIceCandidate(
        string roomId,
        string candidate)
    {
        await Clients.OthersInGroup(roomId)
            .SendAsync(
                "ReceiveIceCandidate",
                candidate);
    }
}