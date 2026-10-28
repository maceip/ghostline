// ShellApplication.cs — the composition root of the Zode Windows shell.

using Zode.Shell.Attachments;
using Zode.Shell.Bridge;
using Zode.Shell.Diagnostics;
using Zode.Shell.Haptics;
using Zode.Shell.Native;
using Zode.Shell.Platform;
using Zode.Shell.Web;
using Zode.Shell.Windowing;

namespace Zode.Shell;

internal sealed class ShellApplication : IDisposable
{
    private readonly ShellWindow _window;
    private readonly UiDispatcher _dispatcher;
    private readonly WebViewHost _webView;
    private readonly BridgeDispatcher _bridge;
    private readonly HapticService _haptics;
    private readonly NotificationService _notifications;
    private readonly JournalService _journal;
    private readonly SearchService _search;
    private readonly JumpListService _jumpList;
    private readonly IntentService _intents;
    private readonly ProtocolActivation _protocol;
    private readonly SingleInstanceGuard _guard;

    private Uri? _pendingDeepLink;
    private bool _disposed;

    public ShellApplication(IReadOnlyList<string> args, SingleInstanceGuard guard)
    {
        _guard = guard;

        // Contract §9: the AUMID and the Start Menu shortcut are what make
        // notifications work for an unpackaged app.
        AppIdentity.Register();

        _window = new ShellWindow();
        _dispatcher = new UiDispatcher(_window.Handle);

        // The WebView2 environment is created asynchronously; the controller
        // MUST be created on the thread that owns the window and its message
        // pump, so the continuations are marshalled back to the UI thread.
        SynchronizationContext.SetSynchronizationContext(_dispatcher);
        _window.DispatchRequested += (_, _) => _dispatcher.Drain();

        _webView = new WebViewHost(_window.Handle, OnFilesDropped);
        _haptics = new HapticService(HapticLibrary.Load());
        _notifications = new NotificationService();
        _journal = new JournalService();
        _search = new SearchService();
        _intents = new IntentService(_webView);
        _protocol = new ProtocolActivation(_webView, _intents);
        _jumpList = new JumpListService();

        _bridge = new BridgeDispatcher(
            _haptics,
            new FilePicker(_window.Handle),
            _notifications,
            _intents,
            _journal,
            _search,
            _window);

        _webView.Dispatcher = _bridge;

        _window.ClientSizeChanged += OnClientSizeChanged;
        _webView.PageReady += OnPageReady;
        _guard.CommandLineReceived += OnForwardedCommandLine;

        _pendingDeepLink = ProtocolActivation.FindDeepLink(args);
    }

    public void Run()
    {
        _window.Show();
        _ = InitializeWebViewAsync();
        _jumpList.EnsureCustomTask();
        NativeMethods.RunMessageLoop();
    }

    private async Task InitializeWebViewAsync()
    {
        await _webView.InitializeAsync().ConfigureAwait(true);
    }

    private void OnClientSizeChanged(object? sender, EventArgs e) => _webView.ApplyBounds();

    private void OnPageReady(object? sender, EventArgs e)
    {
        if (_pendingDeepLink is null)
        {
            return;
        }

        Uri deepLink = _pendingDeepLink;
        _pendingDeepLink = null;
        _protocol.Handle(deepLink);
    }

    private void OnForwardedCommandLine(IReadOnlyList<string> args)
    {
        // Another instance forwarded its command line (deep link activation).
        _dispatcher.Post(_ =>
        {
            Uri? uri = ProtocolActivation.FindDeepLink(args);
            if (uri is not null)
            {
                _protocol.Handle(uri);
            }
        }, null);
    }

    /// <summary>
    /// A file was dropped anywhere on the window (contract §8).  Every file
    /// becomes an "attachment" event; the shell also surfaces them natively
    /// (toast + jump list + search index) so that they are never lost.
    /// </summary>
    private void OnFilesDropped(IReadOnlyList<string> files)
    {
        if (files.Count == 0)
        {
            return;
        }

        var names = new List<string>(files.Count);
        foreach (string file in files)
        {
            Attachment attachment = AttachmentFactory.FromPath(file, AttachmentSources.Drop);
            names.Add(attachment.Name);
            _webView.Emit(EventNames.Attachment, attachment.ToJson());
            _search.AddFile(file, attachment.Name);
            _jumpList.AddRecentAttachment(file);
        }

        try
        {
            _notifications.Post(
                "Zode",
                names.Count == 1 ? names[0] : $"{names.Count} files attached",
                null,
                "normal");
        }
        catch (Exception ex)
        {
            Log.Warn("attachments", $"could not post the attachment toast: {ex.Message}");
        }

        // The "attach" haptic program confirms the drop (contract §7/§8).
        try
        {
            _haptics.Play("drop", loop: false);
        }
        catch (Exception ex)
        {
            Log.Warn("haptics", $"could not play the drop haptic: {ex.Message}");
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _guard.CommandLineReceived -= OnForwardedCommandLine;
        _webView.Dispose();
        _haptics.Dispose();
        _window.Dispose();
    }
}
