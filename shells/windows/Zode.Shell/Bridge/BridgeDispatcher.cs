// Bridge/BridgeDispatcher.cs — the router for every request type of contract §3.
//
// The dispatcher is deliberately SYNCHRONOUS: it runs on the UI thread inside
// the WebMessageReceived handler, which is what makes `window.dragStart` work
// (the OS drag loop must start from the thread that owns the window).

using System.Diagnostics;
using System.Text.Json.Nodes;
using Zode.Shell.Attachments;
using Zode.Shell.Diagnostics;
using Zode.Shell.Haptics;
using Zode.Shell.Platform;
using Zode.Shell.Windowing;

namespace Zode.Shell.Bridge;

internal sealed class BridgeDispatcher
{
    private readonly HapticService _haptics;
    private readonly FilePicker _picker;
    private readonly NotificationService _notifications;
    private readonly IntentService _intents;
    private readonly JournalService _journal;
    private readonly SearchService _search;
    private readonly ShellWindow _window;

    public BridgeDispatcher(
        HapticService haptics,
        FilePicker picker,
        NotificationService notifications,
        IntentService intents,
        JournalService journal,
        SearchService search,
        ShellWindow window)
    {
        _haptics = haptics;
        _picker = picker;
        _notifications = notifications;
        _intents = intents;
        _journal = journal;
        _search = search;
        _window = window;
    }

    /// <summary>
    /// The capability flags of contract §2.
    ///
    ///   haptics  false — a desktop has no haptic engine, the waveforms are
    ///                   rendered as audio (contract §7).
    ///   journal  false — Windows has no system journal; `journal.write`
    ///                   resolves but only reaches the local activity log
    ///                   (contract §11).
    ///   search   false — the App Content Search integration needs package
    ///                   identity (contract §10); the shell falls back to the
    ///                   `zode://search?q=…` protocol handler.
    /// </summary>
    public JsonObject DescribeCapabilities() => new()
    {
        ["haptics"] = _haptics.HasHapticEngine,
        ["attachments"] = true,
        ["notifications"] = _notifications.IsSupported,
        ["intents"] = true,
        ["journal"] = false,
        ["search"] = false,
        ["windowControl"] = true,
    };

    public JsonObject Dispatch(BridgeRequest request)
    {
        try
        {
            return request.Type switch
            {
                RequestTypes.HapticPlay => HapticPlay(request),
                RequestTypes.HapticStop => HapticStop(request),
                RequestTypes.AttachPick => AttachPick(request),
                RequestTypes.NotifyPost => NotifyPost(request),
                RequestTypes.IntentPerform => IntentPerform(request),
                RequestTypes.JournalWrite => JournalWrite(request),
                RequestTypes.SearchQuery => SearchQuery(request),
                RequestTypes.WindowDragStart => WindowDragStart(request),
                RequestTypes.WindowToggleFill => WindowToggleFill(request),
                RequestTypes.WindowSetFullScreen => WindowSetFullScreen(request),
                RequestTypes.WindowIsFullScreen => WindowIsFullScreen(request),
                RequestTypes.AppOpenPath => AppOpenPath(request),
                RequestTypes.AppInfo => AppInfo(request),
                _ => BridgeResponse.Failure(request.Id, ErrorCodes.Unsupported,
                    $"Unknown request type '{request.Type}'."),
            };
        }
        catch (BridgeException ex)
        {
            return BridgeResponse.Failure(request.Id, ex.Code, ex.Message);
        }
        catch (UnauthorizedAccessException ex)
        {
            return BridgeResponse.Failure(request.Id, ErrorCodes.Denied, ex.Message);
        }
        catch (FileNotFoundException ex)
        {
            return BridgeResponse.Failure(request.Id, ErrorCodes.NotFound, ex.Message);
        }
        catch (OperationCanceledException ex)
        {
            return BridgeResponse.Failure(request.Id, ErrorCodes.Cancelled, ex.Message);
        }
        catch (Exception ex)
        {
            Log.Error("bridge", ex);
            return BridgeResponse.Failure(request.Id, ErrorCodes.Internal, ex.Message);
        }
    }

    // ---- haptics (contract §7) -----------------------------------------
    private JsonObject HapticPlay(BridgeRequest request)
    {
        string program = Payload.GetString(request.Payload, "program")
            ?? throw new BridgeException(ErrorCodes.Invalid, "'program' is required.");
        bool loop = Payload.GetBool(request.Payload, "loop");

        _haptics.Play(program, loop);
        return BridgeResponse.Success(request.Id, new JsonObject());
    }

    private JsonObject HapticStop(BridgeRequest request)
    {
        string program = Payload.GetString(request.Payload, "program")
            ?? throw new BridgeException(ErrorCodes.Invalid, "'program' is required.");

        _haptics.Stop(program);
        return BridgeResponse.Success(request.Id, new JsonObject());
    }

