using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;
using Signalr.Models;
using Signalr.Services;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSignalR(options =>
{
	options.MaximumReceiveMessageSize = 64 * 1024;
	options.EnableDetailedErrors = false;
	options.ClientTimeoutInterval = TimeSpan.FromSeconds(30);
	options.KeepAliveInterval = TimeSpan.FromSeconds(10);
});
builder.Services.AddOptions<CallOptions>().BindConfiguration("Calls")
	.Validate(options => options.InviteLifetimeSeconds is >= 30 and <= 3600 &&
		options.RingTimeoutSeconds is >= 5 and <= 120 && options.NegotiationTimeoutSeconds is >= 10 and <= 120 &&
		options.MaxRooms is >= 1 and <= 5000 && options.StunUrls.Length <= 5 &&
		options.StunUrls.All(url => !string.IsNullOrWhiteSpace(url) && url.Length <= 256 && url.StartsWith("stun:", StringComparison.Ordinal)),
		"Invalid call limits or STUN URLs.").ValidateOnStart();
builder.Services.AddSingleton<CallSessionService>();
builder.Services.AddHostedService<CallSessionCleanupService>();
builder.Services.AddRateLimiter(options =>
{
	options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
	options.AddPolicy("signaling", context => RateLimitPartition.GetFixedWindowLimiter(
		context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
		_ => new FixedWindowRateLimiterOptions { PermitLimit = 120, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 }));
});

var app = builder.Build();
if (!app.Environment.IsDevelopment()) app.UseHsts();
app.UseHttpsRedirection();
app.Use(async (context, next) =>
{
	context.Response.Headers["X-Content-Type-Options"] = "nosniff";
	context.Response.Headers["Referrer-Policy"] = "no-referrer";
	context.Response.Headers["Permissions-Policy"] = "camera=(self), microphone=(self)";
	context.Response.Headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
	if (context.Request.Path.StartsWithSegments("/videohub"))
	{
		context.Response.Headers.CacheControl = "no-store";
		var origin = context.Request.Headers.Origin.ToString();
		var expected = $"{context.Request.Scheme}://{context.Request.Host}";
		if (!string.IsNullOrEmpty(origin) && !string.Equals(origin, expected, StringComparison.OrdinalIgnoreCase))
		{
			context.Response.StatusCode = StatusCodes.Status403Forbidden;
			return;
		}
	}
	await next();
});
app.UseDefaultFiles();
app.UseStaticFiles(new StaticFileOptions
{
	OnPrepareResponse = context => context.Context.Response.Headers.CacheControl = "no-cache"
});
app.UseRouting();
app.UseRateLimiter();
app.MapHub<VideoHub>("/videohub").RequireRateLimiting("signaling");
app.Run();