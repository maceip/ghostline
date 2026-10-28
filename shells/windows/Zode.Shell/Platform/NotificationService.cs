// Platform/NotificationService.cs — toasts via Windows.UI.Notifications.
//
// Contract §9.  Unpackaged apps need an AppUserModelID and a Start Menu
// shortcut (see AppIdentity) or the toast silently fails.
//
// Why the classic WinRT API and not Windows.AppNotifications: the latter
// lives in the Windows App SDK, which would add a package *and* a runtime
// install to a shell that deliberately depends on nothing but WebView2.  An
// unpackaged Win32 app shows a toast through its AUMID, and the activation
// comes back through the app's own `zode://` protocol — which the shell
// already registers and already understands (see ProtocolActivation).

using System.Text;
using Windows.Data.Xml.Dom;
using Windows.UI.Notifications;
using Zode.Shell.Bridge;
using Zode.Shell.Diagnostics;

namespace Zode.Shell.Platform;

internal sealed class NotificationService
{
    /// <summary>The host of the `zode://` URI a toast activation uses.</summary>
    public const string NotificationHost = "notification";

    public bool IsSupported { get; private set; }

    public NotificationService()
    {
        try
        {
            // The toast needs the AUMID and the Start Menu shortcut, both of
            // which AppIdentity registered before this was constructed.  The
            // call itself is what proves the platform can show a toast.
            ToastNotificationManager.CreateToastNotifier(AppIdentity.AppUserModelId);
            IsSupported = true;
        }
        catch (Exception ex)
        {
            Log.Warn("notify", $"toast notifications are not available: {ex.Message}");
            IsSupported = false;
        }
    }

    /// <summary>Shows a toast.  Urgency "critical" degrades to a normal toast for unpackaged apps.</summary>
    public void Post(string title, string body, string? id, string urgency)
    {
        if (!IsSupported)
        {
            throw new BridgeException(ErrorCodes.Unsupported, "Toast notifications are not available on this system.");
        }

        try
        {
            var document = new XmlDocument();
            document.LoadXml(BuildToastXml(title, body, urgency, id));

            var notifier = ToastNotificationManager.CreateToastNotifier(AppIdentity.AppUserModelId);
            notifier.Show(new ToastNotification(document));
        }
        catch (Exception ex)
        {
            Log.Error("notify", ex);
            throw new BridgeException(ErrorCodes.Internal, $"The notification could not be shown: {ex.Message}");
        }
    }

    private static string BuildToastXml(string title, string body, string urgency, string? id)
    {
        var sb = new StringBuilder();
        sb.Append("<toast");
        if (string.Equals(urgency, "critical", StringComparison.OrdinalIgnoreCase))
        {
            sb.Append(" scenario=\"urgent\"");
        }

        sb.Append("><visual><binding template=\"ToastGeneric\">");
        sb.Append("<text>").Append(Escape(title)).Append("</text>");
        sb.Append("<text>").Append(Escape(body)).Append("</text>");
        sb.Append("</binding></visual>");

        // The activation comes back as a protocol URI, so the toast carries
        // the notification id and the action the user picked.
        sb.Append("<actions><action content=\"Open Zode\" activationType=\"protocol\" arguments=\"");
        sb.Append(Escape($"{ProtocolActivation.Scheme}://{NotificationHost}?id={Uri.EscapeDataString(id ?? string.Empty)}&action=open"));
        sb.Append("\"/></actions>");

        sb.Append("</toast>");
        return sb.ToString();
    }

    private static string Escape(string value) =>
        value.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;");
}
