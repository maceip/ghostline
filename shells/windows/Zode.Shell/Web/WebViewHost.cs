// Web/WebViewHost.cs — hosts the Zune web app in the Edge WebView2 runtime.
//
//   * the bundled app is served from the virtual host https://app.zode.local
//     (contract §1.3) so that the origin is stable and CORS-clean;
//   * ZODE_DEV_URL overrides the base URL for development;
//   * the page talks to the shell with window.chrome.webview.postMessage and
//     receives native events through window.__zodeNative__ (contract §1.1).

using System.Drawing;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Zode.Shell.Attachments;
using Zode.Shell.Bridge;
using Zode.Shell.Diagnostics;
using Zode.Shell.Native;
using Zode.Shell.Windowing;

namespace Zode.Shell.Web;

internal sealed class WebViewHost : IBridgeEventSink, IDisposable
{
    /// <summary>Virtual host name of the bundled web app (contract §1.3).</summary>
    public const string VirtualHostName = "app.zode.local";

    private readonly IntPtr _parentWindow;
    private readonly Func<IntPtr> _parentHandle;
    private readonly Action<IReadOnlyList<string>> _onFilesDropped;

    private CoreWebView2Controller? _controller;
    private CoreWebView2? _core;
    private WindowSubclass? _childSubclass;
    private NativeMethods.WindowProc? _childProc;
    private bool _disposed;

    public WebViewHost(IntPtr parentWindow, Action<IReadOnlyList<string>> onFilesDropped)
    {
        _parentWindow = parentWindow;
        _parentHandle = () => parentWindow;
        _onFilesDropped = onFilesDropped;
    }

    /// <summary>The request router; set once the services exist.</summary>
    public BridgeDispatcher? Dispatcher { get; set; }

    /// <summary>True when the controller is up and the page can be talked to.</summary>
    public bool IsReady => _core is not null;

    /// <summary>Raised once the page finished loading (the deep link is then delivered).</summary>
    public event EventHandler? PageReady;

    public async Task InitializeAsync()
    {
        try
        {
            string userDataFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Zode", "WebView2");
            Directory.CreateDirectory(userDataFolder);

            CoreWebView2EnvironmentOptions options = new CoreWebView2EnvironmentOptions
            {
                // AdditionalBrowserArguments lives on the *environment*
                // options, not on CoreWebView2Settings.
                AdditionalBrowserArguments =
                    "--enable-features=msWebView2AutoDetectThemeEnabled",
            };

            CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(
                browserExecutableFolder: null,
                userDataFolder: userDataFolder,
                options: options);

            CoreWebView2Controller controller =
                await environment.CreateCoreWebView2ControllerAsync(_parentWindow);
            _controller = controller;
            _core = controller.CoreWebView2;

            ConfigureCore(_core);
            ApplyBounds();
            AttachChildWindow();

            string startUrl = ResolveStartUrl();
            Log.Info("webview", $"navigating to {startUrl}");
            _core.Navigate(startUrl);
        }
        catch (Exception ex)
        {
            Log.Error("webview", ex);
        }
    }

    private void ConfigureCore(CoreWebView2 core)
    {
        core.Settings.IsWebMessageEnabled = true;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreDefaultContextMenusEnabled = true;
        core.Settings.AreDevToolsEnabled = IsDebugBuild;
        core.Settings.IsZoomControlEnabled = true;

        // The shell paints no background (contract §5.2): the WebView2
        // backdrop is the Zode ink colour so that there is no white flash
        // before the web app paints itself.
        try
        {
            _controller!.DefaultBackgroundColor = Color.FromArgb(0x14, 0x14, 0x14);
        }
        catch (Exception ex)
        {
            Log.Warn("webview", $"could not set the default background colour: {ex.Message}");
        }

        // Contract §1.3: the bundled assets live on a virtual host.  The
        // access kind is DENY_CORS (the frozen contract); set
        // ZODE_VHOST_ACCESS=allow to relax it while debugging.
        CoreWebView2HostResourceAccessKind accessKind = ResolveAccessKind();
        string webRoot = ResolveWebRoot();
        try
        {
            // CoreWebView2.SetVirtualHostNameToFolderMapping is the
            // ICoreWebView2Environment3 mapping of the contract, surfaced on
            // the controller's CoreWebView2.
            core.SetVirtualHostNameToFolderMapping(VirtualHostName, webRoot, accessKind);
            Log.Info("webview", $"mapped https://{VirtualHostName}/ -> {webRoot} ({accessKind})");
        }
        catch (Exception ex)
        {
            Log.Error("webview", $"SetVirtualHostNameToFolderMapping failed: {ex.Message}");
        }

        core.WebMessageReceived += OnWebMessageReceived;
        core.NewWindowRequested += OnNewWindowRequested;
        core.NavigationStarting += OnNavigationStarting;
        core.NavigationCompleted += OnNavigationCompleted;
        // No DragStarting handler here on purpose: that event only exists on
        // ICoreWebView2CompositionController5, which is the *visual* hosting
        // mode.  This shell hosts the webview in a child window, so the event
        // would never fire.  File drops are handled by the OLE IDropTarget
        // registered on the window instead (see FileDropTarget).

        try
        {
            // We handle external drops ourselves so that a file dropped
            // anywhere on the window becomes an "attachment" event.
            // AllowExternalDrop lives on the *controller*, not on the
            // CoreWebView2 itself.
            if (_controller is not null)
            {
                _controller.AllowExternalDrop = false;
            }
        }
        catch (Exception ex)
        {
            Log.Warn("webview", $"AllowExternalDrop could not be configured: {ex.Message}");
        }
    }

