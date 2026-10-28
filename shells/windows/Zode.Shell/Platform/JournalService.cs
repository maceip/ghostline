// Platform/JournalService.cs — the local activity log (contract §11).
//
// Windows has no system journal equivalent to the macOS Journaling
// Suggestions framework.  The contract therefore requires `journal.write` to
// resolve successfully while writing into a local activity log:
//     %LOCALAPPDATA%\Zode\journal.jsonl   (one JSON object per line)

using System.Text;
using System.Text.Json.Nodes;
using Zode.Shell.Bridge;
using Zode.Shell.Diagnostics;

namespace Zode.Shell.Platform;

internal sealed class JournalService
{
    private readonly object _sync = new();

    public static string JournalPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Zode",
        "journal.jsonl");

    /// <summary>Appends an entry to the activity log.</summary>
    public void Write(string title, string body, string? date)
    {
        var entry = new JsonObject
        {
            ["date"] = string.IsNullOrWhiteSpace(date) ? DateTimeOffset.UtcNow.ToString("o") : date,
            ["title"] = title,
            ["body"] = body,
            ["source"] = "zode.shell",
        };

        try
        {
            lock (_sync)
            {
                string path = JournalPath;
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                File.AppendAllText(path, entry.ToJsonString() + Environment.NewLine, Encoding.UTF8);
            }
        }
        catch (Exception ex)
        {
            Log.Error("journal", ex);
            throw new BridgeException(ErrorCodes.Internal, $"The journal entry could not be written: {ex.Message}");
        }
    }

    /// <summary>Reads the most recent entries (used by the in-app journal view).</summary>
    public IReadOnlyList<JsonObject> ReadRecent(int maxEntries = 50)
    {
        try
        {
            string path = JournalPath;
            if (!File.Exists(path))
            {
                return Array.Empty<JsonObject>();
            }

            var lines = File.ReadAllLines(path);
            var result = new List<JsonObject>();
            for (int i = lines.Length - 1; i >= 0 && result.Count < maxEntries; i--)
            {
                if (JsonNode.Parse(lines[i]) is JsonObject obj)
                {
                    result.Add(obj);
                }
            }

            return result;
        }
        catch (Exception ex)
        {
            Log.Error("journal", ex);
            return Array.Empty<JsonObject>();
        }
    }
}