    // ---- attachments (contract §8) --------------------------------------
    private JsonObject AttachPick(BridgeRequest request)
    {
        IReadOnlyList<Attachment> attachments = _picker.PickFiles();
        var array = new JsonArray();
        foreach (Attachment attachment in attachments)
        {
            array.Add(attachment.ToJson());
        }

        return BridgeResponse.Success(request.Id, new JsonObject
        {
            ["attachments"] = array,
        });
    }

    // ---- notifications (contract §9) ------------------------------------
    private JsonObject NotifyPost(BridgeRequest request)
    {
        string title = Payload.GetString(request.Payload, "title")
            ?? throw new BridgeException(ErrorCodes.Invalid, "'title' is required.");
        string body = Payload.GetString(request.Payload, "body")
            ?? throw new BridgeException(ErrorCodes.Invalid, "'body' is required.");
        string? id = Payload.GetString(request.Payload, "id");
        string urgency = Payload.GetString(request.Payload, "urgency") ?? "normal";

        _notifications.Post(title, body, id, urgency);
        return BridgeResponse.Success(request.Id, new JsonObject());
    }

    // ---- intents (contract §4) ------------------------------------------
    private JsonObject IntentPerform(BridgeRequest request)
    {
        string intent = Payload.GetString(request.Payload, "intent")
            ?? throw new BridgeException(ErrorCodes.Invalid, "'intent' is required.");
        JsonObject? payload = Payload.GetObject(request.Payload, "payload");

        JsonObject result = _intents.Perform(intent, payload);
        return BridgeResponse.Success(request.Id, result);
    }

    // ---- journal (contract §11) -----------------------------------------
    private JsonObject JournalWrite(BridgeRequest request)
    {
        string title = Payload.GetString(request.Payload, "title")
            ?? throw new BridgeException(ErrorCodes.Invalid, "'title' is required.");
        string body = Payload.GetString(request.Payload, "body") ?? string.Empty;
        string? date = Payload.GetString(request.Payload, "date");

        _journal.Write(title, body, date);
        return BridgeResponse.Success(request.Id, new JsonObject());
    }

    // ---- search (contract §10) ------------------------------------------
    private JsonObject SearchQuery(BridgeRequest request)
    {
        string query = Payload.GetString(request.Payload, "query") ?? string.Empty;
        JsonArray results = _search.Query(query);
        return BridgeResponse.Success(request.Id, new JsonObject
        {
            ["results"] = results,
        });
    }

    // ---- window control (contract §5) -----------------------------------
    private JsonObject WindowDragStart(BridgeRequest request)
    {
        // Contract §5.3: the page raises this from the drag strip; the shell
        // starts a native OS window drag.
        _window.BeginDrag();
        return BridgeResponse.Success(request.Id, new JsonObject());
    }

    private JsonObject WindowToggleFill(BridgeRequest request)
    {
        bool filling = _window.ToggleFillScreen();
        return BridgeResponse.Success(request.Id, new JsonObject
        {
            ["filling"] = filling,
        });
    }

    private JsonObject WindowSetFullScreen(BridgeRequest request)
    {
        bool fullScreen = Payload.GetBool(request.Payload, "fullScreen");
        _window.SetFullScreen(fullScreen);
        return BridgeResponse.Success(request.Id, new JsonObject());
    }

    private JsonObject WindowIsFullScreen(BridgeRequest request) =>
        BridgeResponse.Success(request.Id, new JsonObject
        {
            ["fullScreen"] = _window.IsFullScreen(),
        });

    // ---- misc ------------------------------------------------------------
    private JsonObject AppOpenPath(BridgeRequest request)
    {
        string path = Payload.GetString(request.Payload, "path")
            ?? throw new BridgeException(ErrorCodes.Invalid, "'path' is required.");

        if (!File.Exists(path) && !Directory.Exists(path))
        {
            throw new BridgeException(ErrorCodes.NotFound, $"'{path}' does not exist.");
        }

        try
        {
            using Process? process = Process.Start(new ProcessStartInfo
            {
                FileName = path,
                UseShellExecute = true,
            });
        }
        catch (Exception ex)
        {
            throw new BridgeException(ErrorCodes.Denied, $"'{path}' could not be opened: {ex.Message}");
        }

        return BridgeResponse.Success(request.Id, new JsonObject());
    }

    private JsonObject AppInfo(BridgeRequest request)
    {
        JsonObject info = SystemInfo.Describe();

        // The capability matrix is an addition to the §3 payload: the web
        // bridge merges it into window.zode.capabilities (bridge/zode.js →
        // refreshInfo), which lets the shell report the truth about the
        // machine it runs on (e.g. no toast support).
        info["capabilities"] = DescribeCapabilities();
        return BridgeResponse.Success(request.Id, info);
    }
}