    private static bool IsDebugBuild =>
#if DEBUG
        true;
#else
        false;
#endif

    private static CoreWebView2HostResourceAccessKind ResolveAccessKind()
    {
        string? value = Environment.GetEnvironmentVariable("ZODE_VHOST_ACCESS");
        if (string.Equals(value, "deny_cors", StringComparison.OrdinalIgnoreCase))
        {
            return CoreWebView2HostResourceAccessKind.DenyCors;
        }

        // Allow ES module script and stylesheet sub-resources from the virtual host.
        return CoreWebView2HostResourceAccessKind.Allow;
    }

    private static string ResolveWebRoot()
    {
        string root = Path.Combine(AppContext.BaseDirectory, "web");
        if (!Directory.Exists(root))
        {
            Directory.CreateDirectory(root);
            string placeholder = Path.Combine(root, "index.html");
            if (!File.Exists(placeholder))
            {
                File.WriteAllText(placeholder,
                    "<!doctype html><meta charset=\"utf-8\"><title>Zode</title>" +
                    "<body style=\"background:#141414;color:#f4f2ef;font:15px 'Segoe UI',sans-serif;padding:40px\">" +
                    "<h1>Zode</h1><p>The web app is missing. Run <code>build.ps1</code> to copy it into " +
                    "<code>web/</code>, or set <code>ZODE_DEV_URL</code> to a dev server.</p></body>");
            }

            Log.Warn("webview", $"the web app folder '{root}' was missing and has been created empty.");
        }

        return root;
    }

    private string ResolveStartUrl()
    {
        string? devUrl = Environment.GetEnvironmentVariable("ZODE_DEV_URL");
        if (string.IsNullOrWhiteSpace(devUrl))
        {
            devUrl = ReadDevUrlFromSettings();
        }

        if (!string.IsNullOrWhiteSpace(devUrl))
        {
            Log.Info("webview", $"using the development URL {devUrl}");
            return devUrl;
        }

        return $"https://{VirtualHostName}/index.html";
    }

    private static string? ReadDevUrlFromSettings()
    {
        try
        {
            string path = Path.Combine(AppContext.BaseDirectory, "appsettings.json");
            if (!File.Exists(path))
            {
                return null;
            }

            if (JsonNode.Parse(File.ReadAllText(path)) is JsonObject root &&
                root["ZodeDevURL"] is JsonNode node)
            {
                return node.GetValue<string>();
            }
        }
        catch (Exception ex)
        {
            Log.Warn("webview", $"could not read appsettings.json: {ex.Message}");
        }

        return null;
    }

    // ------------------------------------------------------------------
    // Sizing
    // ------------------------------------------------------------------
    /// <summary>Resizes the WebView2 child to the client area of the shell window.</summary>
    public void ApplyBounds()
    {
        CoreWebView2Controller? controller = _controller;
        if (controller is null)
        {
            return;
        }

        if (!NativeMethods.GetClientRect(_parentWindow, out NativeMethods.RECT rect))
        {
            return;
        }

        try
        {
            controller.Bounds = new Rectangle(0, 0, Math.Max(0, rect.Width), Math.Max(0, rect.Height));
        }
        catch (Exception ex)
        {
            Log.Warn("webview", $"could not resize the WebView2 controller: {ex.Message}");
        }
    }

    /// <summary>
    /// Finds the WebView2 renderer child window and subclasses it so that the
    /// invisible resize border keeps working while the pointer is over the web
    /// content (contract §5).
    /// </summary>
    private void AttachChildWindow()
    {
        IntPtr child = FindWebViewChild();
        if (child == IntPtr.Zero)
        {
            Log.Warn("webview", "the WebView2 child window could not be found; the resize border may be inactive.");
            return;
        }

        _childProc = ChildWindowProc;
        _childSubclass = WindowSubclass.Attach(child, _childProc!);
        Log.Info("webview", "subclassed the WebView2 child for WM_NCHITTEST.");
    }

