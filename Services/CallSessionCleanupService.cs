namespace Signalr.Services;

public sealed class CallSessionCleanupService(CallSessionService sessions) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(2));
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken)) await sessions.Sweep();
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }
}