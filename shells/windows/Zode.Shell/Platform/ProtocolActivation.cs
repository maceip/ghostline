// Platform/ProtocolActivation.cs — the `zode://` deep link handler.
//
// The MSIX manifest registers the `zode` protocol, so Windows starts the app
// with the URI as the first command line argument.  For the unpackaged build
// the protocol can be registered per-user (see RegisterProtocol) — that is
// optional and opt-in, because it writes to HKCU.

using System.Text.Json.Nodes;
using Zode.Shell.Attachments;
using Zode.Shell.Bridge;
using Zode.Shell.Diagnostics;
using Microsoft.Win32;

namespace Zode.Shell.Platform;

internal sealed class ProtocolActivation
{
    public const string Scheme = "zode";

    private readonly IBridgeEventSink _sink;
    private readonly IntentService _intents;

    public ProtocolActivation(IBridgeEventSink sink, IntentService intents)
    {
        _sink = sink;
        _intents = intents;
    }

    /// <summary>Extracts a zode:// URI from the command line, if any.</summary>
    public static Uri? FindDeepLink(IReadOnlyList<string> args)
    {
        foreach (string arg in args)
        {
            if (TryParse(arg, out Uri? uri))
            {
                return uri;
            }
        }

        return null;
    }

    public static bool TryParse(string? value, out Uri? uri)
    {
        uri = null;
        if (string.IsNullOrWhiteSpace(value))
        {
            return false;
        }

        if (!Uri.TryCreate(value, UriKind.Absolute, out Uri? parsed))
        {
            return false;
        }

        if (!string.Equals(parsed.Scheme, Scheme, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        uri = parsed;
        return true;
    }

    /// <summary>
    /// Routes a deep link: the raw URL always reaches the page as a "deepLink"
    /// event; known URLs additionally raise a "search" or an "intent" event.
    /// </summary>
    public void Handle(Uri uri)
    {
        string url = uri.ToString();
        _sink.Emit(EventNames.DeepLink, new JsonObject { ["url"] = url });

        string host = uri.Host.ToLowerInvariant();
        string path = uri.AbsolutePath.Trim('/');
        var query = ParseQuery(uri.Query);

        switch (host)
        {
            case NotificationService.NotificationHost:
                // A toast activation (contract §9).  The notification id and
                // the action the user picked travel in the query string.
                _sink.Emit(EventNames.NotificationAction, new JsonObject
                {
                    ["id"] = query.TryGetValue("id", out string? notificationId) ? notificationId : string.Empty,
                    ["action"] = query.TryGetValue("action", out string? action) ? action : "open",
                });
                break;

            case "search":
                _sink.Emit(EventNames.Search, new JsonObject
                {
                    ["query"] = query.TryGetValue("q", out string? q) ? q : path,
                });
                break;

            case "play":
                _intents.RaiseExternal(IntentService.Play, new JsonObject
                {
                    ["id"] = path,
                    ["kind"] = "track",
                });
                break;

            case "pause":
                _intents.RaiseExternal(IntentService.Pause, new JsonObject());
                break;

            case "next":
                _intents.RaiseExternal(IntentService.Next, new JsonObject());
                break;

            case "previous":
                _intents.RaiseExternal(IntentService.Previous, new JsonObject());
                break;

            case "show":
                _intents.RaiseExternal(IntentService.Show, new JsonObject
                {
                    ["view"] = path.Length > 0 ? path : "library",
                });
                break;

            case "agent":
                if (string.Equals(path, "stop", StringComparison.OrdinalIgnoreCase))
                {
                    _intents.RaiseExternal(IntentService.AgentStop, new JsonObject());
                }
                else
                {
                    _intents.RaiseExternal(IntentService.AgentNewTask, new JsonObject
                    {
                        ["prompt"] = query.TryGetValue("prompt", out string? prompt) ? prompt : string.Empty,
                    });
                }

                break;

            case "attach":
                // Contract §4: zode.attach carries a list of attachments.
                _intents.RaiseExternal(IntentService.Attach, new JsonObject
                {
                    ["attachments"] = new JsonArray(
                        AttachmentFactory.FromPath(path, AttachmentSources.Intent).ToJson()),
                });
                break;

            default:
                Log.Info("protocol", $"deep link '{url}' forwarded to the app.");
                break;
        }
    }

    private static Dictionary<string, string> ParseQuery(string query)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (string.IsNullOrEmpty(query))
        {
            return result;
        }

        foreach (string pair in query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            int separator = pair.IndexOf('=');
            if (separator <= 0)
            {
                continue;
            }

            string key = Uri.UnescapeDataString(pair[..separator]);
            string value = Uri.UnescapeDataString(pair[(separator + 1)..]);
            result[key] = value;
        }

        return result;
    }

    /// <summary>
    /// Optional, per-user registration of the `zode://` protocol for the
    /// UNPACKAGED build (writes HKCU\Software\Classes\zode).  The MSIX build
    /// declares the protocol in its manifest instead, so this is only a
    /// convenience for developers running the unpackaged build.
    /// </summary>
    public static bool RegisterProtocol()
    {
        try
        {
            string? exe = Environment.ProcessPath;
            if (string.IsNullOrEmpty(exe))
            {
                return false;
            }

            using RegistryKey? classes = Registry.CurrentUser.CreateSubKey(@"Software\Classes");
            if (classes is null)
            {
                return false;
            }

            using RegistryKey? scheme = classes.CreateSubKey(Scheme);
            if (scheme is null)
            {
                return false;
            }

            scheme.SetValue(string.Empty, "URL:Zode Protocol");
            scheme.SetValue("URL Protocol", string.Empty);

            using RegistryKey? command = scheme.CreateSubKey(@"shell\open\command");
            command?.SetValue(string.Empty, $"\"{exe}\" \"%1\"");

            Log.Info("protocol", $"registered the '{Scheme}://' protocol for the current user.");
            return true;
        }
        catch (Exception ex)
        {
            Log.Warn("protocol", $"could not register the protocol: {ex.Message}");
            return false;
        }
    }
}