    private IntPtr FindWebViewChild()
    {
        IntPtr found = IntPtr.Zero;
        NativeMethods.EnumChildWindows(_parentWindow, (hwnd, _) =>
        {
            var buffer = new StringBuilder(256);
            NativeMethods.GetClassNameW(hwnd, buffer, buffer.Capacity);
            string className = buffer.ToString();
            if (className.StartsWith("Chrome_WidgetWin_0", StringComparison.Ordinal))
            {
                found = hwnd;
                return false;
            }

            return true;
        }, IntPtr.Zero);

        return found;
    }

    private IntPtr ChildWindowProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        if (msg == WindowConstants.WM_NCHITTEST)
        {
            // The drag strip stays HTCLIENT so the page can raise the
            // window.dragStart / dblclick events of contract §3/§5.
            return (IntPtr)ShellWindow.HitTestScreen(hwnd, lParam, captionForStrip: false);
        }

        return _childSubclass?.CallOriginal(hwnd, msg, wParam, lParam) ?? IntPtr.Zero;
    }

    // ------------------------------------------------------------------
    // Bridge
    // ------------------------------------------------------------------
    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            string raw = e.TryGetWebMessageAsString();
            BridgeRequest? request = BridgeRequest.Parse(raw);
            if (request is null)
            {
                Log.Warn("bridge", "a message that is not a contract envelope was ignored.");
                return;
            }

            BridgeDispatcher? dispatcher = Dispatcher;
            if (dispatcher is null)
            {
                Send(BridgeResponse.Failure(request.Id, ErrorCodes.Internal, "The shell is not ready yet."));
                return;
            }

            JsonObject response = dispatcher.Dispatch(request);
            Send(response);
        }
        catch (Exception ex)
        {
            Log.Error("bridge", ex);
        }
    }

    private void Send(JsonObject message)
    {
        CoreWebView2? core = _core;
        if (core is null)
        {
            return;
        }

        try
        {
            string json = message.ToJsonString();
            core.ExecuteScriptAsync($"window.__zodeNative__ && window.__zodeNative__({json});");
        }
        catch (Exception ex)
        {
            Log.Error("bridge", ex);
        }
    }

    /// <summary>Implements IBridgeEventSink: pushes a native event to the page.</summary>
    public void Emit(string eventName, JsonNode? payload)
    {
        Send(BridgeEvent.Create(eventName, payload));
    }

    // ------------------------------------------------------------------
    // Navigation / windows
    // ------------------------------------------------------------------
    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        OpenInSystemBrowser(e.Uri);
    }

    private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        string url = e.Uri;
        if (IsInternalUrl(url))
        {
            return;
        }

        // Everything that is not the bundled app (or the dev server) opens in
        // the user's browser instead of replacing the shell.
        e.Cancel = true;
        OpenInSystemBrowser(url);
    }

    private bool IsInternalUrl(string url)
    {
        if (string.IsNullOrEmpty(url))
        {
            return true;
        }

        if (url.StartsWith("about:", StringComparison.OrdinalIgnoreCase) ||
            url.StartsWith("data:", StringComparison.OrdinalIgnoreCase) ||
            url.StartsWith("javascript:", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        if (Uri.TryCreate(url, UriKind.Absolute, out Uri? uri))
        {
            if (string.Equals(uri.Host, VirtualHostName, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            string? devUrl = Environment.GetEnvironmentVariable("ZODE_DEV_URL");
            if (!string.IsNullOrWhiteSpace(devUrl) &&
                Uri.TryCreate(devUrl, UriKind.Absolute, out Uri? devUri) &&
                string.Equals(uri.Host, devUri.Host, StringComparison.OrdinalIgnoreCase) &&
                uri.Port == devUri.Port)
            {
                return true;
            }
        }

        return false;
    }

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        try
        {
            PageReady?.Invoke(this, EventArgs.Empty);
        }
        catch (Exception ex)
        {
            Log.Error("webview", ex);
        }
    }

    private void OpenInSystemBrowser(string url)
    {
        try
        {
            using System.Diagnostics.Process process = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = url,
                UseShellExecute = true,
            });
        }
        catch (Exception ex)
        {
            Log.Warn("webview", $"could not open '{url}' in the browser: {ex.Message}");
        }
    }

    // ------------------------------------------------------------------
    // Drag & drop (contract §8)
    // ------------------------------------------------------------------
    // The drop itself is handled by the OLE IDropTarget that is registered
    // on the top level window, so a file dropped anywhere on the window —
    // on the chrome, on the rail, on the page — becomes an "attachment"
    // event.  See Attachments/FileDropTarget.cs.

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _childSubclass?.Dispose();
        _childSubclass = null;
        _controller?.Close();
        _controller = null;
        _core = null;
    }
}
