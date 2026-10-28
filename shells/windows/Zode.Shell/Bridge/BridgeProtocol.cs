// Bridge/BridgeProtocol.cs — the frozen message envelope (contract §1).
//
//   request  (JS -> native) { id, type, payload }
//   response (native -> JS) { id, ok, result }  |  { id, ok:false, error:{ code, message } }
//   event    (native -> JS) { type: "event", event, payload }

using System.Text.Json;
using System.Text.Json.Nodes;

namespace Zode.Shell.Bridge;

/// <summary>Every request type listed in contract §3.</summary>
internal static class RequestTypes
{
    public const string HapticPlay = "haptic.play";
    public const string HapticStop = "haptic.stop";
    public const string AttachPick = "attach.pick";
    public const string NotifyPost = "notify.post";
    public const string IntentPerform = "intent.perform";
    public const string JournalWrite = "journal.write";
    public const string SearchQuery = "search.query";
    public const string WindowDragStart = "window.dragStart";
    public const string WindowToggleFill = "window.toggleFill";
    public const string WindowSetFullScreen = "window.setFullScreen";
    public const string WindowIsFullScreen = "window.isFullScreen";
    public const string AppOpenPath = "app.openPath";
    public const string AppInfo = "app.info";
}

/// <summary>Unsolicited native events (contract §2.2).</summary>
internal static class EventNames
{
    public const string Attachment = "attachment";
    public const string NotificationAction = "notificationAction";
    public const string Intent = "intent";
    public const string Search = "search";
    public const string DeepLink = "deepLink";
}

/// <summary>Error codes allowed by contract §1.2.</summary>
internal static class ErrorCodes
{
    public const string Unsupported = "unsupported";
    public const string Invalid = "invalid";
    public const string Denied = "denied";
    public const string Cancelled = "cancelled";
    public const string NotFound = "notFound";
    public const string Internal = "internal";
}

/// <summary>A request that arrived from the page.</summary>
internal sealed class BridgeRequest
{
    public BridgeRequest(string id, string type, JsonNode? payload)
    {
        Id = id;
        Type = type;
        Payload = payload;
    }

    public string Id { get; }

    public string Type { get; }

    public JsonNode? Payload { get; }

    public static BridgeRequest? Parse(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return null;
        }

        try
        {
            if (JsonNode.Parse(json) is not JsonObject root)
            {
                return null;
            }

            string id = AsString(root["id"]) ?? string.Empty;
            string type = AsString(root["type"]) ?? string.Empty;
            JsonNode? payload = root["payload"];
            if (payload is not (JsonObject or JsonArray))
            {
                payload = null;
            }

            return new BridgeRequest(id, type, payload);
        }
        catch (JsonException)
        {
            return null;
        }
        catch (InvalidOperationException)
        {
            return null;
        }
    }

    internal static string? AsString(JsonNode? node)
    {
        if (node is null)
        {
            return null;
        }

        try
        {
            return node.GetValueKind() == JsonValueKind.String ? node.GetValue<string>() : node.ToJsonString();
        }
        catch (InvalidOperationException)
        {
            return null;
        }
    }
}

/// <summary>Helpers for reading the loosely typed payload of a request.</summary>
internal static class Payload
{
    public static string? GetString(JsonNode? payload, string name)
    {
        if (payload is not JsonObject obj)
        {
            return null;
        }

        return BridgeRequest.AsString(obj[name]);
    }

    public static bool GetBool(JsonNode? payload, string name, bool fallback = false)
    {
        if (payload is not JsonObject obj || !obj.TryGetPropertyValue(name, out JsonNode? node) || node is null)
        {
            return fallback;
        }

        try
        {
            return node.GetValueKind() switch
            {
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                JsonValueKind.String => bool.TryParse(node.GetValue<string>(), out bool parsed) && parsed,
                JsonValueKind.Number => node.GetValue<double>() != 0,
                _ => fallback,
            };
        }
        catch (Exception)
        {
            return fallback;
        }
    }

    public static JsonObject? GetObject(JsonNode? payload, string name)
    {
        if (payload is not JsonObject obj)
        {
            return null;
        }

        return obj[name] as JsonObject;
    }

    public static JsonArray? GetArray(JsonNode? payload, string name)
    {
        if (payload is not JsonObject obj)
        {
            return null;
        }

        return obj[name] as JsonArray;
    }
}

/// <summary>Builds the responses of contract §1.2.</summary>
internal static class BridgeResponse
{
    public static JsonObject Success(string id, JsonNode? result) => new()
    {
        ["id"] = id,
        ["ok"] = true,
        ["result"] = result ?? new JsonObject(),
    };

    public static JsonObject Failure(string id, string code, string message) => new()
    {
        ["id"] = id,
        ["ok"] = false,
        ["error"] = new JsonObject
        {
            ["code"] = code,
            ["message"] = message,
        },
    };
}

/// <summary>Builds the unsolicited events of contract §1.2.</summary>
internal static class BridgeEvent
{
    public static JsonObject Create(string name, JsonNode? payload) => new()
    {
        ["type"] = "event",
        ["event"] = name,
        ["payload"] = payload ?? new JsonObject(),
    };
}

/// <summary>An error that carries one of the contract error codes.</summary>
internal sealed class BridgeException : Exception
{
    public BridgeException(string code, string message) : base(message) => Code = code;

    public string Code { get; }
}
