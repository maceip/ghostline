// Bridge/BridgeEventSink.cs — how native services push events to the page.

using System.Text.Json.Nodes;

namespace Zode.Shell.Bridge;

/// <summary>
/// Implemented by the WebView2 host: native services raise events through it
/// and the payload is delivered with window.__zodeNative__ (contract §1.1).
/// </summary>
internal interface IBridgeEventSink
{
    void Emit(string eventName, JsonNode? payload);
}
