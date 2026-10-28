// Attachments/Attachment.cs — the Attachment shape of contract §2.1.

using System.Text.Json.Nodes;

namespace Zode.Shell.Attachments;

/// <summary>Where an attachment came from (contract §2.1 / §8).</summary>
internal static class AttachmentSources
{
    public const string Dock = "dock";
    public const string Drop = "drop";
    public const string Picker = "picker";
    public const string Share = "share";
    public const string Intent = "intent";
}

/// <summary>One attachment handed to the web app.</summary>
internal sealed class Attachment
{
    public required string Id { get; init; }

    public required string Name { get; init; }

    public required string Path { get; init; }

    public required string MimeType { get; init; }

    public required long Size { get; init; }

    public required string Source { get; init; }

    public JsonObject ToJson() => new()
    {
        ["id"] = Id,
        ["name"] = Name,
        ["path"] = Path,
        ["mimeType"] = MimeType,
        ["size"] = Size,
        ["source"] = Source,
    };
}

/// <summary>Per-session identifiers for attachments (contract §2.1: "stable per-session id").</summary>
internal static class AttachmentIds
{
    private static readonly string Session = Guid.NewGuid().ToString("N")[..8];
    private static int _counter;

    public static string Next() => $"{Session}-{Interlocked.Increment(ref _counter)}";
}
