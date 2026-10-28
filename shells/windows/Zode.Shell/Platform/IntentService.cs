// Platform/IntentService.cs — the cross-platform intents of contract §4.
//
// The names and payload shapes are fixed by the contract; each platform maps
// them onto its own mechanism.  On Windows they are triggered by
//   * `intent.perform` from the web app,
//   * an App Action (MSIX, requires package identity),
//   * a `zode://` protocol activation.
//
// The shell does not implement the intents itself: it forwards them to the web
// app (which owns the library and the player) and answers with an
// IntentResult (contract §2.1).

using System.Text.Json.Nodes;
using Zode.Shell.Bridge;
using Zode.Shell.Diagnostics;

namespace Zode.Shell.Platform;

internal sealed class IntentService
{
    // ---- the canonical intent names (contract §4) ----------------------
    public const string Search = "zode.search";
    public const string Play = "zode.play";
    public const string Pause = "zode.pause";
    public const string Next = "zode.next";
    public const string Previous = "zode.previous";
    public const string AgentNewTask = "zode.agent.newTask";
    public const string AgentStop = "zode.agent.stop";
    public const string Attach = "zode.attach";
    public const string Show = "zode.show";

    public static readonly IReadOnlyList<string> All = new[]
    {
        Search, Play, Pause, Next, Previous, AgentNewTask, AgentStop, Attach, Show,
    };

    private readonly IBridgeEventSink _sink;

    public IntentService(IBridgeEventSink sink) => _sink = sink;

    /// <summary>Runs an intent inside the app and resolves an IntentResult.</summary>
    public JsonObject Perform(string intent, JsonObject? payload)
    {
        if (!All.Contains(intent, StringComparer.Ordinal))
        {
            // Contract §12: unknown capabilities must resolve with
            // { ok:false, error:{ code:"unsupported" } } instead of hanging.
            throw new BridgeException(ErrorCodes.Unsupported, $"Unknown intent '{intent}'.");
        }

        var forwarded = new JsonObject
        {
            ["intent"] = intent,
            ["payload"] = payload ?? new JsonObject(),
        };

        _sink.Emit(EventNames.Intent, forwarded);

        return new JsonObject
        {
            ["ok"] = true,
            ["value"] = new JsonObject
            {
                ["intent"] = intent,
                ["forwarded"] = true,
            },
            ["message"] = $"Intent '{intent}' was delivered to the app.",
        };
    }

    /// <summary>Raises an intent that was invoked from outside the app.</summary>
    public void RaiseExternal(string intent, JsonObject? payload)
    {
        if (!All.Contains(intent, StringComparer.Ordinal))
        {
            Log.Warn("intent", $"ignoring unknown external intent '{intent}'.");
            return;
        }

        _sink.Emit(EventNames.Intent, new JsonObject
        {
            ["intent"] = intent,
            ["payload"] = payload ?? new JsonObject(),
            ["external"] = true,
        });
    }
}
